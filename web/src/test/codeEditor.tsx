import { useEffect, useRef } from 'react';
import type { CodeEditorProps, EditorHandle } from '../editor/CodeEditor';

/**
 * A plain text area standing in for the CodeMirror editor in component tests.
 *
 * It implements the real `EditorHandle` and attaches the same native paste/drop/dragover listeners the real
 * editor does, so a test can drive it with ordinary DOM events and selection calls. What it deliberately does
 * not do is emulate CodeMirror: the editor's own behaviour is covered by `editor/CodeEditor.test.tsx`, and
 * vim key handling is verified in the running app (the design's ruling 11).
 */
export function CodeEditorStub({ value, onChange, handleRef, readOnly, spellCheck, placeholder, ariaLabel, onPaste, onDrop, onDragOver }: CodeEditorProps) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = ref.current;
    if (!ta) return;
    const handle: EditorHandle = {
      body: () => ta.value,
      focus: () => ta.focus(),
      selection: () => ({ start: ta.selectionStart, end: ta.selectionEnd }),
      setSelection: (start, end) => ta.setSelectionRange(start, end),
      replaceRange: (start, end, text) => {
        ta.value = ta.value.slice(0, start) + text + ta.value.slice(end);
        ta.setSelectionRange(start + text.length, start + text.length);
        onChange(ta.value);
      },
    };
    handleRef.current = handle;
    const paste = (e: Event) => onPaste?.(e as ClipboardEvent);
    const drop = (e: Event) => onDrop?.(e as DragEvent);
    const dragover = (e: Event) => onDragOver?.(e as DragEvent);
    ta.addEventListener('paste', paste);
    ta.addEventListener('drop', drop);
    ta.addEventListener('dragover', dragover);
    return () => {
      handleRef.current = null;
      ta.removeEventListener('paste', paste);
      ta.removeEventListener('drop', drop);
      ta.removeEventListener('dragover', dragover);
    };
  });

  return (
    <textarea
      ref={ref}
      className="editor"
      aria-label={ariaLabel}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      readOnly={readOnly}
      spellCheck={spellCheck}
      placeholder={placeholder}
    />
  );
}

/** The last `vim` prop the stub was given, so a test can assert what NotePane passed down. */
export const lastVimProp: { current: CodeEditorProps['vim'] } = { current: null };

/** Use inside `vi.mock('../editor/CodeEditor', ...)`: records the vim prop, then renders the stub. */
export function codeEditorMock() {
  return {
    CodeEditor: (props: CodeEditorProps) => {
      lastVimProp.current = props.vim;
      return <CodeEditorStub {...props} />;
    },
  };
}
