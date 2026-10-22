import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { indexNoteOf } from 'inked-core/indexNote';
import type { ObFolder, ObLink, ObNote, ObPayload } from 'inked-core';
import { VaultIcon } from '../../brand/VaultIcon';
import { ConfirmDialog } from '../../components/Dialog';
import { ChevronRight, IndexIcon } from '../../components/Icons';
import { ConceptMap } from '../../map/ConceptMap';
import { ObApiError, errorText, ownerImageUrl, previewPayload, unpublish } from '../api';
import { ReaderDrawer, useReading } from '../board';
import { openboardEntries } from '../entries';

type Kind = 'vault' | 'folder' | 'note';
interface Target {
  kind: Kind;
  id: string;
  name: string;
  /** Notes removed with it (a vault's or folder's whole subtree). */
  notes: number;
}

const EMPTY: ObPayload = { vaults: [], folders: [], notes: [] };
const NO_HITS: ReadonlySet<string> = new Set();
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const byTitle = (a: ObNote, b: ObNote) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface ContentTabProps {
  /** Everything published (no bodies): the tree. */
  content: ObPayload;
  links: ObLink[];
  /** Refetches content and links after an unpublish. */
  onChanged: () => Promise<void>;
  onAuthLost: () => void;
}

/**
 * Published content: the tree with Unpublish at every level, and beside it the map a link's visitors see
 * ("Preview as"), read through the owner preview endpoint so no view is counted.
 */
export function ContentTab({ content, links, onChanged, onAuthLost }: ContentTabProps) {
  const [linkId, setLinkId] = useState('');
  const [preview, setPreview] = useState<ObPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const lastTarget = useRef<Target | null>(null);
  if (target) lastTarget.current = target;
  const shownTarget = target ?? lastTarget.current;
  // A tree note outside the previewed link: switch to "All published", then open it.
  const [pendingOpen, setPendingOpen] = useState<ObNote | null>(null);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ObApiError && e.status === 401) onAuthLost();
      return errorText(e);
    },
    [onAuthLost],
  );

  // A link deleted meanwhile falls back to everything.
  useEffect(() => {
    if (linkId && !links.some((l) => l.id === linkId)) setLinkId('');
  }, [links, linkId]);

  // Refetch the preview when the link changes or the content does (after an unpublish).
  useEffect(() => {
    let live = true;
    setError(null);
    previewPayload(linkId || undefined).then(
      (p) => live && setPreview(p),
      (e: unknown) => live && setError(fail(e)),
    );
    return () => {
      live = false;
    };
  }, [linkId, content, fail]);

  const shown = preview ?? EMPTY;
  const entries = useMemo(() => openboardEntries(shown), [shown]);
  const { selected, reading, fitRequest, openNote, onMapSelect, closeReader } = useReading(shown);
  const resolveImage = useCallback((vaultId: string, imageId: string) => ownerImageUrl(vaultId, imageId), []);

  const openFromTree = (n: ObNote) => {
    if (preview?.notes.some((p) => p.id === n.id)) return openNote(n.vaultId, n.id);
    setPendingOpen(n);
    setLinkId('');
  };
  useEffect(() => {
    if (!pendingOpen || !preview?.notes.some((p) => p.id === pendingOpen.id)) return;
    openNote(pendingOpen.vaultId, pendingOpen.id);
    setPendingOpen(null);
  }, [pendingOpen, preview, openNote]);

  const linkLabel = links.find((l) => l.id === linkId)?.label;

  return (
    <div className="obe-content">
      <ContentTree content={content} reading={reading} onOpen={openFromTree} onUnpublish={setTarget} />

      <section className="obe-stage" aria-label="Map preview">
        <div className="obe-stage-bar">
          <label className="field-label" htmlFor="obe-preview-as">
            Preview as
          </label>
          <select id="obe-preview-as" className="input input-sm obe-select" value={linkId} onChange={(e) => setLinkId(e.target.value)}>
            <option value="">All published</option>
            {links.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </select>
          <span className="obe-stage-note">{linkLabel ? `What visitors of “${linkLabel}” see. Previews don’t count as views.` : 'Everything you have published.'}</span>
        </div>
        {error && (
          <p className="form-error obe-error" role="alert">
            {error}
          </p>
        )}
        <div className="obe-stage-body">
          {preview && preview.vaults.length === 0 ? (
            <div className="ob-empty">
              <p>{linkLabel ? 'This link shows nothing yet.' : 'Nothing is published yet.'}</p>
            </div>
          ) : (
            <section className="map ob-map" aria-label="Concept map">
              <ConceptMap entries={entries} hits={NO_HITS} hot={null} loading={preview === null} selected={selected} onSelect={onMapSelect} onOpenNote={openNote} fitRequest={fitRequest} />
            </section>
          )}
          <ReaderDrawer payload={shown} reading={reading} resolveImage={resolveImage} onOpenNote={openNote} onClose={closeReader} />
        </div>
      </section>

      <ConfirmDialog
        open={target !== null}
        title={shownTarget ? unpublishTitle(shownTarget) : 'Unpublish'}
        message={shownTarget ? <p>{unpublishText(shownTarget)}</p> : null}
        confirmLabel="Unpublish"
        onClose={() => setTarget(null)}
        onConfirm={async () => {
          const t = target;
          if (!t) return;
          try {
            await unpublish(t.kind, t.id);
          } catch (e) {
            throw new Error(fail(e));
          }
          await onChanged();
        }}
      />
    </div>
  );
}

function unpublishTitle(t: Target): string {
  if (t.kind === 'vault') return `Unpublish vault “${t.name}”?`;
  if (t.kind === 'folder') return `Unpublish folder “${t.name}”?`;
  return `Unpublish “${t.name}”?`;
}

function unpublishText(t: Target): string {
  const tail = 'Your notes in Inked don’t change.';
  if (t.kind === 'vault') return `The vault and its ${plural(t.notes, 'note')} are removed from openboard, and every link that includes it stops showing it. ${tail}`;
  if (t.kind === 'folder') return `The folder, its subfolders and ${plural(t.notes, 'note')} are removed from openboard, so links stop showing them. ${tail}`;
  return `The note is removed from openboard, so links stop showing it. ${tail}`;
}

interface Tree {
  folders: Map<string | null, ObFolder[]>;
  notes: Map<string | null, ObNote[]>;
  index: Map<string | null, string>;
  /** Notes below each folder, at any depth. */
  counts: Map<string, number>;
}

function buildTrees(p: ObPayload): Map<string, Tree> {
  const trees = new Map<string, Tree>();
  for (const v of p.vaults) trees.set(v.id, { folders: new Map(), notes: new Map(), index: new Map(), counts: new Map() });
  const parent = new Map(p.folders.map((f) => [f.id, f.parentId]));
  for (const f of p.folders) {
    const t = trees.get(f.vaultId);
    if (t) t.folders.set(f.parentId, [...(t.folders.get(f.parentId) ?? []), f]);
  }
  for (const n of p.notes) {
    const t = trees.get(n.vaultId);
    if (!t) continue;
    t.notes.set(n.folderId, [...(t.notes.get(n.folderId) ?? []), n]);
    const seen = new Set<string>();
    for (let id = n.folderId; id && !seen.has(id); id = parent.get(id) ?? null) {
      seen.add(id);
      t.counts.set(id, (t.counts.get(id) ?? 0) + 1);
    }
  }
  for (const [vaultId, t] of trees) {
    const notes = Object.fromEntries(p.notes.filter((n) => n.vaultId === vaultId).map((n) => [n.id, n]));
    for (const key of t.notes.keys()) {
      const ix = indexNoteOf({ notes }, key);
      if (ix) t.index.set(key, ix.id);
    }
    for (const list of t.folders.values()) list.sort(byName);
    for (const list of t.notes.values()) list.sort(byTitle);
  }
  return trees;
}

function ContentTree({ content, reading, onOpen, onUnpublish }: { content: ObPayload; reading: string | null; onOpen: (n: ObNote) => void; onUnpublish: (t: Target) => void }) {
  const trees = useMemo(() => buildTrees(content), [content]);
  const [shut, setShut] = useState<ReadonlySet<string>>(() => new Set());
  const flip = (id: string) =>
    setShut((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const unpublishBtn = (t: Target) => (
    <button type="button" className="obe-unpublish" onClick={() => onUnpublish(t)} aria-label={`Unpublish ${t.kind} “${t.name}”`}>
      Unpublish
    </button>
  );

  const noteRow = (n: ObNote, isIndex: boolean) => (
    <li key={n.id}>
      <div className={`obe-tree-row${n.id === reading ? ' is-active' : ''}`}>
        <button type="button" className={`ob-row ob-row-note obe-tree-open${isIndex ? ' is-index' : ''}`} aria-current={n.id === reading ? 'true' : undefined} onClick={() => onOpen(n)}>
          <span className="ob-row-chev" aria-hidden="true">
            {isIndex && <IndexIcon />}
          </span>
          <span className="ob-row-label">{n.title}</span>
        </button>
        {unpublishBtn({ kind: 'note', id: n.id, name: n.title, notes: 1 })}
      </div>
    </li>
  );

  const level = (t: Tree, folderId: string | null): ReactElement[] => {
    const rows: ReactElement[] = [];
    const ix = t.index.get(folderId);
    const ixNote = ix ? t.notes.get(folderId)?.find((n) => n.id === ix) : undefined;
    if (ixNote) rows.push(noteRow(ixNote, true));
    for (const f of t.folders.get(folderId) ?? []) {
      const open = !shut.has(f.id);
      rows.push(
        <li key={f.id}>
          <div className="obe-tree-row">
            <button type="button" className="ob-row ob-row-folder" aria-expanded={open} onClick={() => flip(f.id)}>
              <span className={`ob-row-chev${open ? ' is-open' : ''}`} aria-hidden="true">
                <ChevronRight size={10} />
              </span>
              <span className="ob-row-label">{f.name}</span>
            </button>
            {unpublishBtn({ kind: 'folder', id: f.id, name: f.name, notes: t.counts.get(f.id) ?? 0 })}
          </div>
          {open && <ul className="ob-group">{level(t, f.id)}</ul>}
        </li>,
      );
    }
    for (const n of t.notes.get(folderId) ?? []) if (n.id !== ix) rows.push(noteRow(n, false));
    return rows;
  };

  return (
    <nav className="obe-side" aria-label="Published content">
      <div className="obe-side-head">
        <h2 className="obe-side-title">Published</h2>
        <span className="obe-side-count">
          {plural(content.vaults.length, 'vault')} · {plural(content.notes.length, 'note')}
        </span>
      </div>
      <div className="obe-side-body">
        {content.vaults.length === 0 ? (
          <p className="ob-rail-empty">Nothing is published. In the notes app, choose “Publish to openboard” in a vault’s menu.</p>
        ) : (
          content.vaults.map((v) => {
            const t = trees.get(v.id)!;
            const open = !shut.has(v.id);
            const count = content.notes.filter((n) => n.vaultId === v.id).length;
            return (
              <section key={v.id} className="ob-vault">
                <div className="obe-tree-row">
                  <button type="button" className="ob-row ob-row-vault" aria-expanded={open} onClick={() => flip(v.id)}>
                    <VaultIcon color={v.color} level={0} size={14} />
                    <span className="ob-row-label ob-vault-name">{v.name}</span>
                    <span className="ob-row-count">{count}</span>
                  </button>
                  {unpublishBtn({ kind: 'vault', id: v.id, name: v.name, notes: count })}
                </div>
                {open && <ul className="ob-tree">{level(t, null)}</ul>}
              </section>
            );
          })
        )}
      </div>
    </nav>
  );
}
