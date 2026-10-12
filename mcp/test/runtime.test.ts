import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { toBase64Url } from 'inked-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { saveCredential } from '../src/credential';
import { CredentialStale } from '../src/errors';
import { Runtime, STALE_REASON } from '../src/runtime';
import { createCredential } from '../src/session';
import { addVault, changePassword, seedUser, startInked } from './helpers/inked';

const PW = 'correct horse battery';

describe('Runtime', () => {
  let srv: Awaited<ReturnType<typeof startInked>>;
  let home: string;
  beforeAll(async () => {
    srv = await startInked();
    await seedUser(srv.baseUrl, 'jude', PW);
    await addVault(srv.baseUrl, 'jude', PW, 'Work');
  });
  afterAll(() => srv.close());
  beforeEach(() => {
    home = mkdtempSync(path.join(tmpdir(), 'inked-rt-'));
    process.env.INKED_MCP_HOME = home;
  });
  const cred = () => createCredential({ baseUrl: srv.baseUrl, username: 'jude', password: PW });

  it('starts signed out with no credential and no reason', async () => {
    const rt = new Runtime();
    await rt.start();
    expect(rt.state).toEqual({ kind: 'signed-out' });
    expect(() => rt.ops()).toThrow('Not signed in to Inked. Call sign_in.');
  });

  it('signIn saves the credential, becomes ready with the default policy, and notifies', async () => {
    const rt = new Runtime();
    await rt.start();
    const seen: string[] = [];
    rt.subscribe((s) => seen.push(s.kind));
    await rt.signIn(await cred());
    expect(rt.state.kind).toBe('ready');
    expect(existsSync(path.join(home, 'credential.json'))).toBe(true);
    expect(seen).toEqual(['ready']);
    expect(rt.state.kind === 'ready' && rt.state.policy.actions.has('config.change')).toBe(true);
    await rt.close();
  });

  it('a credential that cannot sign in throws and changes nothing', async () => {
    const rt = new Runtime();
    await rt.start();
    const bad = { ...(await cred()), masterSecret: toBase64Url(new Uint8Array(32)) };
    await expect(rt.signIn(bad)).rejects.toThrow();
    expect(rt.state.kind).toBe('signed-out');
    expect(existsSync(path.join(home, 'credential.json'))).toBe(false);
  });

  it('reload picks up a new config; a broken config gives config-error, not an exit', async () => {
    saveCredential(await cred());
    const rt = new Runtime();
    await rt.start();
    expect(rt.state.kind).toBe('ready');
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 1, vaults: ['Work'], actions: ['@read', '@write'] }));
    await rt.reload();
    expect(rt.state.kind === 'ready' && rt.state.policy.actions.has('note.create')).toBe(true);
    writeFileSync(path.join(home, 'config.json'), JSON.stringify({ version: 1, vaults: ['Nope'], actions: ['@read'] }));
    await rt.reload();
    expect(rt.state).toMatchObject({ kind: 'config-error', message: 'Vault "Nope" not found' });
    expect(() => rt.ops()).toThrow('The access settings are invalid: Vault "Nope" not found. Use change_config to fix them.');
    await rt.close();
  });

  it('keeps the write budget across a reload with the same limit', async () => {
    saveCredential(await cred());
    const rt = new Runtime();
    await rt.start();
    const before = rt.ops().limiter;
    await rt.reload();
    expect(rt.ops().limiter).toBe(before);
    await rt.close();
  });

  it('after a password change, start signs out with a plain reason', async () => {
    saveCredential(await cred());
    await changePassword(srv.baseUrl, 'jude', PW, 'another password here');
    try {
      const rt = new Runtime();
      await rt.start();
      expect(rt.state).toEqual({ kind: 'signed-out', reason: STALE_REASON });
    } finally {
      await changePassword(srv.baseUrl, 'jude', 'another password here', PW);
    }
  });

  it('guard turns a credential that goes stale mid-session into signed-out', async () => {
    saveCredential(await cred());
    const rt = new Runtime();
    await rt.start();
    await expect(
      rt.guard(async () => {
        throw new CredentialStale();
      }),
    ).rejects.toThrow('Call sign_in.');
    expect(rt.state).toEqual({ kind: 'signed-out', reason: STALE_REASON });
  });

  it('an unreachable server signs out with retry, and a later start recovers', async () => {
    saveCredential(await cred());
    let down = true;
    const flaky: typeof fetch = (input, init) => (down ? Promise.reject(new TypeError('fetch failed')) : fetch(input, init));
    const rt = new Runtime({ fetch: flaky });
    await rt.start();
    expect(rt.state).toEqual({ kind: 'signed-out', reason: 'Can’t reach the Inked server.', retry: true });
    down = false;
    await rt.start();
    expect(rt.state.kind).toBe('ready');
    await rt.close();
  });

  it('signOut deletes the credential', async () => {
    saveCredential(await cred());
    const rt = new Runtime();
    await rt.start();
    await rt.signOut();
    expect(rt.state).toEqual({ kind: 'signed-out' });
    expect(existsSync(path.join(home, 'credential.json'))).toBe(false);
  });

  it('runs state changes one at a time', async () => {
    saveCredential(await cred());
    const rt = new Runtime();
    await rt.start();
    const kinds: string[] = [];
    rt.subscribe((s) => kinds.push(s.kind));
    await Promise.all([rt.reload(), rt.signOut(), rt.reload().catch((e: Error) => kinds.push(e.message))]);
    expect(kinds).toEqual(['ready', 'signed-out', 'Not signed in to Inked. Call sign_in.']);
  });
});
