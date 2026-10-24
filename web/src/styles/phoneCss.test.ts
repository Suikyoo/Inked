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
    expect(rules('.btn, .btn-sm, .search, .brand')).toMatch(/min-height:44px;/);
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

  it('makes the Load map button span the row, and the brand link a full-height target', () => {
    expect(cssRules(read('home.css'), '.map-load').join('')).toMatch(/flex:1 1 100%;/);
    expect(rules('.btn, .btn-sm, .search, .brand')).toMatch(/min-height:44px;/);
  });

  it('keeps the doc bar to one row with a 44px breadcrumb and title', () => {
    expect(rules('.crumbs')).toMatch(/flex:1 1 0;/);
    expect(rules('a.crumb, .crumb-title')).toMatch(/min-height:44px;/);
  });

  it('sizes form controls for a finger', () => {
    expect(rules('.input, .input-sm, .input-wrap, .check')).toMatch(/min-height:44px;/);
    expect(rules('.input-action::after, .swatch::after')).toMatch(/inset:-8px;/);
  });

  it('keeps every text field at 16px, including the ones their own class sets smaller', () => {
    // Type selectors lose to class selectors, so the classed fields are named here.
    expect(rules('.search input, .input, .input-sm, .input-bare, .editor, .tree-rename, .crumb-title')).toMatch(/font-size:16px;/);
  });

  it('does not let icon hit areas overlap neighbours or spill out of their bar', () => {
    expect(rules('.topbar .ibtn::after, .tree-actions .ibtn::after')).toMatch(/content:none;/);
    expect(rules('.tree-actions .ibtn')).toMatch(/width:36px;height:36px;/);
    expect(rules('.tree-actions')).toMatch(/gap:4px;/);
    expect(rules('.vault-row .vault-actions')).toMatch(/top:50%;transform:translateY\(-50%\);/);
  });

  it('puts the map before the results on a phone, but search and Ask answers first', () => {
    const home = read('home.css');
    const order = (sel: string) => cssRules(home, sel).join('');
    expect(order('.map')).toMatch(/order:1;/);
    expect(order('.map-load')).toMatch(/order:1;/);
    expect(order('.results')).toMatch(/order:2;/);
    expect(order(".home-body[data-column='search'] .results, .home-body[data-column='ask'] .results")).toMatch(/order:0;/);
  });

  it('drops the map selection ghost where there is no hover', () => {
    expect(phone).toMatch(/@media \(hover: none\)/);
    expect(rules('.cmap-ghost')).toMatch(/display:none;/);
  });
});

// The openboard pages are their own entries. They were built without this sheet, so their buttons, fields
// and rows kept desktop sizes on a phone and iOS zoomed the page on every focus.
describe('phone.css on the openboard pages', () => {
  const ENTRIES = ['openboard/visitor/main.tsx', 'openboard/editor/main.tsx'];
  const sheetsOf = (entry: string) => [...readFileSync(join(import.meta.dirname, '..', entry), 'utf8').matchAll(/styles\/([\w-]+\.css)/g)].map((m) => m[1]!);

  it('is the last sheet each openboard entry imports, as in the app', () => {
    for (const entry of ENTRIES) {
      expect(sheetsOf(entry), entry).toContain('phone.css');
      expect(sheetsOf(entry).at(-1), entry).toBe('phone.css');
    }
  });

  const ob = (sel: string) => cssRules(read('openboard.css'), sel).join('');
  const obe = (sel: string) => cssRules(read('openboard-editor.css'), sel).join('');

  it('gives the board rows, its bars and the tabs a 44px target', () => {
    expect(ob('.ob-row')).toMatch(/min-height:44px;/);
    expect(ob('.ob')).toMatch(/--bar:48px;/);
    expect(ob('.ob-rail[data-collapsed=\'true\']')).toMatch(/flex-basis:44px;/);
    expect(obe('.obe-tabs')).toMatch(/height:44px;/);
  });

  it('draws the bars’ icon buttons bigger instead of growing a hit area into the row below', () => {
    expect(ob('.ob-rail-head .ibtn, .ob-drawer-bar .ibtn')).toMatch(/width:44px;height:44px;/);
    expect(ob('.ob-rail-head .ibtn::after, .ob-drawer-bar .ibtn::after')).toMatch(/content:none;/);
    expect(obe('.obe-unpublish, .obe-add')).toMatch(/height:36px;/);
  });

  // Which sheet wins a tie is the bundler's CSS chunking, not the import order: in the built visitor page
  // openboard.css lands after phone.css. Every openboard field that sets its own size says so itself.
  it('keeps the fields their own class sizes smaller at 16px, so iOS does not zoom', () => {
    expect(obe('.obe-url')).toMatch(/font-size:16px;/);
    expect(ob('.ob-editor-body')).toMatch(/font-size:16px;/);
    expect(ob('.ob-editor > .ob-editor-title')).toMatch(/font-size:20px;/);
  });

  it('raises the openboard rows that carry a height of their own to a target', () => {
    expect(obe('.obe-check')).toMatch(/min-height:44px;/);
  });

  it('clears the home indicator at the bottom of a page and of the full-screen drawer', () => {
    expect(obe('.obe-page')).toMatch(/env\(safe-area-inset-bottom\)/);
    expect(ob('.md.ob-md')).toMatch(/env\(safe-area-inset-bottom\)/);
    expect(ob('.ob-editor')).toMatch(/env\(safe-area-inset-bottom\)/);
  });
});
