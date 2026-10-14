import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PHONE_QUERY } from '../lib/usePhone';
import { cssRules } from './cssRules';

// Resolved from this file, not the cwd. (A `?raw` import comes back empty: vitest stubs CSS.)
const read = (name: string) => readFileSync(join(import.meta.dirname, name), 'utf8');
const phone = read('phone.css');
const rules = (sel: string) => cssRules(phone, sel).join('');

describe('phone.css', () => {
  it('uses the same breakpoint as usePhone', () => {
    expect(phone).toContain(`@media ${PHONE_QUERY}`);
    for (const f of readdirSync(import.meta.dirname).filter((n) => n.endsWith('.css'))) {
      for (const m of read(f).matchAll(/@media \(max-width: (\d+)px\)/g)) {
        expect(['760', '1080']).toContain(m[1]); // 760 is the phone query, 1080 the note panel stack
      }
    }
  });

  it('fills the screen with the dynamic viewport height', () => {
    expect(rules('.shell, .note-layout, .splash, .auth-screen')).toMatch(/min-height:100dvh;/);
  });

  it('pads the topbar and the bottom of the page for the safe area', () => {
    expect(rules('.topbar')).toMatch(/env\(safe-area-inset-top\)/);
    expect(rules('.home, .settings')).toMatch(/env\(safe-area-inset-bottom\)/);
  });

  it('keeps inputs at 16px so iOS does not zoom on focus', () => {
    expect(rules('input, textarea, select')).toMatch(/font-size:16px;/);
  });

  it('gives rows and buttons a 44px target', () => {
    expect(rules('.item, .item-sm, .tree-row, .menu-item')).toMatch(/min-height:44px;/);
    expect(rules('.btn, .btn-sm, .search')).toMatch(/min-height:44px;/);
    // Icon buttons keep their layout size and grow only their hit area.
    expect(rules('.ibtn::after')).toMatch(/inset:-1\d?px;/);
  });

  it('keeps the doc bar in view under the topbar', () => {
    expect(rules('.doc-bar')).toMatch(/position:sticky;/);
    expect(rules('.doc-bar')).toMatch(/top:calc\(48px \+ env\(safe-area-inset-top\)\);/);
  });

  it('keeps wide note content inside the page', () => {
    expect(rules('.md')).toMatch(/overflow-wrap:anywhere;/);
    expect(rules('.md pre')).toMatch(/overflow-x:auto;/);
    expect(rules('.md table')).toMatch(/overflow-x:auto;/);
    expect(rules('.md img')).toMatch(/max-width:100%;/);
  });

  it('drops the map selection ghost where there is no hover', () => {
    expect(phone).toMatch(/@media \(hover: none\)/);
    expect(rules('.cmap-ghost')).toMatch(/display:none;/);
  });
});
