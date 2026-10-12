import { describe, expect, it } from 'vitest';
import { PageError } from '../src/approval';
import type { ConfigView } from '../src/config-file';
import { configPage, createVaultPage, signInPage, type SignInInput } from '../src/pages';
import { ACTIONS, type Action } from '../src/policy';

const V = [
  { id: 'a', name: 'Work' },
  { id: 'b', name: 'Ideas' },
];
const view = (over: Partial<ConfigView> = {}): ConfigView => ({
  allVaults: false,
  vaultIds: new Set(['a']),
  actions: new Set<Action>(['vault.list']),
  writesPerMinute: 120,
  ...over,
});
const none = { done: () => '' };

describe('sign-in page', () => {
  it('prefills the last address and never refills the password', () => {
    const p = signInPage({ baseUrl: 'https://n.example', onSubmit: async () => 1, ...none });
    expect(p.fields()).toContain('value="https://n.example"');
    const again = p.fields(new URLSearchParams({ baseUrl: 'https://n.example', username: 'jude', password: 'hunter2hunter2' }));
    expect(again).toContain('value="jude"');
    expect(again).not.toContain('hunter2');
  });

  it('requires all three fields and passes trimmed input on, with the password as typed', async () => {
    let got: SignInInput | undefined;
    const p = signInPage({ onSubmit: async (i) => (got = i), ...none });
    await expect(p.submit(new URLSearchParams({ baseUrl: 'https://n.example', username: 'jude' }))).rejects.toThrow(PageError);
    await p.submit(new URLSearchParams({ baseUrl: ' https://n.example ', username: ' jude ', password: ' pw ' }));
    expect(got).toEqual({ baseUrl: 'https://n.example', username: 'jude', password: ' pw ' });
  });
});

describe('config page', () => {
  it('lists every action exactly once', () => {
    const html = configPage({ vaults: V, current: view(), onSubmit: async () => 0, ...none }).fields();
    for (const a of ACTIONS) expect(html.split(`value="${a}"`).length - 1).toBe(1);
  });

  it('marks only what Claude proposed to change', () => {
    const proposed = view({ actions: new Set<Action>(['vault.list', 'note.create']) });
    const html = configPage({ vaults: V, current: view(), proposed, onSubmit: async () => 0, ...none }).fields();
    expect(html.match(/proposed by Claude/g)).toHaveLength(1);
    expect(html).toContain('value="note.create" checked> <span>Create notes<span class="tag">proposed by Claude');
  });

  it('turns the form into a view, dropping unknown vaults and actions', async () => {
    let got: ConfigView | undefined;
    const p = configPage({ vaults: V, current: view(), onSubmit: async (v) => (got = v), ...none });
    await p.submit(new URLSearchParams([['vault', 'a'], ['vault', 'zzz'], ['action', 'search'], ['action', 'nope'], ['wpm', '30']]));
    expect(got).toEqual({ allVaults: false, vaultIds: new Set(['a']), actions: new Set(['search']), writesPerMinute: 30 });
  });

  it('refuses no vaults, no actions, or a bad rate', async () => {
    const p = configPage({ vaults: V, current: view(), onSubmit: async () => 0, ...none });
    await expect(p.submit(new URLSearchParams([['action', 'search'], ['wpm', '30']]))).rejects.toThrow('Tick at least one vault');
    await expect(p.submit(new URLSearchParams([['all', 'on'], ['wpm', '30']]))).rejects.toThrow('Tick at least one action');
    await expect(p.submit(new URLSearchParams([['all', 'on'], ['action', 'search'], ['wpm', '0']]))).rejects.toThrow('Writes per minute');
  });

  it('shows the current config problem', () => {
    const html = configPage({ vaults: V, current: view(), problem: 'Vault "Nope" not found', onSubmit: async () => 0, ...none }).fields();
    expect(html).toContain('Vault &quot;Nope&quot; not found');
  });
});

describe('create-vault page', () => {
  it('prefills the name (escaped) and the color', () => {
    const html = createVaultPage({ name: '<Ideas>', color: '#D19C3C', onSubmit: async () => 0, ...none }).fields();
    expect(html).toContain('value="&lt;Ideas&gt;"');
    expect(html).toContain('value="#D19C3C" checked');
  });

  it('refuses an empty name or a color outside the palette', async () => {
    const p = createVaultPage({ name: 'x', color: '#45A89E', onSubmit: async () => 0, ...none });
    await expect(p.submit(new URLSearchParams({ name: ' ', color: '#45A89E' }))).rejects.toThrow('Give the vault a name.');
    await expect(p.submit(new URLSearchParams({ name: 'x', color: '#000000' }))).rejects.toThrow('Pick one of the colors.');
  });
});
