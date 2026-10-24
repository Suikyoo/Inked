// @vitest-environment jsdom
import { history, undo } from '@codemirror/commands';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { afterEach, describe, expect, it } from 'vitest';
import { externalChange } from './pushValue';

/**
 * A view with undo history, holding `doc`.
 *
 * Destroyed after each test: CodeMirror schedules a measure on an animation frame, and a view still alive
 * when the test ends measures against jsdom, which has no `getClientRects` — an unhandled error that Vitest
 * warns can turn other tests green dishonestly.
 */
const views: EditorView[] = [];
const viewOf = (doc: string) => {
  const view = new EditorView({ state: EditorState.create({ doc, extensions: [history()] }) });
  views.push(view);
  return view;
};

afterEach(() => {
  while (views.length) views.pop()!.destroy();
});

describe('externalChange', () => {
  it('replaces the whole document', () => {
    const view = viewOf('note A body');
    view.dispatch(externalChange(view.state.doc.length, 'note B body'));
    expect(view.state.doc.toString()).toBe('note B body');
  });

  it('cannot be undone, so a note switch is not undoable into the other note', () => {
    const view = viewOf('note A body');
    view.dispatch(externalChange(view.state.doc.length, 'note B body'));
    undo(view);
    expect(view.state.doc.toString()).toBe('note B body');
  });

  it('leaves the editing user’s own edits undoable', () => {
    const view = viewOf('note B body');
    view.dispatch({ changes: { from: 0, to: 0, insert: 'X' } });
    expect(view.state.doc.toString()).toBe('Xnote B body');
    undo(view);
    expect(view.state.doc.toString()).toBe('note B body');
  });
});
