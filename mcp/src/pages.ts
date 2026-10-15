import { VAULT_COLORS } from 'inked-core';
import { esc, PageError, type ApprovalPage } from './approval';
import type { ConfigView, NamedVault } from './config-file';
import { isAction, type Action } from './policy';

export interface SignInInput {
  baseUrl: string;
  username: string;
  password: string;
}

export function signInPage<T>(opts: {
  baseUrl?: string;
  onSubmit(input: SignInInput): Promise<T>;
  done(value: T): string;
}): ApprovalPage<T> {
  return {
    title: 'Sign in to Inked',
    intro: 'Claude will read and write your notes from this computer. Your password stays on this page: only a key derived from it is saved here.',
    submitLabel: 'Sign in',
    // The password field is never refilled, not even after an error.
    fields: (f) => `
<label for="baseUrl">Inked address</label>
<input type="url" id="baseUrl" name="baseUrl" required placeholder="https://notes.example.com" value="${esc(f?.get('baseUrl') ?? opts.baseUrl ?? '')}">
<label for="username">Username</label>
<input type="text" id="username" name="username" required autocomplete="username" autocapitalize="none" value="${esc(f?.get('username') ?? '')}">
<label for="password">Password</label>
<input type="password" id="password" name="password" required autocomplete="current-password">`,
    submit: async (f) => {
      const input = {
        baseUrl: (f.get('baseUrl') ?? '').trim(),
        username: (f.get('username') ?? '').trim(),
        password: f.get('password') ?? '',
      };
      if (!input.baseUrl || !input.username || !input.password) throw new PageError('Fill in the address, username and password.');
      return opts.onSubmit(input);
    },
    done: opts.done,
  };
}

const SECTIONS: { title: string; items: [Action, string][] }[] = [
  { title: 'Read', items: [['vault.list', 'See vault names'], ['tree.read', 'See folders and note titles'], ['note.read', 'Read notes'], ['search', 'Search notes']] },
  { title: 'Write', items: [['folder.create', 'Create folders'], ['note.create', 'Create notes'], ['note.append', 'Add to the end of notes'], ['note.update', 'Rewrite notes'], ['image.create', 'Add images to notes (fetches web links; reads folders you list as imageDirs in the config file)']] },
  { title: 'Organize', items: [['note.move', 'Move notes'], ['folder.rename', 'Rename folders'], ['folder.move', 'Move folders']] },
  {
    title: 'Manage',
    items: [
      ['vault.create', 'Create vaults (you approve each one)'],
      ['config.change', 'Open this page to suggest changes (you approve each one)'],
    ],
  },
];

export function configPage<T>(opts: {
  vaults: NamedVault[];
  current: ConfigView;
  proposed?: ConfigView;
  problem?: string;
  onSubmit(view: ConfigView): Promise<T>;
  done(value: T): string;
}): ApprovalPage<T> {
  const shown = opts.proposed ?? opts.current;
  const tag = (now: boolean, before: boolean) => (opts.proposed && now !== before ? '<span class="tag">proposed by Claude</span>' : '');
  const box = (name: string, value: string, label: string, on: boolean, before: boolean) =>
    `<label class="check"><input type="checkbox" name="${name}" value="${esc(value)}"${on ? ' checked' : ''}> <span>${esc(label)}${tag(on, before)}</span></label>`;
  return {
    title: 'What Claude may do in Inked',
    intro: opts.proposed
      ? 'Claude suggested the changes marked below. Nothing changes until you click Apply.'
      : 'Choose the vaults and actions Claude may use. Nothing changes until you click Apply.',
    submitLabel: 'Apply',
    fields: (f) => {
      // After an error, show what the user picked rather than the starting point.
      const all = f ? f.get('all') === 'on' : shown.allVaults;
      const vaultOn = (id: string) => (f ? f.getAll('vault').includes(id) : shown.vaultIds.has(id));
      const actionOn = (a: Action) => (f ? f.getAll('action').includes(a) : shown.actions.has(a));
      const wpm = f?.get('wpm') ?? String(shown.writesPerMinute);
      return `${opts.problem ? `<p class="error">${esc(opts.problem)} Apply replaces the current settings.</p>` : ''}
<fieldset><legend>Vaults</legend>
${box('all', 'on', 'All vaults, including ones made later', all, opts.current.allVaults)}
${opts.vaults.map((v) => box('vault', v.id, v.name, vaultOn(v.id), opts.current.vaultIds.has(v.id))).join('\n')}
<p class="hint">Claude sees nothing in a vault left unticked.</p></fieldset>
${SECTIONS.map(
  (s) => `<fieldset><legend>${s.title}</legend>${s.items.map(([a, label]) => box('action', a, label, actionOn(a), opts.current.actions.has(a))).join('\n')}</fieldset>`,
).join('\n')}
<p class="hint">If you untick “Open this page”, Claude can’t bring this page up again. To undo that, run <code>inked-mcp config</code> in a terminal.</p>
<label for="wpm">Writes per minute</label>
<input type="number" id="wpm" name="wpm" min="1" max="1000" required value="${esc(wpm)}">`;
    },
    submit: async (f) => {
      const allVaults = f.get('all') === 'on';
      const known = new Set(opts.vaults.map((v) => v.id));
      const vaultIds = new Set(f.getAll('vault').filter((id) => known.has(id)));
      const actions = new Set(f.getAll('action').filter(isAction));
      const writesPerMinute = Number(f.get('wpm'));
      if (!allVaults && vaultIds.size === 0) throw new PageError('Tick at least one vault, or All vaults.');
      if (actions.size === 0) throw new PageError('Tick at least one action.');
      if (!Number.isInteger(writesPerMinute) || writesPerMinute < 1 || writesPerMinute > 1000) {
        throw new PageError('Writes per minute must be a whole number from 1 to 1000.');
      }
      return opts.onSubmit({ allVaults, vaultIds: allVaults ? new Set() : vaultIds, actions, writesPerMinute, imageDirs: opts.current.imageDirs });
    },
    done: opts.done,
  };
}

const COLOR_NAMES = ['Teal', 'Amber', 'Blue', 'Rose'];

export function createVaultPage<T>(opts: {
  name: string;
  color: string;
  onSubmit(v: { name: string; color: string }): Promise<T>;
  done(value: T): string;
}): ApprovalPage<T> {
  return {
    title: 'Create a vault',
    intro: 'Claude asked to create this vault. Claude will be able to use it with the permissions it has now.',
    submitLabel: 'Create vault',
    // Inline style attributes are blocked by the page's CSP, so each swatch gets a class.
    css:
      '.swatch{display:inline-block;width:1rem;height:1rem;border-radius:50%;vertical-align:middle}' +
      VAULT_COLORS.map((c, i) => `.swatch-${i}{background:${c}}`).join(''),
    fields: (f) => {
      const color = f?.get('color') ?? opts.color;
      return `<label for="name">Name</label>
<input type="text" id="name" name="name" required value="${esc(f?.get('name') ?? opts.name)}">
<fieldset><legend>Color</legend>
${VAULT_COLORS.map(
  (c, i) => `<label class="check"><input type="radio" name="color" value="${c}"${c === color ? ' checked' : ''}> <span class="swatch swatch-${i}"></span> <span>${COLOR_NAMES[i]}</span></label>`,
).join('\n')}</fieldset>`;
    },
    submit: async (f) => {
      const name = (f.get('name') ?? '').trim();
      const color = f.get('color') ?? '';
      if (!name) throw new PageError('Give the vault a name.');
      if (!(VAULT_COLORS as readonly string[]).includes(color)) throw new PageError('Pick one of the colors.');
      return opts.onSubmit({ name, color });
    },
    done: opts.done,
  };
}
