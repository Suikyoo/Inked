import { Transaction, type TransactionSpec } from '@codemirror/state';

/**
 * The transaction that puts an externally supplied document into the editor — opening another note,
 * "Reload theirs", or a body that came back from a save.
 *
 * It is deliberately kept out of the undo history. The editor outlives the note shown in it, so without this
 * an undo right after switching notes would restore the *previous* note's text into the current one, and
 * autosave would then write it there. A controlled `<textarea>` hid this: assigning `value` clears the
 * browser's own undo stack.
 */
export function externalChange(currentLength: number, next: string): TransactionSpec {
  return {
    changes: { from: 0, to: currentLength, insert: next },
    annotations: Transaction.addToHistory.of(false),
  };
}
