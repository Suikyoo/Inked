import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { VIEW_ANIM_MS } from '../map/useViewport';
import { DUR } from '../motion';
import { cssRules } from './cssRules';

// Resolved from this file, not the cwd. (A `?raw` import comes back empty: vitest stubs CSS.)
const read = (f: string) => readFileSync(join(import.meta.dirname, f), 'utf8');
const tokens = read('tokens.css');
const token = (name: string) => tokens.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();

describe('motion tokens', () => {
  it('runs slow enough to read as motion, not a flicker', () => {
    expect(token('--dur-1')).toBe('200ms');
    expect(token('--dur-2')).toBe('320ms');
    expect(token('--dur-3')).toBe('450ms');
    expect(token('--dur-4')).toBe('650ms');
    expect(token('--dur-ink')).toBe('750ms');
  });

  it('gives JS timers the same durations as the CSS tokens', () => {
    for (const k of Object.keys(DUR) as (keyof typeof DUR)[]) expect(token(`--dur-${k}`)).toBe(`${DUR[k]}ms`);
  });

  it('fades a new route in over --dur-3 on the standard curve, so the fade is visible', () => {
    expect(cssRules(read('shell.css'), '.route').join('')).toContain('animation:route-in var(--dur-3) var(--ease-std) backwards;');
  });

  it('glides the map camera instead of snapping it', () => {
    expect(VIEW_ANIM_MS).toBe(600);
  });
});
