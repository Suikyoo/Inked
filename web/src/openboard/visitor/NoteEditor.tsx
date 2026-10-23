import { useId, useState, type FormEvent, type KeyboardEvent } from 'react';
import { INDEX_TITLE } from 'inked-core/indexNote';
import type { ObNote } from 'inked-core';
import { prefs } from '../../lib/prefs';
import { saveVisitorNote, visitorWriteErrorText } from '../api';

/** The server's limits for visitor writes (server/src/openboard/visitor.ts). */
export const VISITOR_TITLE_MAX = 200;
export const VISITOR_BODY_MAX = 100_000;

/**
 * A Write-link visitor's editor for one published note: its title and its Markdown. Save sends the change
 * with the version it started from, so a note someone else changed meanwhile is refused, not overwritten;
 * the draft stays for the visitor to copy. An Index note keeps its title.
 */
export function NoteEditor({ token, note, onSaved, onCancel }: { token: string; note: ObNote; onSaved: (note: ObNote) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const bodyId = useId();
  const isIndex = note.title === INDEX_TITLE;
  const ready = title.trim().length > 0 && (isIndex || title.trim() !== INDEX_TITLE);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    const nextTitle = title.trim();
    try {
      onSaved(
        await saveVisitorNote(token, note.id, {
          baseUpdatedAt: note.updatedAt,
          ...(isIndex || nextTitle === note.title ? {} : { title: nextTitle }),
          body,
        }),
      );
    } catch (err) {
      setError(visitorWriteErrorText(err));
      setBusy(false);
    }
  };

  // Escape stays in the editor: the drawer would otherwise close and drop the draft.
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Escape') e.preventDefault();
  };

  return (
    <form className="ob-editor" onSubmit={submit} onKeyDown={onKeyDown} aria-label={`Edit “${note.title}”`}>
      <label className="sr-only" htmlFor={titleId}>
        Title
      </label>
      <input
        id={titleId}
        type="text"
        className="input ob-editor-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={VISITOR_TITLE_MAX}
        readOnly={isIndex}
        disabled={busy}
        autoComplete="off"
        spellCheck={prefs.spellcheck()}
      />
      {isIndex && <p className="field-hint">This is the folder’s page, so its title stays.</p>}
      {!isIndex && title.trim() === INDEX_TITLE && <p className="field-hint">“Index” is kept for folder pages. Choose another title.</p>}
      <label className="sr-only" htmlFor={bodyId}>
        Note text
      </label>
      <textarea
        id={bodyId}
        className="input ob-editor-body"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        maxLength={VISITOR_BODY_MAX}
        disabled={busy}
        spellCheck={prefs.spellcheck()}
        autoFocus
      />
      <p className="field-hint">Markdown. Link another note with [[Its title]].</p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="ob-editor-actions">
        <button type="button" className="btn btn-sm" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="submit" className="btn btn-sm btn-primary" disabled={!ready || busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </form>
  );
}
