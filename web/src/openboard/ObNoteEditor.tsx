import { useEffect, useId, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { INDEX_TITLE } from 'inked-core/indexNote';
import type { ObNote, ObPayload } from 'inked-core';
import { prefs } from '../lib/prefs';
import { renderPublished } from './Reader';

/**
 * The editor for one published note, shared by the visitor page and the owner's openboard control.
 *
 * It knows nothing about tokens or sessions: the caller injects `onSave`, so the same Edit|View toggle, draft
 * guard, Index rule and stale-save handling serve both surfaces (the design's ruling 7).
 *
 * View renders the *draft* through the reader's own pipeline, so `[[wiki links]]` resolve exactly as they will
 * once saved. On the visitor page `untrustedPreview` is set: a visitor's note becomes untrusted when saved, so
 * previewing it any other way would promise links that stop working (ruling 8).
 */
export interface ObNoteEditorProps {
  note: ObNote;
  payload: ObPayload;
  resolveImage: (vaultId: string, imageId: string) => string;
  /** Saves the draft and resolves to the stored note. Throws for `errorText` to turn into a sentence. */
  onSave: (patch: { title?: string; body: string; baseUpdatedAt: string }) => Promise<ObNote>;
  errorText: (e: unknown) => string;
  onSaved: (note: ObNote) => void;
  onCancel: () => void;
  /** Told whether the draft differs from the note, so the board can ask before dropping it. */
  onDirtyChange?: (dirty: boolean) => void;
  untrustedPreview: boolean;
  titleMax: number;
  bodyMax: number;
}

export function ObNoteEditor({
  note,
  payload,
  resolveImage,
  onSave,
  errorText,
  onSaved,
  onCancel,
  onDirtyChange,
  untrustedPreview,
  titleMax,
  bodyMax,
}: ObNoteEditorProps) {
  const [mode, setMode] = useState<'edit' | 'view'>('edit');
  const [title, setTitle] = useState(note.title);
  const [body, setBody] = useState(note.body);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const bodyId = useId();
  const bodyRef = useRef<HTMLTextAreaElement>(null);

  const isIndex = note.title === INDEX_TITLE;
  const nextTitle = isIndex ? note.title : title.trim();
  const titleChanged = nextTitle !== note.title;
  const bodyChanged = body !== note.body;
  const ready = title.trim().length > 0 && (isIndex || title.trim() !== INDEX_TITLE);

  useEffect(() => {
    onDirtyChange?.(titleChanged || bodyChanged);
  }, [titleChanged, bodyChanged, onDirtyChange]);

  // Typing continues the note: start with the caret at its end.
  useEffect(() => {
    const el = bodyRef.current;
    if (el) el.setSelectionRange(el.value.length, el.value.length);
  }, []);

  // The draft as the reader will see it. `visitorEdited` drives the untrusted-link rules in renderPublished.
  const html = useMemo(() => {
    if (mode !== 'view') return '';
    const draft: ObNote = { ...note, title: nextTitle || note.title, body, visitorEdited: untrustedPreview || note.visitorEdited };
    return renderPublished(draft, payload, resolveImage);
  }, [mode, note, nextTitle, body, untrustedPreview, payload, resolveImage]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    // Nothing to save; an unchanged body is never resent (it may be longer than a visitor may write).
    if (!titleChanged && !bodyChanged) return onCancel();
    setBusy(true);
    setError(null);
    try {
      onSaved(await onSave({ ...(titleChanged ? { title: nextTitle } : {}), body, baseUpdatedAt: note.updatedAt }));
    } catch (err) {
      setError(errorText(err));
      setBusy(false);
    }
  };

  // Escape stays in the editor: the drawer would otherwise close and drop the draft.
  const onKeyDown = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key === 'Escape') e.preventDefault();
  };

  return (
    <form className="ob-editor" onSubmit={submit} onKeyDown={onKeyDown} aria-label={`Edit “${note.title}”`}>
      <div className="ob-editor-bar">
        <div role="group" aria-label="Editor mode" className="segmented" data-mode={mode}>
          <button type="button" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>
            Edit
          </button>
          <button type="button" aria-pressed={mode === 'view'} onClick={() => setMode('view')}>
            View
          </button>
        </div>
      </div>

      <label className="sr-only" htmlFor={titleId}>
        Title
      </label>
      <input
        id={titleId}
        type="text"
        className="input ob-editor-title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={titleMax}
        readOnly={isIndex}
        disabled={busy}
        autoComplete="off"
        spellCheck={prefs.spellcheck()}
      />
      {isIndex && <p className="field-hint">This is the folder’s page, so its title stays.</p>}
      {!isIndex && title.trim() === INDEX_TITLE && <p className="field-hint">“Index” is kept for folder pages. Choose another title.</p>}

      {mode === 'edit' ? (
        <>
          <label className="sr-only" htmlFor={bodyId}>
            Note text
          </label>
          <textarea
            ref={bodyRef}
            id={bodyId}
            className="input ob-editor-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={bodyMax}
            disabled={busy}
            spellCheck={prefs.spellcheck()}
            autoFocus
          />
          <p className="field-hint">Markdown. Link another note with [[Its title]].</p>
        </>
      ) : (
        // Sanitised by DOMPurify in renderPublished, with the same link rules the reader applies.
        <article className="md ob-editor-preview" dangerouslySetInnerHTML={{ __html: html }} />
      )}

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
