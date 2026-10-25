import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { indexNoteOf } from 'inked-core/indexNote';
import type { ObNote, ObPayload } from 'inked-core';
import { CloseIcon } from '../components/Icons';
import type { MapSelection } from '../map/ConceptMap';
import { DUR, usePresence } from '../motion';
import { Reader } from './Reader';

/**
 * Pieces shared by the visitor board and the editor's preview: what is selected on the map, which note the
 * drawer reads, and the drawer itself.
 */

/** Runs `fn` after the next layout has settled (two frames), so the map acts on its current size and scene. */
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

export interface Reading {
  selected: MapSelection | null;
  /** The note the drawer shows, or null. */
  reading: string | null;
  fitRequest: { sel: MapSelection; n: number } | null;
  openNote: (vaultId: string, noteId: string) => void;
  onMapSelect: (sel: MapSelection | null) => void;
  closeReader: () => void;
}

/** Map selection and reading state over one payload. A note that leaves the payload is closed. */
export function useReading(payload: ObPayload): Reading {
  const noteById = useMemo(() => new Map(payload.notes.map((n) => [n.id, n])), [payload]);
  const notesByVault = useMemo(() => {
    const m = new Map<string, Record<string, ObNote>>();
    for (const n of payload.notes) m.set(n.vaultId, { ...(m.get(n.vaultId) ?? {}), [n.id]: n });
    return m;
  }, [payload]);
  const indexOf = useCallback((vaultId: string, folderId: string | null) => indexNoteOf({ notes: notesByVault.get(vaultId) ?? {} }, folderId), [notesByVault]);

  const [selected, setSelected] = useState<MapSelection | null>(null);
  const [reading, setReading] = useState<string | null>(null);
  const [fitRequest, setFitRequest] = useState<{ sel: MapSelection; n: number } | null>(null);

  // Frame the map on what was chosen, so it is where the reader left it when the note closes.
  const cancelCenter = useRef<(() => void) | null>(null);
  const center = useCallback((sel: MapSelection) => {
    cancelCenter.current?.();
    cancelCenter.current = afterLayout(() => setFitRequest((r) => ({ sel, n: (r?.n ?? 0) + 1 })));
  }, []);
  useEffect(() => () => cancelCenter.current?.(), []);

  // A new payload without the note being read (or the selected vault) closes it.
  useEffect(() => {
    if (reading && !noteById.has(reading)) setReading(null);
    setSelected((s) => (s && !payload.vaults.some((v) => v.id === s.vaultId) ? null : s));
  }, [payload, noteById, reading]);

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
  return { selected, reading, fitRequest, openNote, onMapSelect, closeReader };
}

/**
 * The reading drawer: slides in beside the map (over the page on phones); Escape or its button closes it.
 * `actions` adds buttons to its bar for the shown note; `body` replaces the reader when it returns something
 * (the visitor's editor). An Escape whose default was prevented (inside the editor) or that comes from a
 * dialog does not close it.
 */
export function ReaderDrawer({
  payload,
  reading,
  resolveImage,
  onOpenNote,
  onClose,
  actions,
  body,
  centre = false,
}: {
  payload: ObPayload;
  reading: string | null;
  resolveImage: (vaultId: string, imageId: string) => string;
  onOpenNote: (vaultId: string, noteId: string) => void;
  onClose: () => void;
  actions?: (note: ObNote) => ReactNode;
  body?: (note: ObNote) => ReactNode;
  /** True on the visitor page: the note covers the map's box instead of sitting in a side drawer. */
  centre?: boolean;
}) {
  const noteById = useMemo(() => new Map(payload.notes.map((n) => [n.id, n])), [payload]);
  useEffect(() => {
    if (!reading) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      const inDialog = e.target instanceof Element && e.target.closest('dialog') !== null;
      if (e.key === 'Escape' && !e.defaultPrevented && !inDialog) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [reading, onClose]);

  const drawer = usePresence(reading !== null, DUR[3]);
  // The drawer keeps showing its last note while it slides out.
  const lastNote = useRef<ObNote | null>(null);
  const readingNote = reading ? (noteById.get(reading) ?? null) : null;
  if (readingNote) lastNote.current = readingNote;
  const shownNote = readingNote ?? lastNote.current;

  if (!drawer.mounted || !shownNote) return null;
  return (
    <aside className={centre ? 'ob-drawer is-centre' : 'ob-drawer'} ref={drawer.ref} data-state={drawer.state} aria-label="Reader">
      <div className="ob-drawer-bar">
        {actions?.(shownNote)}
        <button type="button" className="ibtn" aria-label="Close reader" onClick={onClose}>
          <CloseIcon size={13} />
        </button>
      </div>
      <div className="ob-drawer-scroll">
        {body?.(shownNote) ?? <Reader note={shownNote} payload={payload} resolveImage={resolveImage} onOpenNote={onOpenNote} />}
      </div>
    </aside>
  );
}
