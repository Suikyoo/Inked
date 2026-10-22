// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';
import { note, tree, vault } from '../map/fixtures';
import { StoreProvider } from '../state/StoreContext';
import type { AppState, AppStore } from '../state/store';
import { Sidebar } from './Sidebar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(path = '/') {
  const state = {
    vaultsStatus: 'ready',
    vaults: { v1: vault('v1'), v2: vault('v2') },
    vaultOrder: ['v1', 'v2'],
    trees: { v1: tree([], [note('n1', null, 'Alpha')]), v2: tree([], []) },
    bodies: {},
    bodiesReady: {},
  } as unknown as AppState;
  const store = { getState: () => state, subscribe: () => () => undefined } as unknown as AppStore;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <StoreProvider store={store}>
          <Sidebar id="side" onLock={() => undefined} />
        </StoreProvider>
      </MemoryRouter>,
    ),
  );
}

const link = (name: string) => [...host!.querySelectorAll<HTMLAnchorElement>('a.vault-link')].find((a) => a.textContent?.includes(name))!;

describe('Sidebar vault icon', () => {
  it('rushes ink through the clicked vault’s icon only', () => {
    mount();
    expect(host!.querySelector('.vi-rush')).toBeNull();
    act(() => link('Vault v1').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })));
    expect(link('Vault v1').querySelector('.vi-rush')).not.toBeNull();
    expect(link('Vault v2').querySelector('.vi-rush')).toBeNull();
  });
});

describe('Sidebar openboard', () => {
  it('the vault menu offers Publish to openboard next to Vault settings', () => {
    mount('/v/v1');
    act(() => void document.querySelector('button[aria-label="Actions for vault Vault v1"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    const items = [...document.querySelectorAll('[role=menuitem]')].map((el) => el.textContent?.trim());
    expect(items).toContain('Publish to openboard');
    expect(items.indexOf('Publish to openboard')).toBe(items.indexOf('Vault settings') - 1);
  });

  it('links to the openboard editor in a new tab', () => {
    mount();
    const a = [...host!.querySelectorAll('a')].find((el) => el.getAttribute('href') === '/openboard');
    expect(a?.textContent).toContain('Openboard');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toContain('noopener');
  });
});
