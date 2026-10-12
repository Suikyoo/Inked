// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { note, tree, vault } from '../map/fixtures';
import { StoreProvider } from '../state/StoreContext';
import type { AppState, AppStore } from '../state/store';
import { VaultPage } from './VaultPage';

const homeMounts = vi.hoisted(() => ({ n: 0 }));
vi.mock('./HomePage', async () => {
  const { useEffect } = await import('react');
  return {
    HomePage: ({ focusVault }: { focusVault?: string }) => {
      useEffect(() => void homeMounts.n++, []);
      return <p data-testid="home">home:{focusVault}</p>;
    },
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function mount(path: string, state: Partial<AppState>) {
  const store = { getState: () => state, subscribe: () => () => undefined } as unknown as AppStore;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <MemoryRouter initialEntries={[path]}>
        <StoreProvider store={store}>
          <Routes>
            <Route path="/v/:vaultId" element={<VaultPage />} />
          </Routes>
        </StoreProvider>
      </MemoryRouter>,
    ),
  );
}

describe('VaultPage', () => {
  it('a vault opens Home focused on that vault, not a list of recent notes', () => {
    mount('/v/v1', {
      vaultsStatus: 'ready',
      vaults: { v1: vault('v1', 'Work') },
      vaultOrder: ['v1'],
      trees: { v1: tree([], [note('x', null, 'X')]) },
    } as unknown as AppState);
    expect(host!.textContent).toBe('home:v1');
  });

  it('serves Home too, and keeps one Home mounted while moving between Home and vaults', () => {
    const state = {
      vaultsStatus: 'ready',
      vaults: { v1: vault('v1', 'Work'), v2: vault('v2', 'Garden') },
      vaultOrder: ['v1', 'v2'],
      trees: { v1: tree([], []), v2: tree([], []) },
    } as unknown as AppState;
    const store = { getState: () => state, subscribe: () => () => undefined } as unknown as AppStore;
    let go!: (to: string) => void;
    function Nav() {
      go = useNavigate();
      return null;
    }
    homeMounts.n = 0;
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        <MemoryRouter initialEntries={['/']}>
          <StoreProvider store={store}>
            <Nav />
            <Routes>
              <Route index element={<VaultPage />} />
              <Route path="/v/:vaultId" element={<VaultPage />} />
            </Routes>
          </StoreProvider>
        </MemoryRouter>,
      ),
    );
    expect(host.textContent).toBe('home:');
    act(() => go('/v/v1'));
    expect(host.textContent).toBe('home:v1');
    act(() => go('/v/v2'));
    expect(host.textContent).toBe('home:v2');
    act(() => go('/'));
    expect(host.textContent).toBe('home:');
    expect(homeMounts.n).toBe(1);
  });

  it('says so when the vault does not exist', () => {
    mount('/v/nope', { vaultsStatus: 'ready', vaults: {}, vaultOrder: [], trees: {} } as unknown as AppState);
    expect(host!.textContent).toContain('This vault doesn’t exist');
  });
});
