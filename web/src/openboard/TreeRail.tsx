import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { INDEX_TITLE, indexNoteOf } from 'inked-core/indexNote';
import type { ObFolder, ObNote, ObPayload } from 'inked-core';
import { VaultIcon } from '../brand/VaultIcon';
import { ChevronRight, IndexIcon, MenuIcon } from '../components/Icons';

/**
 * The slim left rail of a board: vaults > folders > notes, read-only. A folder's Index is its first row.
 *
 * - `selectedId`: the note being read (its row is marked and its folders are opened).
 * - `onSelect(vaultId, noteId)`: a note row was chosen.
 * - `collapsed` / `onToggle`: the rail shrinks to a strip with only its toggle.
 * - `query`: a title filter; while set the rail lists only matching notes, flat, with their folder path.
 */
export interface TreeRailProps {
  payload: ObPayload;
  selectedId: string | null;
  onSelect: (vaultId: string, noteId: string) => void;
  collapsed: boolean;
  onToggle: () => void;
  query?: string;
}

const WEEK_MS = 7 * 24 * 3600 * 1000;
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const byTitle = (a: ObNote, b: ObNote) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });

/** Notes whose title contains every word of `q`, case-insensitively. */
export function matchTitles(notes: readonly ObNote[], q: string): ObNote[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  return notes.filter((n) => {
    const t = n.title.toLowerCase();
    return words.every((w) => t.includes(w));
  });
}

interface VaultTree {
  folders: Map<string | null, ObFolder[]>;
  notes: Map<string | null, ObNote[]>;
  index: Map<string | null, string>;
  parent: Map<string, string | null>;
}

function buildTrees(payload: ObPayload): Map<string, VaultTree> {
  const trees = new Map<string, VaultTree>();
  for (const v of payload.vaults) trees.set(v.id, { folders: new Map(), notes: new Map(), index: new Map(), parent: new Map() });
  for (const f of payload.folders) {
    const t = trees.get(f.vaultId);
    if (!t) continue;
    t.parent.set(f.id, f.parentId);
    t.folders.set(f.parentId, [...(t.folders.get(f.parentId) ?? []), f]);
  }
  for (const n of payload.notes) {
    const t = trees.get(n.vaultId);
    if (!t) continue;
    t.notes.set(n.folderId, [...(t.notes.get(n.folderId) ?? []), n]);
  }
  for (const [vaultId, t] of trees) {
    const notes = Object.fromEntries(payload.notes.filter((n) => n.vaultId === vaultId).map((n) => [n.id, n]));
    for (const key of t.notes.keys()) {
      const ix = indexNoteOf({ notes }, key);
      if (ix) t.index.set(key, ix.id);
    }
    for (const list of t.folders.values()) list.sort(byName);
    for (const list of t.notes.values()) list.sort(byTitle);
  }
  return trees;
}

export function TreeRail({ payload, selectedId, onSelect, collapsed, onToggle, query = '' }: TreeRailProps) {
  const trees = useMemo(() => buildTrees(payload), [payload]);
  const noteById = useMemo(() => new Map(payload.notes.map((n) => [n.id, n])), [payload]);
  const folderById = useMemo(() => new Map(payload.folders.map((f) => [f.id, f])), [payload]);
  // Vaults and folders the visitor closed; everything starts open.
  const [shut, setShut] = useState<ReadonlySet<string>>(() => new Set());

  // Reading a note opens the folders above it, so its row is in view.
  useEffect(() => {
    const n = selectedId ? noteById.get(selectedId) : undefined;
    if (!n) return;
    const up: string[] = [];
    const seen = new Set<string>();
    for (let id = n.folderId; id && !seen.has(id); id = folderById.get(id)?.parentId ?? null) {
      seen.add(id);
      up.push(id);
    }
    up.push(n.vaultId);
    setShut((prev) => (up.some((id) => prev.has(id)) ? new Set([...prev].filter((id) => !up.includes(id))) : prev));
  }, [selectedId, noteById, folderById]);

  const flip = (set: ReadonlySet<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const noteRow = (n: ObNote, isIndex: boolean, sub?: string) => (
    <li key={n.id}>
      <button
        type="button"
        className={`ob-row ob-row-note${isIndex ? ' is-index' : ''}${n.id === selectedId ? ' is-active' : ''}`}
        aria-current={n.id === selectedId ? 'true' : undefined}
        onClick={() => onSelect(n.vaultId, n.id)}
      >
        <span className="ob-row-chev" aria-hidden="true">
          {isIndex && <IndexIcon />}
        </span>
        <span className="ob-row-label">{n.title}</span>
        {sub && <span className="ob-row-sub">{sub}</span>}
      </button>
    </li>
  );

  const level = (t: VaultTree, folderId: string | null, now: number): ReactElement[] => {
    const rows: ReactElement[] = [];
    const ix = t.index.get(folderId);
    const ixNote = ix ? noteById.get(ix) : undefined;
    if (ixNote) rows.push(noteRow(ixNote, true));
    for (const f of t.folders.get(folderId) ?? []) {
      const isOpen = !shut.has(f.id);
      rows.push(
        <li key={f.id}>
          <button type="button" className="ob-row ob-row-folder" aria-expanded={isOpen} onClick={() => setShut((s) => flip(s, f.id))}>
            <span className={`ob-row-chev${isOpen ? ' is-open' : ''}`} aria-hidden="true">
              <ChevronRight size={10} />
            </span>
            <span className="ob-row-label">{f.name}</span>
          </button>
          {isOpen && <ul className="ob-group">{level(t, f.id, now)}</ul>}
        </li>,
      );
    }
    for (const n of t.notes.get(folderId) ?? []) if (n.id !== ix) rows.push(noteRow(n, false));
    return rows;
  };

  const pathOf = (n: ObNote) => {
    const parts: string[] = [];
    const seen = new Set<string>();
    for (let id = n.folderId; id && !seen.has(id); id = folderById.get(id)?.parentId ?? null) {
      seen.add(id);
      const f = folderById.get(id);
      if (!f) break;
      parts.unshift(f.name);
    }
    return parts.join(' / ');
  };

  const q = query.trim();
  const hits = useMemo(() => (q ? matchTitles(payload.notes, q).sort(byTitle) : []), [payload, q]);
  const now = Date.now();

  return (
    <nav className="ob-rail" data-collapsed={collapsed ? 'true' : 'false'} aria-label="Published notes">
      <div className="ob-rail-head">
        <button type="button" className="ibtn ob-rail-toggle" aria-expanded={!collapsed} aria-controls="ob-rail-body" aria-label={collapsed ? 'Show notes list' : 'Hide notes list'} onClick={onToggle}>
          <MenuIcon size={14} />
        </button>
        {!collapsed && <span className="ob-rail-title">{q ? `${hits.length} ${hits.length === 1 ? 'match' : 'matches'}` : 'Notes'}</span>}
      </div>
      {!collapsed && (
        <div className="ob-rail-body" id="ob-rail-body">
          {q ? (
            hits.length > 0 ? (
              <ul className="ob-tree">{hits.map((n) => noteRow(n, n.title === INDEX_TITLE && trees.get(n.vaultId)?.index.get(n.folderId) === n.id, pathOf(n) || undefined))}</ul>
            ) : (
              <p className="ob-rail-empty">No titles match “{q}”.</p>
            )
          ) : (
            payload.vaults.map((v) => {
              const t = trees.get(v.id)!;
              const isOpen = !shut.has(v.id);
              const notes = payload.notes.filter((n) => n.vaultId === v.id);
              const active = notes.filter((n) => now - Date.parse(n.updatedAt) < WEEK_MS).length;
              return (
                <section key={v.id} className="ob-vault">
                  <button type="button" className="ob-row ob-row-vault" aria-expanded={isOpen} onClick={() => setShut((s) => flip(s, v.id))}>
                    <VaultIcon color={v.color} level={active / Math.max(notes.length, 1)} size={14} />
                    <span className="ob-row-label ob-vault-name">{v.name}</span>
                    <span className="ob-row-count">{notes.length}</span>
                  </button>
                  {isOpen && <ul className="ob-tree">{level(t, null, now)}</ul>}
                </section>
              );
            })
          )}
        </div>
      )}
    </nav>
  );
}
