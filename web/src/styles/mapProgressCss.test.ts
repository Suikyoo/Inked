import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cssRules } from './cssRules';

const read = (f: string) => readFileSync(join(import.meta.dirname, f), 'utf8');
const css = read('map.css');
const rules = (sel: string) => cssRules(css, sel).join('');
const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));

describe('map progress arc css', () => {
  it('draws a gold 1.5 stroke arc that eases its length', () => {
    expect(read('tokens.css')).toMatch(/--gold:\s*#f2c14e;/);
    const r = rules('.cmap-progress');
    expect(r).toMatch(/stroke:var\(--gold\);/);
    expect(r).toMatch(/stroke-width:1\.5;/);
    expect(r).toMatch(/fill:none;/);
    expect(r).toMatch(/transition:stroke-dasharray var\(--dur-2\) var\(--ease-out\)/);
  });

  it('drops the transition under reduced motion', () => {
    expect(cssRules(reduced, '.cmap-progress').join('')).toMatch(/transition:none;/);
  });
});
