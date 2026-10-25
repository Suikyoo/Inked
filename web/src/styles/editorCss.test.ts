import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cssRules } from './cssRules';

// Resolved from this file, not the cwd. (A `?raw` import comes back empty: vitest stubs CSS.)
const css = readFileSync(join(import.meta.dirname, 'note.css'), 'utf8');
const rules = (sel: string) => cssRules(css, sel).join('');

/**
 * The CodeMirror editor shipped with no stylesheet at all, so it rendered in CodeMirror's own light-mode
 * defaults inside a near-black app: a dark caret on dark paper, light-grey selection, the app's type and
 * padding stranded on the wrapper rather than the content, and the global purple focus ring landing on the
 * contenteditable that `.editor:focus-visible` never covered. These pin the contract that fixes it.
 */
describe('note editor css', () => {
  it('puts the app’s editor type on the element that renders the text', () => {
    expect(rules('.editor-cm .cm-scroller')).toMatch(/font:[^;]*var\(--font-mono\)/);
  });

  it('puts the reading padding on the content, not the wrapper', () => {
    expect(rules('.editor-cm .cm-content')).toMatch(/padding:36px 28px 56px;/);
    // The wrapper's own padding has to go, or the two stack.
    expect(rules('.editor-cm')).toMatch(/padding:0;/);
  });

  it('suppresses both focus rings: CodeMirror’s wrapper outline and the global one on the contenteditable', () => {
    expect(rules('.editor-cm .cm-editor.cm-focused')).toMatch(/outline:none;/);
    expect(rules('.editor-cm .cm-content:focus-visible')).toMatch(/outline:none;/);
  });

  it('draws the caret and the selection in the app’s own ink', () => {
    expect(rules('.editor-cm .cm-cursor, .editor-cm .cm-dropCursor')).toMatch(/border-left-color:var\(--ink-light\);/);
    expect(rules('.editor-cm .cm-selectionBackground')).toMatch(/background:var\(--selection\);/);
  });

  it('gives vim’s normal-mode block cursor the ink, so it reads as a cursor and not a highlight', () => {
    expect(rules('.editor-cm .cm-fat-cursor')).toMatch(/background:var\(--ink-light\);/);
  });
});
