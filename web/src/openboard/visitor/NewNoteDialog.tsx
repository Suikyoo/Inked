import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { INDEX_TITLE } from 'inked-core/indexNote';
import type { ObNote, ObPayload } from 'inked-core';
import { Dialog } from '../../components/Dialog';
import { prefs } from '../../lib/prefs';
import { createVisitorNote, visitorWriteErrorText } from '../api';
import { VISITOR_TITLE_MAX } from './NoteEditor';

interface Place {
  /** `vaultId:folderId`, with an empty folder id for the vault's top level. */
  value: string;
  label: string;
  vaultId: string;
  folderId: string | null;
}

const placeValue = (vaultId: string, folderId: string | null) => `${vaultId}:${folderId ?? ''}`;

/** Every place a note can go: each vault's top level, then its folders depth first, as "Vault › Folder › Sub". */
export function placesOf(payload: ObPayload): Place[] {
  const places: Place[] = [];
  for (const v of payload.vaults) {
    places.push({ value: placeValue(v.id, null), label: v.name, vaultId: v.id, folderId: null });
    const children = new Map<string | null, typeof payload.folders>();
    for (const f of payload.folders.filter((x) => x.vaultId === v.id)) children.set(f.parentId, [...(children.get(f.parentId) ?? []), f]);
    const seen = new Set<string>();
    const walk = (parentId: string | null, path: string[]) => {
      for (const f of children.get(parentId) ?? []) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        const next = [...path, f.name];
        places.push({ value: placeValue(v.id, f.id), label: next.join(' › '), vaultId: v.id, folderId: f.id });
        walk(f.id, next);
      }
    };
    walk(null, [v.name]);
  }
  return places;
}

/** A Write-link visitor's "New note": a title and where it goes. The new note opens for editing. */
export function NewNoteDialog({
  open,
  token,
  payload,
  near,
  onClose,
  onCreated,
}: {
  open: boolean;
  token: string;
  payload: ObPayload;
  /** The note being read; the new note goes beside it unless the visitor picks another place. */
  near: ObNote | null;
  onClose: () => void;
  onCreated: (note: ObNote) => void;
}) {
  const places = useMemo(() => placesOf(payload), [payload]);
  const [title, setTitle] = useState('');
  const [place, setPlace] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const placeId = useId();

  useEffect(() => {
    if (!open) return;
    setTitle('');
    const beside = near ? placeValue(near.vaultId, near.folderId) : '';
    setPlace(places.some((p) => p.value === beside) ? beside : (places[0]?.value ?? ''));
    setBusy(false);
    setError(null);
    // Only when the dialog opens: a payload change while it is open keeps the visitor's choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const reserved = title.trim() === INDEX_TITLE;
  const chosen = places.find((p) => p.value === place);
  const ready = title.trim().length > 0 && !reserved && !!chosen;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy || !chosen) return;
    setBusy(true);
    setError(null);
    try {
      const note = await createVisitorNote(token, { vaultId: chosen.vaultId, folderId: chosen.folderId, title: title.trim(), body: '' });
      onCreated(note);
      onClose();
    } catch (err) {
      setError(visitorWriteErrorText(err));
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} title="New note" onClose={() => !busy && onClose()}>
      <form className="stack-8" onSubmit={submit}>
        <label className="field-label" htmlFor={titleId}>
          Title
        </label>
        <input
          id={titleId}
          type="text"
          className="input"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={VISITOR_TITLE_MAX}
          autoComplete="off"
          spellCheck={prefs.spellcheck()}
          autoFocus
          disabled={busy}
        />
        {reserved && <p className="field-hint">“Index” is kept for folder pages. Choose another title.</p>}
        <label className="field-label" htmlFor={placeId}>
          Put it in
        </label>
        <select id={placeId} className="input" value={place} onChange={(e) => setPlace(e.target.value)} disabled={busy}>
          {places.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
        <p className="field-hint">Anyone with this link can read and change it.</p>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
