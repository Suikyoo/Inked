import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ObPublicResponse } from 'inked-core';
import { SearchIcon } from '../../components/Icons';
import { ConceptMap } from '../../map/ConceptMap';
import { ObApiError, fetchPublic, publicImageUrl } from '../api';
import { ReaderDrawer, useReading } from '../board';
import { openboardEntries } from '../entries';
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
  const { selected, reading, fitRequest, openNote, onMapSelect, closeReader } = useReading(data);

  const [query, setQuery] = useState('');
  const [railCollapsed, setRailCollapsed] = useState(() => window.innerWidth < RAIL_OPEN_MIN);
  const inputRef = useRef<HTMLInputElement>(null);

  const q = query.trim();
  const hitNotes = useMemo(() => (q ? matchTitles(data.notes, q) : []), [data, q]);
  const hits = useMemo(() => new Set(hitNotes.map((n) => n.id)), [hitNotes]);

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
          <ReaderDrawer payload={data} reading={reading} resolveImage={resolveImage} onOpenNote={openNote} onClose={closeReader} />
        </div>
      )}
    </div>
  );
}
