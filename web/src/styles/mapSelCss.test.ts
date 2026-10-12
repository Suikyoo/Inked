import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cssRules } from './cssRules';

// Resolved from this file, not the cwd. (A `?raw` import comes back empty: vitest stubs CSS.)
const css = readFileSync(join(import.meta.dirname, 'map.css'), 'utf8');
const rules = (sel: string) => cssRules(css, sel).join('');
const reduced = css.slice(css.lastIndexOf('@media (prefers-reduced-motion: reduce)'));

describe('map selection ring css', () => {
  it('draws the ghost as a faint dashed ring that turns', () => {
    expect(rules('.cmap-ghost')).toMatch(/stroke-dasharray:/);
    expect(rules('.cmap-ghost')).toMatch(/animation:cmap-ghost-in [^;]*,cmap-ghost-turn /);
    expect(css).toMatch(/@keyframes cmap-ghost-in\s*\{\s*from\s*\{\s*opacity:\s*0;/);
    expect(rules('.cmap-ghost')).toMatch(/opacity:0\.35;/);
  });

  it('inks a fresh selection ring in from 12 o\'clock and sends a white wave out', () => {
    expect(rules('.cmap-sel.is-inking')).toMatch(/animation:cmap-sel-ink var\(--dur-3\)/);
    expect(rules('.cmap-sel.is-inking')).toMatch(/rotate\(-90deg\)/);
    expect(rules('.cmap-sel-wave')).toMatch(/stroke:var\(--map-sel\);/);
    expect(rules('.cmap-sel-wave')).toMatch(/animation:cmap-sel-wave /);
  });

  it('keeps a still ghost and no wave under reduced motion', () => {
    expect(cssRules(reduced, '.cmap-ghost').join('')).toMatch(/animation:none;/);
    expect(cssRules(reduced, '.cmap-sel-wave').join('')).toMatch(/display:none;/);
  });
});
