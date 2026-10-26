import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { indexNoteOf } from 'inked-core/indexNote';
import { nextVaultColor } from 'inked-core/vaultColors';
import type { ObFolder, ObLink, ObNote, ObPayload } from 'inked-core';
import { VaultIcon, inkLevelLabel } from '../../brand/VaultIcon';
import { ColorPicker } from '../../components/ColorPicker';
import { ConfirmDialog, PromptDialog } from '../../components/Dialog';
import { ChevronRight, DownloadIcon, IndexIcon } from '../../components/Icons';
import { ConceptMap } from '../../map/ConceptMap';
import { notesInkLevel } from '../../state/vaultStats';
import { ObApiError, createOwnerFolder, createOwnerNote, createOwnerVault, errorText, ownerImageUrl, previewPayload, saveOwnerNote, unpublish } from '../api';
import { ObNoteEditor } from '../ObNoteEditor';
import { ReaderDrawer, useReading } from '../board';
import { openboardEntries } from '../entries';
import { exportOpenboard, type ExportTarget } from '../export';

type Kind = 'vault' | 'folder' | 'note';
interface Target {
  kind: Kind;
  id: string;
  name: string;
  /** Notes removed with it (a vault's or folder's whole subtree). */
  notes: number;
  /** In an openboard-native vault, so this content exists nowhere else and deleting it destroys it. */
  native: boolean;
}

const EMPTY: ObPayload = { vaults: [], folders: [], notes: [] };
const NO_HITS: ReadonlySet<string> = new Set();
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
const byTitle = (a: ObNote, b: ObNote) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The server's limits for an interactive write (server/src/openboard/write.ts). */
const OB_TITLE_MAX = 200;
const OB_BODY_MAX = 100_000;

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
  /** The note being edited in the drawer, by id. */
  const [editing, setEditing] = useState<string | null>(null);
  /** A pending "New folder" / "New note" prompt, by vault. */
  const [creating, setCreating] = useState<{ kind: 'folder' | 'note'; vaultId: string; parentId: string | null } | null>(null);
  /** The export key being written (`vault:<id>`, `folder:<id>`, `note:<id>`). */
  const [exporting, setExporting] = useState<string | null>(null);
  // One export at a time; the ref closes the gap between the click and the state update.
  const exportBusy = useRef(false);
  const dirty = useRef(false);
  const onDirtyChange = useCallback((d: boolean) => {
    dirty.current = d;
  }, []);

  const fail = useCallback(
    (e: unknown) => {
      if (e instanceof ObApiError && e.status === 401) onAuthLost();
      return errorText(e);
    },
    [onAuthLost],
  );

  /**
   * Exports always read the all-published preview: the tree's `content` carries no bodies, and the
   * stage's preview may be narrowed to one link while the tree still offers every vault.
   */
  const runExport = useCallback(
    async (target: ExportTarget) => {
      if (exportBusy.current) return;
      exportBusy.current = true;
      const key = `${target.kind}:${target.id}`;
      setExporting(key);
      setError(null);
      try {
        await exportOpenboard(await previewPayload(), target);
      } catch (e) {
        setError(e instanceof ObApiError && e.status === 401 ? fail(e) : 'Couldn’t make that export. Try again.');
      } finally {
        exportBusy.current = false;
        setExporting(null);
      }
    },
    [fail],
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

  /** True when nothing unsaved would be lost, or the owner agrees to drop it. */
  const mayLeave = useCallback(() => {
    if (!editing || !dirty.current) return true;
    if (!window.confirm('Discard your changes to this note?')) return false;
    dirty.current = false;
    return true;
  }, [editing]);

  // Reading another note, or closing the drawer, leaves edit mode.
  useEffect(() => {
    setEditing((id) => (id === reading ? id : null));
  }, [reading]);

  // Closing or reloading the tab with unsaved changes asks first.
  useEffect(() => {
    if (!editing) {
      dirty.current = false;
      return;
    }
    const onUnload = (e: BeforeUnloadEvent) => {
      if (!dirty.current) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [editing]);

  const linkLabel = links.find((l) => l.id === linkId)?.label;

  return (
    <div className="obe-content">
      <ContentTree
        content={content}
        reading={reading}
        onOpen={(n) => {
          if (n.id === reading || mayLeave()) openFromTree(n);
        }}
        onUnpublish={setTarget}
        onNewFolder={(vaultId, parentId) => setCreating({ kind: 'folder', vaultId, parentId })}
        onNewNote={(vaultId, parentId) => setCreating({ kind: 'note', vaultId, parentId })}
        onExport={(target) => void runExport(target)}
        exporting={exporting}
        newVault={<NewVaultForm used={content.vaults.map((v) => v.color)} onCreated={onChanged} fail={fail} />}
      />

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
              <ConceptMap
                entries={entries}
                hits={NO_HITS}
                hot={null}
                loading={preview === null}
                selected={selected}
                onSelect={(sel) => {
                  if ((sel?.kind === 'note' && sel.id === reading) || mayLeave()) onMapSelect(sel);
                }}
                onOpenNote={(vaultId, noteId) => {
                  if (noteId === reading || mayLeave()) openNote(vaultId, noteId);
                }}
                fitRequest={fitRequest}
              />
            </section>
          )}
          <ReaderDrawer
            payload={shown}
            reading={reading}
            resolveImage={resolveImage}
            onOpenNote={(vaultId, noteId) => {
              if (noteId === reading || mayLeave()) openNote(vaultId, noteId);
            }}
            onClose={() => {
              if (mayLeave()) closeReader();
            }}
            actions={(note) =>
              editing === note.id ? null : (
                <>
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={exporting === `note:${note.id}`}
                    onClick={() => void runExport({ kind: 'note', id: note.id })}
                  >
                    {exporting === `note:${note.id}` ? 'Preparing…' : 'Download'}
                  </button>
                  <button type="button" className="btn btn-sm ob-edit" onClick={() => setEditing(note.id)}>
                    Edit
                  </button>
                </>
              )
            }
            body={(note) =>
              editing === note.id ? (
                <ObNoteEditor
                  key={note.id}
                  note={note}
                  payload={shown}
                  resolveImage={resolveImage}
                  onSave={(patch) => saveOwnerNote(note.id, patch)}
                  errorText={fail}
                  onSaved={() => {
                    setEditing(null);
                    void onChanged();
                  }}
                  onCancel={() => {
                    dirty.current = false;
                    setEditing(null);
                  }}
                  onDirtyChange={onDirtyChange}
                  // The owner wrote it, so its links are as trusted as published ones.
                  untrustedPreview={false}
                  titleMax={OB_TITLE_MAX}
                  bodyMax={OB_BODY_MAX}
                />
              ) : null
            }
          />
        </div>
      </section>

      <PromptDialog
        open={creating !== null}
        title={creating?.kind === 'folder' ? 'New folder' : 'New note'}
        label={creating?.kind === 'folder' ? 'Folder name' : 'Note title'}
        onClose={() => setCreating(null)}
        onSubmit={async (value) => {
          if (!creating) return;
          try {
            if (creating.kind === 'folder') await createOwnerFolder(creating.vaultId, creating.parentId, value);
            else await createOwnerNote(creating.vaultId, creating.parentId, value, '');
          } catch (e) {
            throw new Error(fail(e));
          }
          await onChanged();
        }}
      />

      <ConfirmDialog
        open={target !== null}
        title={shownTarget ? unpublishTitle(shownTarget) : 'Unpublish'}
        message={shownTarget ? <p>{unpublishText(shownTarget)}</p> : null}
        confirmLabel={shownTarget?.native ? 'Delete' : 'Unpublish'}
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

/**
 * Makes a vault that lives only in openboard. Its notes are stored unencrypted on the server and exist
 * nowhere else, which the form says plainly: this is the one place the product's "plaintext never touches
 * disk" promise is deliberately set aside.
 */
function NewVaultForm({ used, onCreated, fail }: { used: string[]; onCreated: () => Promise<void>; fail: (e: unknown) => string }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(() => nextVaultColor(used));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await createOwnerVault(name.trim(), color);
      setName('');
      await onCreated();
    } catch (err) {
      setError(err instanceof ObApiError && err.code === 'name_taken' ? `You already have a vault called "${name.trim()}".` : fail(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="obe-new-vault" onSubmit={submit} noValidate>
      <label className="field-label" htmlFor="obe-new-vault-name">
        New Openboard vault
      </label>
      <input
        id="obe-new-vault-name"
        className="input input-sm"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={OB_TITLE_MAX}
        placeholder="Vault name"
        spellCheck={false}
        disabled={busy}
      />
      <ColorPicker value={color} onChange={setColor} label="New vault colour" />
      <p className="field-hint">
        Written here, not published from Inked. Its notes are stored <strong>unencrypted</strong> on the server and exist nowhere else, so
        deleting the vault destroys them.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="btn btn-sm" disabled={busy || !name.trim()}>
        {busy ? 'Creating…' : 'Create vault'}
      </button>
    </form>
  );
}

function unpublishTitle(t: Target): string {
  const verb = t.native ? 'Delete' : 'Unpublish';
  if (t.kind === 'vault') return `${verb} vault “${t.name}”?`;
  if (t.kind === 'folder') return `${verb} folder “${t.name}”?`;
  return `${verb} “${t.name}”?`;
}

function unpublishText(t: Target): string {
  // Native content has no private original behind it, so nothing can restore it afterwards.
  if (t.native) {
    const what =
      t.kind === 'vault'
        ? `The vault and its ${plural(t.notes, 'note')}`
        : t.kind === 'folder'
          ? `The folder, its subfolders and ${plural(t.notes, 'note')}`
          : 'The note';
    return `${what} were written here and exist nowhere else, so they are deleted for good. This can’t be undone.`;
  }
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

function ContentTree({
  content,
  reading,
  onOpen,
  onUnpublish,
  onNewFolder,
  onNewNote,
  onExport,
  exporting,
  newVault,
}: {
  content: ObPayload;
  reading: string | null;
  onOpen: (n: ObNote) => void;
  onUnpublish: (t: Target) => void;
  onNewFolder: (vaultId: string, parentId: string | null) => void;
  onNewNote: (vaultId: string, parentId: string | null) => void;
  onExport: (t: Extract<ExportTarget, { kind: 'vault' | 'folder' }>) => void;
  exporting: string | null;
  newVault: ReactElement;
}) {
  const nativeVaults = useMemo(() => new Set(content.vaults.filter((v) => v.origin === 'native').map((v) => v.id)), [content.vaults]);
  const trees = useMemo(() => buildTrees(content), [content]);
  const [shut, setShut] = useState<ReadonlySet<string>>(() => new Set());
  // Ink rush: a click on a vault flashes its icon's spokes, as it does in the app's sidebar and on the map hub.
  const [rush, setRush] = useState({ vaultId: '', seq: 0 });
  const flip = (id: string) =>
    setShut((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  /** Download a vault or folder subtree as a zip. */
  const downloadBtn = (kind: 'vault' | 'folder', id: string, name: string) => {
    const busy = exporting === `${kind}:${id}`;
    return (
      <button
        type="button"
        className="obe-add"
        onClick={() => onExport({ kind, id })}
        disabled={busy}
        aria-busy={busy || undefined}
        aria-label={`Download ${kind} “${name}” as Markdown`}
        title={`Download ${kind}`}
      >
        <DownloadIcon size={12} />
      </button>
    );
  };

  /** Unpublish for a published vault's content; Delete for native content, which has no other copy. */
  const unpublishBtn = (vaultId: string, t: Omit<Target, 'native'>) => {
    const native = nativeVaults.has(vaultId);
    return (
      <button
        type="button"
        className="obe-unpublish"
        onClick={() => onUnpublish({ ...t, native })}
        aria-label={`${native ? 'Delete' : 'Unpublish'} ${t.kind} “${t.name}”`}
      >
        {native ? 'Delete' : 'Unpublish'}
      </button>
    );
  };

  const noteRow = (n: ObNote, isIndex: boolean) => (
    <li key={n.id}>
      <div className={`obe-tree-row${n.id === reading ? ' is-active' : ''}`}>
        <button type="button" className={`ob-row ob-row-note obe-tree-open${isIndex ? ' is-index' : ''}`} aria-current={n.id === reading ? 'true' : undefined} onClick={() => onOpen(n)}>
          <span className="ob-row-chev" aria-hidden="true">
            {isIndex && <IndexIcon />}
          </span>
          <span className="ob-row-label">{n.title}</span>
          {n.visitorEdited && <span className="obe-visitor-tag">Edited by a visitor</span>}
        </button>
        {unpublishBtn(n.vaultId, { kind: 'note', id: n.id, name: n.title, notes: 1 })}
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
            {nativeVaults.has(f.vaultId) && (
              <>
                <button type="button" className="obe-add" onClick={() => onNewFolder(f.vaultId, f.id)} aria-label={`New folder in “${f.name}”`}>
                  New folder
                </button>
                <button type="button" className="obe-add" onClick={() => onNewNote(f.vaultId, f.id)} aria-label={`New note in “${f.name}”`}>
                  New note
                </button>
              </>
            )}
            {downloadBtn('folder', f.id, f.name)}
            {unpublishBtn(f.vaultId, { kind: 'folder', id: f.id, name: f.name, notes: t.counts.get(f.id) ?? 0 })}
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
            const notes = content.notes.filter((n) => n.vaultId === v.id);
            const count = notes.length;
            // The same 7-day rule the visitor rail, the map hub and the app's sidebar use: the icon must not
            // read as "nothing written this week" here when it reads full elsewhere.
            const ink = notesInkLevel(notes);
            return (
              <section key={v.id} className="ob-vault">
                <div className="obe-tree-row">
                  <button
                    type="button"
                    className="ob-row ob-row-vault"
                    aria-expanded={open}
                    title={`${v.name} · ${inkLevelLabel(ink)}`}
                    onClick={() => {
                      flip(v.id);
                      setRush((r) => ({ vaultId: v.id, seq: r.seq + 1 }));
                    }}
                  >
                    <VaultIcon color={v.color} level={ink} size={14} rush={rush.vaultId === v.id ? rush.seq : 0} />
                    <span className="ob-row-label ob-vault-name">{v.name}</span>
                    <span className="ob-row-count">{count}</span>
                  </button>
                  {downloadBtn('vault', v.id, v.name)}
                  {unpublishBtn(v.id, { kind: 'vault', id: v.id, name: v.name, notes: count })}
                </div>
                {nativeVaults.has(v.id) && (
                  <p className="obe-native-tag">
                    Openboard-only · stored unencrypted
                  </p>
                )}
                {open && <ul className="ob-tree">{level(t, null)}</ul>}
                {open && nativeVaults.has(v.id) && (
                  <div className="obe-vault-actions">
                    <button type="button" className="btn btn-sm" onClick={() => onNewFolder(v.id, null)}>
                      New folder
                    </button>
                    <button type="button" className="btn btn-sm" onClick={() => onNewNote(v.id, null)}>
                      New note
                    </button>
                  </div>
                )}
              </section>
            );
          })
        )}
        {newVault}
      </div>
    </nav>
  );
}
