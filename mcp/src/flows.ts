import { nextVaultColor } from 'inked-core';
import { PageError, type ApprovalPage, type ApprovalServer, type PageOutcome } from './approval';
import type { Audit } from './audit';
import { readConfigFile, toConfigFile, vaultRef, viewOf, writeConfigFile, type ConfigView, type NamedVault } from './config-file';
import { loadCredential, type Credential } from './credential';
import { ApiError, ToolError } from './errors';
import { toToolMessage } from './messages';
import { configPage, createVaultPage, signInPage } from './pages';
import { ConfigError, DEFAULT_CONFIG, parseConfig, resolvePolicy, type ParsedConfig } from './policy';
import type { Runtime, RuntimeState } from './runtime';
import { createCredential } from './session';
import { listAllVaults } from './vault-model';

const NO_BROWSER = 'No browser could be opened. Ask the user to open this link on this computer and finish there, then call inked_status.';

export type PageWait<T> = PageOutcome<T> | { outcome: 'open_link'; url: string; message: string };

export interface FlowDeps {
  fetch?: typeof fetch;
  /** Called with the page URL as soon as it is serving (the CLI prints it). */
  onPageOpen?: (url: string) => void;
  /** Wait for the page even when no browser started (the CLI, where the user sees the URL). */
  waitWithoutBrowser?: boolean;
}

/** What a failed sign-in shows on the page. */
export function signInMessage(e: unknown): string {
  if (e instanceof ApiError && (e.status === 401 || e.status === 403)) return 'Wrong username or password.';
  if (e instanceof ApiError && e.status === 0) return 'Can’t reach that Inked address. Check it and try again.';
  if (e instanceof Error && /^(Not a URL|The Inked URL)/.test(e.message)) return e.message;
  return toToolMessage(e);
}

/** The allowed vaults and actions in the form the AI reads. */
function access(s: Extract<RuntimeState, { kind: 'ready' }>) {
  return {
    vaults: s.policy.allVaults ? ('all' as const) : s.vaults.filter((v) => s.policy.vaultIds.has(v.id)).map((v) => v.name),
    actions: [...s.policy.actions].sort(),
    writesPerMinute: s.policy.writesPerMinute,
  };
}

/**
 * Where the settings page starts when the config is broken: what the file still says, never wider.
 * A file that cannot be read starts from the defaults with no vault ticked.
 */
function brokenConfigView(file: string | undefined, vaults: NamedVault[]): ConfigView {
  let cfg: ParsedConfig | null = null;
  try {
    const raw = readConfigFile(file);
    if (raw) cfg = parseConfig(raw);
  } catch {
    cfg = null;
  }
  if (!cfg) {
    const d = parseConfig(DEFAULT_CONFIG);
    return { allVaults: false, vaultIds: new Set(), actions: new Set(d.actions), writesPerMinute: d.writesPerMinute };
  }
  const vaultIds = new Set<string>();
  if (cfg.vaults !== '*') {
    // One entry at a time, so a renamed or deleted vault does not drop the others.
    for (const ref of cfg.vaults) {
      try {
        for (const id of resolvePolicy({ ...cfg, vaults: [ref] }, vaults).vaultIds) vaultIds.add(id);
      } catch {
        // unknown or ambiguous: left unticked
      }
    }
  }
  return { allVaults: cfg.vaults === '*', vaultIds, actions: new Set(cfg.actions), writesPerMinute: cfg.writesPerMinute };
}

/** The user-facing steps: each opens a local page, waits for the user, and applies the result to the runtime. */
export class Flows {
  constructor(
    private readonly runtime: Runtime,
    private readonly approvals: ApprovalServer,
    private readonly audit: Audit,
    private readonly deps: FlowDeps = {},
  ) {}

  /** Waits for the page, or returns at once with the link when no browser could be started. */
  private async show<T>(page: ApprovalPage<T>): Promise<PageWait<T>> {
    const { url, result, launched } = await this.approvals.open(page);
    this.deps.onPageOpen?.(url);
    if (this.deps.waitWithoutBrowser) return result;
    const manual = launched.then((ok) =>
      ok ? new Promise<never>(() => {}) : { outcome: 'open_link' as const, url, message: NO_BROWSER },
    );
    return Promise.race([result, manual]);
  }

  async status() {
    const before = this.runtime.state;
    if (before.kind === 'signed-out') {
      if (before.retry) await this.runtime.start();
    } else {
      // Picks up config changes made elsewhere (`inked-mcp config`, a hand edit) without a restart.
      try {
        await this.runtime.guard(() => this.runtime.reload());
      } catch {
        // a network problem: answer from the state as it is
      }
    }
    const s = this.runtime.state;
    if (s.kind === 'signed-out') {
      return {
        signedIn: false,
        ...(s.reason ? { problem: s.reason } : {}),
        next: 'Call sign_in. The user types their password in the browser, never in chat.',
      };
    }
    const who = { signedIn: true, user: s.session.username, server: s.session.baseUrl };
    if (s.kind === 'config-error') {
      return { ...who, problem: `The access settings are invalid: ${s.message}. Use change_config to fix them.` };
    }
    return {
      ...who,
      ...access(s),
      ...(s.policy.actions.has('config.change')
        ? {}
        : { settings: 'You cannot open the access settings. Only the user can, by running `inked-mcp config` in a terminal.' }),
    };
  }

  async signIn() {
    if (this.runtime.state.kind !== 'signed-out') {
      throw new ToolError('invalid', 'Already signed in to Inked. Call sign_out first to switch accounts.');
    }
    let lastUrl: string | undefined;
    try {
      lastUrl = loadCredential().baseUrl;
    } catch {
      lastUrl = undefined;
    }
    const r = await this.show(
      signInPage({
        baseUrl: lastUrl,
        onSubmit: async (input) => {
          let cred: Credential;
          try {
            cred = await createCredential(input, { fetch: this.deps.fetch });
            await this.runtime.signIn(cred);
          } catch (e) {
            throw new PageError(signInMessage(e));
          }
          this.audit.write({ tool: 'signed_in', ok: true });
          return { user: cred.username, server: cred.baseUrl };
        },
        done: (v) => `Signed in as ${v.user}.`,
      }),
    );
    if (r.outcome !== 'done') return r;
    return {
      outcome: 'signed_in' as const,
      ...r.value,
      next: 'The Inked tools are available now. If they do not show up, ask the user to reconnect inked in /mcp.',
    };
  }

  async signOut() {
    await this.runtime.signOut();
    return {
      outcome: 'signed_out' as const,
      note: 'The saved sign-in on this computer is deleted. Changing the Inked password in the web app revokes any other copy.',
    };
  }

  async changeConfig(
    p: { vaults?: '*' | string[]; actions?: string[]; writesPerMinute?: number } = {},
    opts: { byUser?: boolean } = {},
  ) {
    const session = this.runtime.session();
    const s = this.runtime.state;
    if (!opts.byUser && s.kind === 'ready' && !s.policy.actions.has('config.change')) {
      throw new ToolError('denied', 'Not permitted by the Inked MCP config: config.change.');
    }
    const vaults = (await listAllVaults(session)).filter((v) => !v.broken);
    const current: ConfigView = s.kind === 'ready' ? viewOf(s.policy) : brokenConfigView(this.runtime.configFile, vaults);
    let proposed: ConfigView | undefined;
    if (p.vaults !== undefined || p.actions !== undefined || p.writesPerMinute !== undefined) {
      try {
        const cfg = parseConfig({
          version: 1,
          vaults: p.vaults ?? (current.allVaults ? '*' : [...current.vaultIds]),
          actions: p.actions ?? [...current.actions],
          limits: { writesPerMinute: p.writesPerMinute ?? current.writesPerMinute },
        });
        proposed = viewOf(resolvePolicy(cfg, vaults));
      } catch (e) {
        if (e instanceof ConfigError) throw new ToolError('invalid', `${e.message}. Nothing was opened.`);
        throw e;
      }
    }
    const r = await this.show(
      configPage({
        vaults,
        current,
        proposed,
        problem: s.kind === 'config-error' ? `The current settings are invalid: ${s.message}.` : undefined,
        onSubmit: async (view) => {
          try {
            await this.runtime.guard(async () => {
              writeConfigFile(toConfigFile(view, vaults), this.runtime.configFile);
              await this.runtime.reload();
            });
          } catch (e) {
            throw new PageError(e instanceof ConfigError ? e.message : toToolMessage(e));
          }
          const now = this.runtime.state;
          if (now.kind === 'config-error') throw new PageError(now.message);
          this.audit.write({ tool: 'config_applied', ok: true });
          return view;
        },
        done: () => 'Saved. Claude’s access is updated.',
      }),
    );
    if (r.outcome !== 'done') return r;
    const now = this.runtime.state;
    return { outcome: 'config_applied' as const, ...(now.kind === 'ready' ? access(now) : {}) };
  }

  async createVault(name: string, color?: string) {
    const ops = this.runtime.ops();
    if (!ops.policy.actions.has('vault.create')) throw new ToolError('denied', 'Not permitted by the Inked MCP config: vault.create.');
    const clean = name.trim();
    if (!clean) throw new ToolError('invalid', 'Vault name must not be empty.');
    const used = (await listAllVaults(ops.session)).map((v) => v.color);
    const r = await this.show(
      createVaultPage({
        name: clean,
        color: color ?? nextVaultColor(used),
        onSubmit: async (v) => {
          let made: { id: string; name: string; color: string };
          try {
            made = await this.runtime.guard(() => this.runtime.ops().createVault(v.name, v.color));
          } catch (e) {
            throw new PageError(toToolMessage(e));
          }
          this.audit.write({ tool: 'vault_created', ok: true, vaultId: made.id });
          // The vault exists now: a failed grant is reported, never retried by a second Create.
          try {
            await this.runtime.guard(() => this.grantNewVault(made.id));
            return made;
          } catch (e) {
            return { ...made, accessProblem: e instanceof ConfigError ? e.message : toToolMessage(e) };
          }
        },
        done: (v) => `Created ${v.name}.`,
      }),
    );
    if (r.outcome !== 'done') return r;
    return { outcome: 'vault_created' as const, vault: r.value };
  }

  /** A restricted access list gains the new vault ("*" already covers it). */
  private async grantNewVault(id: string): Promise<void> {
    const file = this.runtime.configFile;
    const cfg = readConfigFile(file);
    if (cfg && Array.isArray(cfg.vaults)) {
      const all = await listAllVaults(this.runtime.session());
      // Resolve the file's own entries without the new vault (a shared name would be ambiguous), then rewrite
      // every entry through vaultRef over the full list so shared names become ids.
      const before = all.filter((v) => v.id !== id);
      const ids = [...resolvePolicy(parseConfig(cfg), before).vaultIds, id];
      writeConfigFile({ ...cfg, vaults: ids.map((x) => vaultRef(x, all)) }, file);
    }
    await this.runtime.reload();
    const now = this.runtime.state;
    if (now.kind === 'config-error') throw new ConfigError(now.message);
  }
}
