import type { ObNote, ObPayload } from 'inked-core';
import { saveVisitorNote, visitorWriteErrorText } from '../api';
import { ObNoteEditor } from '../ObNoteEditor';

/** The server's limits for visitor writes (server/src/openboard/write.ts). */
export const VISITOR_TITLE_MAX = 200;
export const VISITOR_BODY_MAX = 100_000;

/**
 * A Write-link visitor's editor for one published note: its title and its Markdown, with an Edit|View toggle
 * so a draft can be seen rendered before it is saved.
 *
 * Save sends the change with the version it started from, so a note someone else changed meanwhile is
 * refused, not overwritten; the draft stays for the visitor to copy. An Index note keeps its title.
 */
export function NoteEditor({
  token,
  note,
  payload,
  resolveImage,
  onSaved,
  onCancel,
  onDirtyChange,
}: {
  token: string;
  note: ObNote;
  payload: ObPayload;
  resolveImage: (vaultId: string, imageId: string) => string;
  onSaved: (note: ObNote) => void;
  onCancel: () => void;
  /** Told whether the draft differs from the note, so the board can ask before dropping it. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  return (
    <ObNoteEditor
      note={note}
      payload={payload}
      resolveImage={resolveImage}
      onSave={(patch) => saveVisitorNote(token, note.id, patch)}
      errorText={visitorWriteErrorText}
      onSaved={onSaved}
      onCancel={onCancel}
      onDirtyChange={onDirtyChange}
      // A visitor's note is untrusted once saved, so the preview must show it that way.
      untrustedPreview
      titleMax={VISITOR_TITLE_MAX}
      bodyMax={VISITOR_BODY_MAX}
    />
  );
}
