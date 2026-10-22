import { useMemo, useRef } from 'react';
import type { AppState } from '../state/store';
import { buildVaultGraph, type VaultGraph } from './graph';
import { mapEntries, type LayoutCache, type MapEntry } from './mapEntries';

export { mapEntries, type GraphState, type LayoutCache, type MapEntry } from './mapEntries';

const NO_ENTRIES: MapEntry[] = [];

/** `enabled` false builds nothing (a phone before "Load map"). */
export function useVaultGraphs(state: AppState, enabled = true): MapEntry[] {
  const cache = useRef<LayoutCache>(new Map());
  const { vaultOrder, vaults, trees, bodies, bodiesReady } = state;
  return useMemo(
    () => (enabled ? mapEntries({ vaultOrder, vaults, trees, bodies, bodiesReady }, cache.current) : NO_ENTRIES),
    [enabled, vaultOrder, vaults, trees, bodies, bodiesReady],
  );
}

/** The link graph of one vault, or null before its tree has loaded. */
export function useVaultGraph(state: AppState, vaultId: string): VaultGraph | null {
  const tree = state.trees[vaultId];
  const ready = !!state.bodiesReady[vaultId];
  const { bodies } = state;
  return useMemo(() => (tree ? buildVaultGraph(vaultId, tree, bodies, ready) : null), [vaultId, tree, bodies, ready]);
}
