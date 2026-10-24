import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normaliseCss } from './cssRules';

// Resolved from this file, not the cwd. (A `?raw` import comes back empty: vitest stubs CSS.)
const read = (f: string) => readFileSync(join(import.meta.dirname, f), 'utf8');

/** The spacing ladder, as tokens.css declares it: name without the `--` prefix to pixels. */
const scale = Object.fromEntries([...read('tokens.css').matchAll(/--(sp-[\d-]+):\s*(\d+)px;/g)].map((m) => [m[1]!, Number(m[2])]));

/** The sheets held to the ladder. Spreading it over the notes app's sheets is a separate job. */
const SHEETS = ['openboard.css', 'openboard-editor.css'];
const SPACING = /^(gap|row-gap|column-gap|(margin|padding)(-(top|right|bottom|left))?)$/;

/**
 * Every gap / margin / padding declaration in `css` that spends a raw pixel instead of a step.
 * Returned as `selector{prop:value}` so a failure names the rule to fix.
 *
 * `1px` passes: a hairline gap is a rule's width, not a spacing step, and DESIGN.md fixes the gap
 * between tree rows at 1px (the notes app's tree uses the same).
 */
function offScale(css: string): string[] {
  const out: string[] = [];
  for (const rule of normaliseCss(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const decl of rule[2]!.split(';')) {
      const at = decl.indexOf(':');
      if (at < 0) continue;
      const prop = decl.slice(0, at);
      const value = decl.slice(at + 1);
      if (SPACING.test(prop) && /(?<![\d.])(?!1px)\d+(\.\d+)?px/.test(value)) out.push(`${rule[1]!.trim()}{${prop}:${value}}`);
    }
  }
  return out;
}

describe('the spacing scale', () => {
  it('is one ladder on a 4px base, with no step between two others', () => {
    expect(scale).toEqual({ 'sp-0-5': 2, 'sp-1': 4, 'sp-1-5': 6, 'sp-2': 8, 'sp-3': 12, 'sp-4': 16, 'sp-6': 24, 'sp-8': 32, 'sp-12': 48 });
  });

  it('names every step for its multiple of 4px, so --sp-4 is always 16px', () => {
    for (const [name, px] of Object.entries(scale)) expect(px, name).toBe(Number(name.slice(3).replace('-', '.')) * 4);
  });

  it('spends no raw pixel on a gap, margin or padding in the openboard sheets', () => {
    for (const f of SHEETS) expect(offScale(read(f)), f).toEqual([]);
  });
});
