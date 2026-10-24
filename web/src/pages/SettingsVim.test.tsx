// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccountSettings } from 'inked-core';
import { AccountSettingsProvider } from '../state/AccountSettingsContext';
import { accountStub } from '../test/account';
import { VIM_CONFIG_MAX } from '../editor/vimConfig';
import { VimSettings } from './SettingsVim';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** Mounts the section over a stub account store, returning the recorded updates. */
function mount(settings: AccountSettings = {}) {
  const updates: AccountSettings[] = [];
  const store = accountStub(
    { settings },
    {
      update: async (change: (s: AccountSettings) => AccountSettings) => {
        updates.push(change(settings));
      },
    },
  );
  act(() => {
    root.render(
      <AccountSettingsProvider store={store}>
        <VimSettings />
      </AccountSettingsProvider>,
    );
  });
  return updates;
}

const toggle = () => host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
const config = () => host.querySelector<HTMLTextAreaElement>('textarea');
const errors = () => Array.from(host.querySelectorAll('.vim-error')).map((e) => e.textContent ?? '');

/** Types into a controlled field the way React hears it, as SettingsAsk.test.tsx does. */
function type(el: HTMLTextAreaElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  act(() => {
    set.call(el, value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

describe('VimSettings', () => {
  it('is off by default, with no config field', () => {
    mount();
    expect(toggle().checked).toBe(false);
    expect(config()).toBeNull();
  });

  it('saves the toggle through the account settings store', async () => {
    const updates = mount();
    await act(async () => toggle().click());
    expect(updates).toEqual([{ vim: { on: true, config: '' } }]);
  });

  it('shows the config field when vim is on', () => {
    mount({ vim: { on: true, config: '' } });
    expect(config()).not.toBeNull();
  });

  it('caps the config field at VIM_CONFIG_MAX', () => {
    mount({ vim: { on: true, config: '' } });
    expect(config()!.maxLength).toBe(VIM_CONFIG_MAX);
  });

  it('shows every compile error with its line number', () => {
    mount({ vim: { on: true, config: "vim.keymap.set('n', 'x', 'y')\nvim.o.swapfile = false" } });
    expect(errors()).toHaveLength(1);
    expect(errors()[0]).toContain('Line 2');
    expect(errors()[0]).toContain('swapfile');
  });

  it('shows no errors for a config that compiles', () => {
    mount({ vim: { on: true, config: "vim.keymap.set('i', 'jk', '<Esc>')" } });
    expect(errors()).toEqual([]);
  });

  it('saves the config text as typed', async () => {
    const updates = mount({ vim: { on: true, config: '' } });
    type(config()!, "vim.keymap.set('i', 'jk', '<Esc>')");
    await act(async () => host.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    expect(updates).toEqual([{ vim: { on: true, config: "vim.keymap.set('i', 'jk', '<Esc>')" } }]);
  });
});
