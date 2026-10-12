import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cssRules } from './cssRules';

// Resolved from this file, not the cwd. (A `?raw` import comes back empty: vitest stubs CSS.)
const css = readFileSync(join(import.meta.dirname, 'home.css'), 'utf8');
const rules = (sel: string) => cssRules(css, sel).join('');

describe('ask column layout css', () => {
  it('scrolls only the answer, with the same fade as the results column', () => {
    expect(rules('.results.is-ask')).toMatch(/overflow:hidden;/);
    expect(rules('.results, .ask-scroll')).toMatch(/overflow-y:auto;/);
    expect(rules('.results, .ask-scroll')).toMatch(/mask-image:linear-gradient/);
    expect(rules('.ask-scroll')).toMatch(/min-height:0;/);
  });
});
