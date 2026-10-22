import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { indexNoteOf } from 'inked-core/indexNote';
import type { ObNote, ObPublicResponse } from 'inked-core';
import { CloseIcon, SearchIcon } from '../../components/Icons';
import { ConceptMap, type MapSelection } from '../../map/ConceptMap';
import { DUR, usePresence } from '../../motion';
import { ObApiError, fetchPublic, publicImageUrl } from '../api';
import { openboardEntries } from '../entries';
import { Reader } from '../Reader';
import { matchTitles, TreeRail } from '../TreeRail';

/** Below this width the rail starts collapsed. */
const RAIL_OPEN_MIN = 900;

/** The token in `/ob/<token>`, or null. */
export function tokenFromPath(pathname: string): string | null {
  const seg = pathname.split('/')[2] ?? '';
  if (pathname.split('/')[1] !== 'ob' || !seg) return null;
  try {
    return decodeURIComponent(seg);
  } catch {
    return null;
  }
}

type Load = { kind: 'loading' } | { kind: 'ready'; data: ObPublicResponse } | { kind: 'missing' } | { kind: 'limited' };

/** Runs `fn` after the next layout has settled (two frames), so the map has measured a just-opened drawer. */
function afterLayout(fn: () => void): () => void {
  if (typeof requestAnimationFrame !== 'function') {
    const id = setTimeout(fn, 0);
    return () => clearTimeout(id);
  }
  let inner = 0;
  const outer = requestAnimationFrame(() => {
    inner = requestAnimationFrame(fn);
  });
  return () => {
    cancelAnimationFrame(outer);
    cancelAnimationFrame(inner);
  };
}

function Gone({ children }: { children: string }) {
  return (
    <main className="ob-gone">
      <p className="wordmark">Inked</p>
      <p className="ob-gone-text">{children}</p>
    </main>
  );
}

/** The public board at `/ob/:token`: a read-only map, a tree rail and a reading drawer. No account, no editing. */
export function VisitorPage() {
  const token = useMemo(() => tokenFromPath(window.location.pathname), []);
  const [load, setLoad] = useState<Load>(() => (token ? { kind: 'loading' } : { kind: 'missing' }));

  useEffect(() => {
    if (!token) return;
    let live = true;
    fetchPublic(token).then(
      (data) => live && setLoad({ kind: 'ready', data }),
      (e: unknown) => live && setLoad(e instanceof ObApiError && e.status === 429 ? { kind: 'limited' } : { kind: 'missing' }),
    );
    return () => {
      live = false;
    };
  }, [token]);

  useEffect(() => {
    if (load.kind === 'ready' && load.data.label) document.title = `${load.data.label} · Inked`;
  }, [load]);

  if (load.kind === 'missing') return <Gone>This link doesn’t exist or was removed.</Gone>;
  if (load.kind === 'limited') return <Gone>Too many tries. Wait a minute, then reload the page.</Gone>;
  if (load.kind === 'loading')
    return (
      <main className="ob-gone" aria-busy="true">
        <p className="ob-gone-text">Loading…</p>
      </main>
    );
  return <Board token={token!} data={load.data} />;
}

function Board({ token, data }: { token: string; data: ObPublicResponse }) {
  const entries = useMemo(() => openboardEntries(data), [data]);
  const noteById = useMemo(() => new Map(data.notes.map((n) => [n.id, n])), [data]);
  const notesByVault = useMemo(() => {
    const m = new Map<string, Record<string, ObNote>>();
    for (const n of data.notes) m.set(n.vaultId, { ...(m.get(n.vaultId) ?? {}), [n.id]: n });
    return m;
  }, [data]);
  const indexOf = useCallback((vaultId: string, folderId: string | null) => indexNoteOf({ notes: notesByVault.get(vaultId) ?? {} }, folderId), [notesByVault]);

  const [query, setQuery] = useState('');
  const [railCollapsed, setRailCollapsed] = useState(() => window.innerWidth < RAIL_OPEN_MIN);
  const [selected, setSelected] = useState<MapSelection | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [fitRequest, setFitRequest] = useState<{ sel: MapSelection; n: number } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = query.trim();
  const hitNotes = useMemo(() => (q ? matchTitles(data.notes, q) : []), [data, q]);
  const hits = useMemo(() => new Set(hitNotes.map((n) => n.id)), [hitNotes]);

  // Re-centre the map on what was chosen once the drawer's width has been taken from it.
  const cancelCenter = useRef<(() => void) | null>(null);
  const center = useCallback((sel: MapSelection) => {
    cancelCenter.current?.();
    cancelCenter.current = afterLayout(() => setFitRequest((r) => ({ sel, n: (r?.n ?? 0) + 1 })));
  }, []);
  useEffect(() => () => cancelCenter.current?.(), []);

  const openNote = useCallback(
    (vaultId: string, noteId: string) => {
      const note = noteById.get(noteId);
      if (!note || note.vaultId !== vaultId) return;
      // An Index note has no dot of its own: its folder (or, at the root, the vault hub) stands for it.
      const isIndex = indexOf(vaultId, note.folderId)?.id === note.id;
      const sel: MapSelection = !isIndex
        ? { kind: 'note', vaultId, id: noteId }
        : note.folderId
          ? { kind: 'folder', vaultId, id: note.folderId }
          : { kind: 'hub', vaultId };
      setSelected(sel);
      setReading(noteId);
      center(sel);
    },
    [noteById, indexOf, center],
  );

  const onMapSelect = useCallback(
    (sel: MapSelection | null) => {
      if (!sel) {
        setSelected(null);
        setReading(null);
        return;
      }
      if (sel.kind === 'note') return openNote(sel.vaultId, sel.id);
      // A folder or hub shows its Index when it has one; otherwise it is only highlighted and framed.
      setSelected(sel);
      setReading(indexOf(sel.vaultId, sel.kind === 'folder' ? sel.id : null)?.id ?? null);
      center(sel);
    },
    [openNote, indexOf, center],
  );

  const closeReader = useCallback(() => setReading(null), []);
  useEffect(() => {
    if (!reading) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setReading(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reading]);

  const drawer = usePresence(reading !== null, DUR[3]);
  // The drawer keeps showing its last note while it slides out.
  const lastNote = useRef<ObNote | null>(null);
  const readingNote = reading ? (noteById.get(reading) ?? null) : null;
  if (readingNote) lastNote.current = readingNote;
  const shownNote = readingNote ?? lastNote.current;

  const resolveImage = useCallback((vaultId: string, imageId: string) => publicImageUrl(token, vaultId, imageId), [token]);

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && query) {
      e.preventDefault();
      // Clearing the query is all this Escape does; the drawer stays open.
      e.stopPropagation();
      setQuery('');
    } else if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const first = hitNotes[0];
      if (first) openNote(first.vaultId, first.id);
    }
  };

  const empty = data.vaults.length === 0;

  return (
    <div className="ob" data-rail={railCollapsed ? 'collapsed' : 'open'}>
      <header className="ob-top">
        <div className="ob-top-side">
          <span className="ob-label" title={data.label}>
            {data.label}
          </span>
        </div>
        {!empty && (
          <form role="search" className="search ob-search" onSubmit={(e) => e.preventDefault()}>
            <SearchIcon className="search-icon" />
            <label htmlFor="ob-q" className="sr-only">
              Search titles
            </label>
            <input
              ref={inputRef}
              id="ob-q"
              type="search"
              autoComplete="off"
              spellCheck={false}
              placeholder="Search titles"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onSearchKey}
              aria-describedby="ob-q-help"
            />
            <span id="ob-q-help" className="sr-only">
              Filters the notes list and highlights matching notes on the map. Press Enter to read the first match.
            </span>
          </form>
        )}
        <div className="ob-top-side is-end">
          <span className="ob-mark wordmark">
            Inked
          </span>
        </div>
      </header>

      {empty ? (
        <div className="ob-empty">
          <p>Nothing is shared on this link yet.</p>
        </div>
      ) : (
        <div className="ob-body">
          <TreeRail payload={data} selectedId={reading} onSelect={openNote} collapsed={railCollapsed} onToggle={() => setRailCollapsed((c) => !c)} query={query} />
          <section className="map ob-map" aria-label="Concept map">
            <ConceptMap entries={entries} hits={hits} hot={null} searching={q.length > 0} loading={false} selected={selected} onSelect={onMapSelect} onOpenNote={openNote} fitRequest={fitRequest} />
          </section>
          {drawer.mounted && shownNote && (
            <aside className="ob-drawer" ref={drawer.ref} data-state={drawer.state} aria-label="Reader">
              <div className="ob-drawer-bar">
                <button type="button" className="ibtn" aria-label="Close reader" onClick={closeReader}>
                  <CloseIcon size={13} />
                </button>
              </div>
              <div className="ob-drawer-scroll">
                <Reader note={shownNote} payload={data} resolveImage={resolveImage} onOpenNote={openNote} />
              </div>
            </aside>
          )}
        </div>
      )}
    </div>
  );
}
