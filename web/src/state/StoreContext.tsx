import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { titleIndex } from '../lib/titles';
import { buildEntry, type SearchEntry } from 'inked-core';
import { AppStore, type AppState, type FolderView, type TreeView } from './store';

const StoreCtx = createContext<AppStore | null>(null);

export function StoreProvider({ store, children }: { store: AppStore; children: ReactNode }) {
  return <StoreCtx.Provider value={store}>{children}</StoreCtx.Provider>;
}

export function useStore(): AppStore {
  const s = useContext(StoreCtx);
  if (!s) throw new Error('StoreProvider missing');
  return s;
}

export function useAppState(): AppState {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}

// ---- Derived data ------------------------------------------------------------------------

export function folderPath(tree: TreeView | undefined, folderId: string | null): FolderView[] {
  const out: FolderView[] = [];
  const seen = new Set<string>();
  let id = folderId;
  while (id && tree?.folders[id] && !seen.has(id)) {
    seen.add(id);
    out.unshift(tree.folders[id]);
    id = tree.folders[id].parentId;
  }
  return out;
}

export { vaultStats, type VaultStats } from './vaultStats';

export function useSearchEntries(state: AppState): SearchEntry[] {
  const { trees, vaults, vaultOrder } = state;
  return useMemo(() => {
    const out: SearchEntry[] = [];
    for (const vid of vaultOrder) {
      const v = vaults[vid];
      const tree = trees[vid];
      if (!v || !tree) continue;
      for (const n of Object.values(tree.notes)) {
        const path = folderPath(tree, n.folderId).map((f) => f.name);
        out.push(buildEntry(n.id, vid, v.name, path, n.title, n.updatedAt));
      }
    }
    return out;
  }, [trees, vaults, vaultOrder]);
}

export { titleIndex };
