import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cssSelectors } from './cssRules';

// Resolved from this file, not the cwd. (A `?raw` import comes back empty: vitest stubs CSS.)
const styles = import.meta.dirname;
const src = join(styles, '..');
const read = (p: string) => readFileSync(p, 'utf8');

/** The sheets an entry imports, in order. */
const sheetsOf = (entry: string) => [...read(join(src, entry)).matchAll(/styles\/([\w-]+\.css)/g)].map((m) => m[1]!);

/** Every class named in a selector of `sheets`. */
function defined(sheets: string[]): Set<string> {
  const out = new Set<string>();
  for (const f of sheets) for (const sel of cssSelectors(read(join(styles, f)))) for (const m of sel.matchAll(/\.([\w-]+)/g)) out.add(m[1]!);
  return out;
}

/** The `.tsx` files directly in `dir` (not its subdirectories), tests excluded. */
function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith('.tsx') && !e.name.includes('.test.'))
    .map((e) => join(dir, e.name));
}

/**
 * The `ob-` / `obe-` classes a component file renders. Both plain and template `className`s are read; inside a
 * template the prefix makes a real class impossible to confuse with the expression around it.
 */
function obClasses(code: string): string[] {
  const words: string[] = [];
  for (const m of code.matchAll(/className=(["'])([^"'{}]*)\1/g)) words.push(...m[2]!.split(/\s+/));
  for (const m of code.matchAll(/className=\{((?:[^{}]|\{[^{}]*\})*)\}/g)) words.push(...m[1]!.split(/[`'"\s]|\$\{|\}/));
  return words.filter((w) => /^obe?-[a-z][a-z0-9-]*$/.test(w));
}

/**
 * Classes the markup carries for JavaScript and the tests to find an element by, never for styling: each sits
 * on an element a shared class already styles (.btn, .ibtn, .ob-row, .obe-checklist) or needs no box of its own.
 */
const HOOKS = new Set(['ob-edit', 'ob-new-note', 'ob-rail-toggle', 'ob-row-folder', 'ob-row-note', 'obe-head-text', 'obe-perm', 'obe-tree-open']);

/** Shared app classes the control's forms are built from; they arrive with settings.css, not openboard-editor.css. */
const BORROWED = ['card', 'row-actions', 'swatches', 'swatch'];

describe('the openboard sheets cover the openboard markup', () => {
  // `openboard/` itself holds the board, reader and rail both pages render; `openboard/publish/` is the
  // notes app's publish dialog and ships with it, not with these pages.
  const entries = [
    { entry: 'openboard/visitor/main.tsx', dirs: ['openboard', 'openboard/visitor'] },
    { entry: 'openboard/editor/main.tsx', dirs: ['openboard', 'openboard/editor'] },
  ];

  it('defines every ob- and obe- class the pages render', () => {
    for (const { entry, dirs } of entries) {
      const have = defined(sheetsOf(entry));
      const missing = new Set<string>();
      for (const dir of dirs) for (const f of sources(join(src, dir))) for (const c of obClasses(read(f))) if (!have.has(c) && !HOOKS.has(c)) missing.add(c);
      expect([...missing].sort(), entry).toEqual([]);
    }
  });

  it('names no hook that a sheet in fact styles, so the list cannot hide a real rule', () => {
    const have = new Set([...defined(sheetsOf('openboard/visitor/main.tsx')), ...defined(sheetsOf('openboard/editor/main.tsx'))]);
    expect([...HOOKS].filter((h) => have.has(h))).toEqual([]);
  });

  it('gives the owner control the app sheet its cards, swatches and action rows come from', () => {
    const have = defined(sheetsOf('openboard/editor/main.tsx'));
    for (const c of BORROWED) expect(have.has(c), c).toBe(true);
  });
});
