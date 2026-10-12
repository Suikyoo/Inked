import { existsSync } from 'node:fs';
import { deleteCredential, loadCredential, saveCredential, type Credential } from './credential';
import { CredentialStale, ToolError } from './errors';
import { credentialPath } from './home';
import { toToolMessage } from './messages';
import { Ops } from './ops';
import { ConfigError, loadConfig, resolvePolicy, type ParsedConfig, type Policy } from './policy';
import { Session } from './session';
import { listAllVaults, VaultModel, type VaultInfo } from './vault-model';

export type RuntimeState =
  | { kind: 'signed-out'; reason?: string; retry?: boolean }
  | { kind: 'config-error'; session: Session; message: string }
  | { kind: 'ready'; session: Session; policy: Policy; ops: Ops; vaults: VaultInfo[] };

export const STALE_REASON = 'Your Inked password changed, so the saved sign-in stopped working. Sign in again.';
export const NOT_SIGNED_IN = 'Not signed in to Inked. Call sign_in.';
const DAMAGED_REASON = 'The saved Inked sign-in could not be read. Sign in again.';
const STALE_TOOL = 'Your Inked password changed, so the saved sign-in stopped working. Call sign_in.';

/** The server's live state. Every change goes through here, one at a time, and is announced to subscribers. */
export class Runtime {
  private current: RuntimeState = { kind: 'signed-out' };
  private queue: Promise<unknown> = Promise.resolve();
  private readonly listeners = new Set<(s: RuntimeState) => void>();

  constructor(private readonly deps: { fetch?: typeof fetch; configFile?: string } = {}) {}

  get state(): RuntimeState {
    return this.current;
  }

  /** The config file given with --config, or undefined for the default location. */
  get configFile(): string | undefined {
    return this.deps.configFile;
  }

  subscribe(fn: (s: RuntimeState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(next: RuntimeState): void {
    this.current = next;
    for (const fn of this.listeners) fn(next);
  }

  /** Runs state changes one after another, so a reload never interleaves with a sign-in. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The state a signed-in session leads to. Throws for anything but a config problem. */
  private async build(session: Session, prev?: Ops): Promise<RuntimeState> {
    let cfg: ParsedConfig;
    try {
      cfg = loadConfig(this.deps.configFile);
    } catch (e) {
      if (e instanceof ConfigError) return { kind: 'config-error', session, message: e.message };
      throw e;
    }
    const vaults = await listAllVaults(session);
    let policy: Policy;
    try {
      policy = resolvePolicy(cfg, vaults);
    } catch (e) {
      if (e instanceof ConfigError) return { kind: 'config-error', session, message: e.message };
      throw e;
    }
    // Keep the write budget across a reload, so a reload never resets the rate limit.
    const limiter = prev && prev.policy.writesPerMinute === policy.writesPerMinute ? prev.limiter : undefined;
    return { kind: 'ready', session, policy, ops: new Ops(session, new VaultModel(session, policy), policy, limiter), vaults };
  }

  private sessionOf(s: RuntimeState): Session | null {
    return s.kind === 'signed-out' ? null : s.session;
  }

  /** Never waits more than a few seconds: a hung logout must not keep the key in memory. */
  private async closeSession(session: Session | null): Promise<void> {
    if (!session) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      session.close().catch(() => undefined),
      new Promise<void>((r) => {
        timer = setTimeout(r, 3000);
      }),
    ]);
    clearTimeout(timer);
  }

  /** Signs in with the saved credential. Never throws: every failure becomes a signed-out reason. */
  start(): Promise<void> {
    return this.exclusive(async () => {
      await this.closeSession(this.sessionOf(this.current));
      let cred: Credential;
      try {
        cred = loadCredential();
      } catch {
        return this.set({ kind: 'signed-out', ...(existsSync(credentialPath()) ? { reason: DAMAGED_REASON } : {}) });
      }
      const session = new Session(cred, { fetch: this.deps.fetch });
      try {
        await session.start();
        this.set(await this.build(session));
      } catch (e) {
        await this.closeSession(session);
        if (e instanceof CredentialStale) return this.set({ kind: 'signed-out', reason: STALE_REASON });
        this.set({ kind: 'signed-out', reason: toToolMessage(e), retry: true });
      }
    });
  }

  /** Switches to a new credential. Throws, and changes nothing, if it cannot sign in. */
  signIn(cred: Credential): Promise<void> {
    return this.exclusive(async () => {
      const session = new Session(cred, { fetch: this.deps.fetch });
      let next: RuntimeState;
      try {
        await session.start();
        next = await this.build(session);
      } catch (e) {
        await this.closeSession(session);
        throw e;
      }
      saveCredential(cred);
      const old = this.sessionOf(this.current);
      this.set(next);
      await this.closeSession(old);
    });
  }

  /** Re-reads the config and the vault list. */
  reload(): Promise<void> {
    return this.exclusive(async () => {
      const s = this.current;
      if (s.kind === 'signed-out') throw new ToolError('signed_out', NOT_SIGNED_IN);
      this.set(await this.build(s.session, s.kind === 'ready' ? s.ops : undefined));
    });
  }

  signOut(): Promise<void> {
    return this.exclusive(async () => {
      const old = this.sessionOf(this.current);
      deleteCredential();
      this.set({ kind: 'signed-out' });
      await this.closeSession(old);
    });
  }

  close(): Promise<void> {
    return this.exclusive(() => this.closeSession(this.sessionOf(this.current)));
  }

  ops(): Ops {
    const s = this.current;
    if (s.kind === 'ready') return s.ops;
    if (s.kind === 'config-error') {
      throw new ToolError('denied', `The access settings are invalid: ${s.message}. Use change_config to fix them.`);
    }
    throw new ToolError('signed_out', NOT_SIGNED_IN);
  }

  session(): Session {
    const s = this.sessionOf(this.current);
    if (!s) throw new ToolError('signed_out', NOT_SIGNED_IN);
    return s;
  }

  /** Runs a tool body. A credential that goes stale mid-session signs the server out instead of failing on every call. */
  async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof CredentialStale)) throw e;
      await this.exclusive(async () => {
        const old = this.sessionOf(this.current);
        this.set({ kind: 'signed-out', reason: STALE_REASON });
        await this.closeSession(old);
      });
      throw new ToolError('signed_out', STALE_TOOL);
    }
  }
}
