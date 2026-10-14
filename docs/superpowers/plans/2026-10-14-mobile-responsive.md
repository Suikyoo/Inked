# Phone-width layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Inked website usable on a phone: search first, concept map behind a "Load map" button, comfortable note reading, touch-sized controls.

**Architecture:** One `usePhone()` hook (the only JS reader of the 760px breakpoint) drives the few structural differences: Home hides the map behind a button, the note's context panel folds into `<details>` rows. Everything else is one new stylesheet, `web/src/styles/phone.css`, loaded last. Drawer swipe is a small separate hook. Desktop behaviour does not change.

**Tech Stack:** React 18, Vite, TypeScript, Vitest 5 + jsdom (tests are `*.test.ts(x)`, jsdom per file via `// @vitest-environment jsdom`), Playwright (MCP) for the browser pass.

**Spec:** `docs/superpowers/specs/2026-10-14-mobile-responsive-design.md` (read it first; its "Corrections after reading the code" section supersedes the earlier text where they differ).

## Global Constraints

- Phone breakpoint is exactly `(max-width: 760px)`. The constant is `PHONE_QUERY` in `web/src/lib/usePhone.ts`. Existing CSS already uses `max-width: 760px`.
- Phone only. At widths above 760px nothing changes: no "Load map" button, the map mounts as today, no `<details>` in the context panel.
- First-visit performance is out of scope. Do not add measurement or tuning work.
- Touch targets at least 44px. Form inputs 16px on phone. `100dvh` instead of `100vh` where a screen is filled. `env(safe-area-inset-*)` on topbar and bottom edges.
- No new dependencies.
- Commit messages follow the repo style (`feat(web): ...`, `test(web): ...`) and end with the line `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Run tests from `web/`: `npx vitest run <file>`. Full suite: `npm test -w web` from the repo root. Baseline before this work: 625 web tests pass.

## Review Focus

- Window is resized across 760px while Home is open (phone to desktop and back): the map must appear when it becomes desktop and the choice to load must not be lost. Pinned in Task 2.
- jsdom and old browsers without `matchMedia`: `usePhone()` must return `false`, never throw, so all existing tests keep desktop behaviour. Pinned in Task 1.
- A phone user with a search term typed or an Ask answer showing, then pressing "Load map": hits and lit nodes must still reach the map. Pinned in Task 2.
- Note with no backlinks and no local map (new note): the folded context rows must still render and open. Pinned in Task 3.
- Edge swipe that starts mid-screen, or is mostly vertical (a scroll), must not open the drawer. Pinned in Task 5.

---

### Task 1: `usePhone()` hook and matchMedia test helper

**Files:**
- Create: `web/src/lib/usePhone.ts`
- Create: `web/src/lib/usePhone.test.tsx`
- Create: `web/src/test/phone.ts`

**Interfaces:**
- Produces: `PHONE_QUERY: string`; `usePhone(): boolean`; test helper `mockPhone(initial: boolean): { set(v: boolean): void; restore(): void }` in `web/src/test/phone.ts`.

- [ ] **Step 1: Write the test helper**

`web/src/test/phone.ts`:

```ts
import { act } from 'react';
import { PHONE_QUERY } from '../lib/usePhone';

/**
 * Installs a window.matchMedia that answers the phone query from `set`, reports reduced motion as on
 * (so motion code stays still in tests) and everything else as off. Call `restore` in afterEach.
 */
export function mockPhone(initial: boolean) {
  const original = window.matchMedia;
  let phone = initial;
  const listeners = new Set<() => void>();
  window.matchMedia = ((query: string) => ({
    get matches() {
      return query === PHONE_QUERY ? phone : query.includes('reduce');
    },
    media: query,
    addEventListener: (_: string, fn: () => void) => {
      if (query === PHONE_QUERY) listeners.add(fn);
    },
    removeEventListener: (_: string, fn: () => void) => {
      listeners.delete(fn);
    },
    addListener: () => undefined,
    removeListener: () => undefined,
    dispatchEvent: () => false,
    onchange: null,
  })) as unknown as typeof window.matchMedia;
  return {
    set(v: boolean) {
      phone = v;
      act(() => listeners.forEach((l) => l()));
    },
    restore() {
      window.matchMedia = original;
    },
  };
}
```

- [ ] **Step 2: Write the failing tests**

`web/src/lib/usePhone.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { mockPhone } from '../test/phone';
import { PHONE_QUERY, usePhone } from './usePhone';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
let restore: (() => void) | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  restore?.();
  restore = null;
});

function Probe() {
  return <p data-testid="p">{usePhone() ? 'phone' : 'wide'}</p>;
}
function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Probe />));
  return () => host!.textContent;
}

describe('usePhone', () => {
  it('queries the 760px breakpoint the CSS uses', () => {
    expect(PHONE_QUERY).toBe('(max-width: 760px)');
  });

  it('reads the current match, and follows a change after mount', () => {
    const mm = mockPhone(true);
    restore = mm.restore;
    const text = mount();
    expect(text()).toBe('phone');
    mm.set(false);
    expect(text()).toBe('wide');
    mm.set(true);
    expect(text()).toBe('phone');
  });

  it('is false where matchMedia does not exist (jsdom, old browsers)', () => {
    const original = window.matchMedia;
    // @ts-expect-error simulate a missing API
    delete window.matchMedia;
    restore = () => {
      window.matchMedia = original;
    };
    expect(mount()()).toBe('wide');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run (from `web/`): `npx vitest run src/lib/usePhone.test.tsx`
Expected: FAIL, cannot resolve `./usePhone`.

- [ ] **Step 4: Implement**

`web/src/lib/usePhone.ts`:

```ts
import { useSyncExternalStore } from 'react';

/** The phone breakpoint. Keep in step with the `max-width: 760px` blocks in styles/*.css (a test checks this). */
export const PHONE_QUERY = '(max-width: 760px)';

const hasMatchMedia = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function';

function subscribe(onChange: () => void): () => void {
  if (!hasMatchMedia()) return () => undefined;
  const mql = window.matchMedia(PHONE_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

const snapshot = () => hasMatchMedia() && window.matchMedia(PHONE_QUERY).matches;

/** True while the viewport is phone width. False when the browser cannot say. */
export function usePhone(): boolean {
  return useSyncExternalStore(subscribe, snapshot, () => false);
}
```

- [ ] **Step 5: Run to verify pass**

Run: `npx vitest run src/lib/usePhone.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/usePhone.ts web/src/lib/usePhone.test.tsx web/src/test/phone.ts
git commit -m "feat(web): usePhone hook for the 760px breakpoint"
```

---

### Task 2: Home hides the map behind "Load map" on a phone

**Files:**
- Modify: `web/src/map/useVaultGraphs.ts` (hook, around lines 36-42)
- Modify: `web/src/pages/HomePage.tsx` (imports; line 145; the `<section className="map">` block at ~line 387)
- Modify: `web/src/styles/home.css` (append a rule)
- Test: `web/src/pages/HomePage.test.tsx` (append)

**Interfaces:**
- Consumes: `usePhone(): boolean` from Task 1, `mockPhone` from `web/src/test/phone.ts`.
- Produces: `useVaultGraphs(state: AppState, enabled = true): MapEntry[]` (returns a shared empty array when `enabled` is false, without building graphs or layouts).

- [ ] **Step 1: Write the failing tests**

In `web/src/pages/HomePage.test.tsx`, add these imports near the other imports:

```tsx
import { mockPhone } from '../test/phone';
import { layoutVault } from '../map/layout';
```

and, directly after the existing imports (before `(globalThis as ...)`), a pass-through spy so layout calls can be counted without changing behaviour:

```tsx
vi.mock('../map/layout', async (orig) => {
  const m = await orig<typeof import('../map/layout')>();
  return { ...m, layoutVault: vi.fn(m.layoutVault) };
});
```

Append at the end of the file:

```tsx
describe('Home on a phone', () => {
  let phone: ReturnType<typeof mockPhone>;
  beforeEach(() => {
    vi.mocked(layoutVault).mockClear();
  });
  afterEach(() => phone?.restore());

  const loadMapButton = () => [...host!.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Load map');

  it('shows search and a Load map button, and builds no map until it is pressed', () => {
    phone = mockPhone(true);
    mount(baseState());
    expect(host!.querySelector('input#q')).not.toBeNull();
    expect(loadMapButton()).toBeDefined();
    expect(host!.querySelector('.cmap')).toBeNull();
    expect(layoutVault).not.toHaveBeenCalled();
    click(loadMapButton()!);
    expect(host!.querySelector('.cmap')).not.toBeNull();
    expect(layoutVault).toHaveBeenCalled();
    expect(loadMapButton()).toBeUndefined();
  });

  it('keeps search results working while the map is hidden', () => {
    phone = mockPhone(true);
    mount(baseState());
    type('alpha');
    expect(column().textContent).toContain('Alpha');
    expect(host!.querySelector('.cmap')).toBeNull();
  });

  it('hands search hits to the map when it is loaded after a search', () => {
    phone = mockPhone(true);
    mount(baseState());
    type('alpha');
    click(loadMapButton()!);
    expect(host!.querySelector('.cmap')).not.toBeNull();
    expect(host!.querySelector('input#q')).toHaveProperty('value', 'alpha');
  });

  it('shows the map at once on a wide screen, with no button', () => {
    phone = mockPhone(false);
    mount(baseState());
    expect(loadMapButton()).toBeUndefined();
    expect(host!.querySelector('.cmap')).not.toBeNull();
  });

  it('mounts the map when the window grows past phone width, and keeps it if it shrinks again', () => {
    phone = mockPhone(true);
    mount(baseState());
    expect(host!.querySelector('.cmap')).toBeNull();
    phone.set(false);
    expect(host!.querySelector('.cmap')).not.toBeNull();
    phone.set(true);
    expect(host!.querySelector('.cmap')).toBeNull();
    click(loadMapButton()!);
    phone.set(false);
    phone.set(true);
    expect(host!.querySelector('.cmap')).not.toBeNull();
  });
});
```

Note: the last test asserts that once the user pressed "Load map" the choice survives a resize round trip. It does not assert that a map shown only because the window was wide stays after shrinking.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/pages/HomePage.test.tsx -t "Home on a phone"`
Expected: FAIL (no button; `.cmap` present on phone).

- [ ] **Step 3: Gate the graph hook**

In `web/src/map/useVaultGraphs.ts`, add a module constant after `EMPTY_TREE` and replace the hook:

```ts
const NO_ENTRIES: MapEntry[] = [];

export function useVaultGraphs(state: AppState, enabled = true): MapEntry[] {
  const cache = useRef<LayoutCache>(new Map());
  const { vaultOrder, vaults, trees, bodies, bodiesReady } = state;
  return useMemo(
    () => (enabled ? mapEntries({ vaultOrder, vaults, trees, bodies, bodiesReady }, cache.current) : NO_ENTRIES),
    [enabled, vaultOrder, vaults, trees, bodies, bodiesReady],
  );
}
```

- [ ] **Step 4: Gate Home**

In `web/src/pages/HomePage.tsx` add the import `import { usePhone } from '../lib/usePhone';`. Replace line 145 (`const mapEntries = useVaultGraphs(state);`) with:

```tsx
  // On a phone the map waits for the "Load map" button; its graphs and layouts are not built before.
  const phone = usePhone();
  const [mapLoaded, setMapLoaded] = useState(false);
  const showMap = !phone || mapLoaded;
  const mapEntries = useVaultGraphs(state, showMap);
```

Replace the map section (the `<section className="map" aria-label="Concept map">` block, ~line 387) with:

```tsx
        {(state.vaultsStatus !== 'ready' || vaults.length > 0) &&
          (showMap ? (
            <section className="map" aria-label="Concept map">
              <ConceptMap entries={mapEntries} neighbours={neighbours} hits={asking ? litIds : hitIds} hot={hot} loading={treesPending} selected={selected} onSelect={setSelected} fitRequest={fitRequest} focusVault={focusVault} saves={saves} onSavesPlayed={onSavesPlayed} searching={asking || q.length > 0} />
            </section>
          ) : (
            <div className="map-load">
              <button type="button" className="btn" onClick={() => setMapLoaded(true)}>
                Load map
              </button>
            </div>
          ))}
```

(Keep the `ConceptMap` props exactly as they are in the file today; the line above is a copy of line 389.)

- [ ] **Step 5: Style the button slot**

Append to `web/src/styles/home.css`:

```css
/* Phone: the map waits behind this button, below the results. */
.map-load {
  order: 2;
  display: flex;
  padding: 8px 0 0;
}
.map-load .btn {
  width: 100%;
}
```

- [ ] **Step 6: Run to verify pass, then the whole Home file**

Run: `npx vitest run src/pages/HomePage.test.tsx`
Expected: PASS, including every earlier Home test.

- [ ] **Step 7: Commit**

```bash
git add web/src/map/useVaultGraphs.ts web/src/pages/HomePage.tsx web/src/styles/home.css web/src/pages/HomePage.test.tsx
git commit -m "feat(web): on a phone, Home keeps the map behind a Load map button"
```

---

### Task 3: Note screen on a phone: folded context rows, sticky doc bar

**Files:**
- Modify: `web/src/pages/NotePane.tsx` (imports; hook call at the top of `NotePane`; the `<aside className="ctx">` block at ~lines 293-334)
- Test: `web/src/pages/NotePane.component.test.tsx` (append)

**Interfaces:**
- Consumes: `usePhone()` from Task 1, `mockPhone` from `web/src/test/phone.ts`.
- Produces: markup contract used by Task 4's CSS: on phone each context section is `<details class="ctx-section ctx-fold"><summary class="ctx-title">…</summary>…</details>`, closed by default. On a wide screen it stays `<section class="ctx-section"><h2 class="ctx-title">`.

- [ ] **Step 1: Write the failing tests**

In `web/src/pages/NotePane.component.test.tsx` add `import { mockPhone } from '../test/phone';` with the other imports, and append:

```tsx
describe('NotePane context panel on a phone', () => {
  let phone: ReturnType<typeof mockPhone>;
  afterEach(() => phone?.restore());

  it('folds the context sections into closed details rows', () => {
    phone = mockPhone(true);
    mount(null);
    const rows = host!.querySelectorAll('aside.ctx details.ctx-fold');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const d of rows) expect((d as HTMLDetailsElement).open).toBe(false);
    expect(host!.querySelector('aside.ctx h2.ctx-title')).toBeNull();
  });

  it('keeps the Backlinks and Properties rows for a note that has no links', () => {
    phone = mockPhone(true);
    mount(null);
    const titles = [...host!.querySelectorAll('aside.ctx summary')].map((s) => s.textContent);
    expect(titles.some((t) => t?.startsWith('Backlinks'))).toBe(true);
    expect(titles).toContain('Properties');
  });

  it('keeps plain sections on a wide screen', () => {
    phone = mockPhone(false);
    mount(null);
    expect(host!.querySelector('aside.ctx details')).toBeNull();
    expect(host!.querySelectorAll('aside.ctx section.ctx-section').length).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/pages/NotePane.component.test.tsx -t "context panel on a phone"`
Expected: FAIL (no `details.ctx-fold`).

- [ ] **Step 3: Implement**

In `web/src/pages/NotePane.tsx`:

1. Add `import { usePhone } from '../lib/usePhone';` and make sure `type ReactNode` is imported from `react` (extend the existing `react` import).
2. Above the `NotePane` function add:

```tsx
/** A context-panel section. On a phone it folds into a closed row so the note stays first. */
function CtxSection({ title, fold, children }: { title: ReactNode; fold: boolean; children: ReactNode }) {
  if (!fold) {
    return (
      <section className="ctx-section">
        <h2 className="ctx-title">{title}</h2>
        {children}
      </section>
    );
  }
  return (
    <details className="ctx-section ctx-fold">
      <summary className="ctx-title">{title}</summary>
      {children}
    </details>
  );
}
```

3. Inside `NotePane`, with the other hook calls at the start of the function and before any early return (the `doc-empty` return near line 183), add `const phone = usePhone();`.
4. Replace the three sections inside `<aside className="ctx" …>` with `CtxSection`:

```tsx
      <aside className="ctx" aria-label="Note context">
        {graph && head && isOnMap(graph, noteId) && (
          <CtxSection title="Local map" fold={phone}>
            <LocalMap graph={graph} noteId={noteId} vaultName={vault.name} vaultColor={vault.color} level={vaultStats(vault, tree).level} />
          </CtxSection>
        )}
        <CtxSection title={`Backlinks${state.bodiesReady[vault.id] ? ` · ${backlinks.length}` : ''}`} fold={phone}>
          {!state.bodiesReady[vault.id] ? (
            <p className="ctx-empty">Looking for notes that link here…</p>
          ) : backlinks.length === 0 ? (
            <p className="ctx-empty">No notes link here yet. Link to this note with [[{head?.title}]].</p>
          ) : (
            backlinks.map((n) => (
              <Link key={n.id} to={`/v/${vault.id}/n/${n.id}`} className="item item-sm">
                {n.title}
              </Link>
            ))
          )}
        </CtxSection>
        {head && (
          <CtxSection title="Properties" fold={phone}>
            <dl className="props">
              <dt>Edited</dt>
              <dd title={head.updatedAt}>{relativeTime(head.updatedAt)}</dd>
              <dt>Created</dt>
              <dd>{formatDate(head.createdAt)}</dd>
              <dt>Length</dt>
              <dd>
                {words} {words === 1 ? 'word' : 'words'}
              </dd>
              <dt>Folder</dt>
              <dd>{crumbs.length ? crumbs.map((c) => c.name).join(' / ') : 'Vault root'}</dd>
            </dl>
          </CtxSection>
        )}
      </aside>
```

- [ ] **Step 4: Run to verify pass, then the NotePane files**

Run: `npx vitest run src/pages/NotePane.component.test.tsx src/pages/NotePane.test.ts src/pages/NotePaneMotion.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/NotePane.tsx web/src/pages/NotePane.component.test.tsx
git commit -m "feat(web): fold the note context panel into rows on a phone"
```

---

### Task 4: Phone stylesheet (touch targets, dvh, safe areas, 16px inputs, reading)

**Files:**
- Create: `web/src/styles/phone.css`
- Modify: `web/src/main.tsx` (add the import after `settings.css`)
- Test: `web/src/styles/phoneCss.test.ts` (create)

**Interfaces:**
- Consumes: `PHONE_QUERY` from Task 1; the `details.ctx-fold` markup from Task 3.
- Produces: `phone.css`, whose rules all sit inside one `@media (max-width: 760px)` block, except a `(hover: none)` block.

- [ ] **Step 1: Write the failing tests**

`web/src/styles/phoneCss.test.ts`:

```ts
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
    expect(rules('.item, .tree-row, .menu-item')).toMatch(/min-height:44px;/);
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/styles/phoneCss.test.ts`
Expected: FAIL, `phone.css` does not exist.

- [ ] **Step 3: Write the stylesheet**

`web/src/styles/phone.css`:

```css
/* ---- Phone: touch size, safe areas, reading ------------------------------------------------
   Everything here applies at the same width as usePhone() (see PHONE_QUERY in lib/usePhone.ts).
   Structure that differs on a phone (the Load map button, the folded context rows) is rendered by
   components; this file only sizes and spaces. Loaded after the other sheets so it wins ties. */
@media (max-width: 760px) {
  /* Dynamic viewport height: the address bar does not hide the bottom of the screen. */
  .shell,
  .note-layout,
  .splash,
  .auth-screen {
    min-height: 100dvh;
  }

  /* Notch and home-indicator room. */
  .topbar {
    height: calc(48px + env(safe-area-inset-top));
    padding-top: env(safe-area-inset-top);
    padding-left: max(10px, env(safe-area-inset-left));
    padding-right: max(10px, env(safe-area-inset-right));
  }
  .topbar .ibtn {
    width: 44px;
    height: 44px;
  }
  .home,
  .settings {
    padding-bottom: calc(24px + env(safe-area-inset-bottom));
  }
  .md,
  .editor {
    padding-bottom: calc(40px + env(safe-area-inset-bottom));
  }

  /* 16px or iOS zooms the page when an input takes focus. */
  input,
  textarea,
  select {
    font-size: 16px;
  }

  /* 44px targets. Rows grow; icon buttons keep their size and grow only the area that takes a tap. */
  .item,
  .item-sm,
  .tree-row,
  .menu-item {
    height: auto;
    min-height: 44px;
  }
  .btn,
  .btn-sm,
  .search {
    min-height: 44px;
  }
  .ibtn,
  .segmented button {
    position: relative;
  }
  .ibtn::after {
    content: '';
    position: absolute;
    inset: -10px;
  }
  .ibtn-sm::after {
    inset: -11px;
  }
  .ibtn-xs::after {
    inset: -12px;
  }
  .segmented button::after {
    content: '';
    position: absolute;
    inset: -10px -2px;
  }
  .ctx .item {
    line-height: 44px;
  }

  /* The doc bar (breadcrumb, save state, edit | view) stays under the topbar while the note scrolls. */
  .doc-bar {
    position: sticky;
    top: calc(48px + env(safe-area-inset-top));
    z-index: 20;
    background: var(--ground);
  }

  /* Reading. */
  .md {
    font-size: 16px;
    overflow-wrap: anywhere;
  }
  .md pre {
    max-width: 100%;
    overflow-x: auto;
  }
  .md table {
    display: block;
    max-width: 100%;
    overflow-x: auto;
  }
  .md img {
    max-width: 100%;
    height: auto;
  }

  /* Context panel rows (rendered as details by NotePane on a phone). */
  .ctx-fold > summary {
    display: flex;
    align-items: center;
    min-height: 44px;
    margin: 0;
    cursor: pointer;
    list-style: none;
  }
  .ctx-fold > summary::-webkit-details-marker {
    display: none;
  }
  .ctx-fold > summary::before {
    content: '›';
    width: 14px;
    color: var(--muted-2);
    transition: transform var(--dur-2) var(--ease-std);
  }
  .ctx-fold[open] > summary::before {
    transform: rotate(90deg);
  }
}

/* The selection ghost answers a hovering pointer; a finger has none. */
@media (hover: none) {
  .cmap-ghost {
    display: none;
  }
}
```

- [ ] **Step 4: Load it last**

In `web/src/main.tsx`, after `import './styles/settings.css';` add `import './styles/phone.css';`.

- [ ] **Step 5: Run to verify pass, then every style test**

Run: `npx vitest run src/styles`
Expected: PASS. If an existing test lists the stylesheets imported by `main.tsx`, update its expectation to include `phone.css`.

- [ ] **Step 6: Commit**

```bash
git add web/src/styles/phone.css web/src/styles/phoneCss.test.ts web/src/main.tsx
git commit -m "feat(web): phone stylesheet for touch targets, safe areas and reading"
```

---

### Task 5: Swipe from the left edge opens the drawer

**Files:**
- Create: `web/src/lib/edgeSwipe.ts`
- Create: `web/src/lib/edgeSwipe.test.tsx`
- Modify: `web/src/components/AppShell.tsx` (imports; after `useIdleLock(...)` at ~line 71)

**Interfaces:**
- Consumes: `usePhone()` from Task 1.
- Produces: `isEdgeSwipe(start: {x:number;y:number}, end: {x:number;y:number}): boolean`; `useEdgeSwipe(enabled: boolean, onSwipe: () => void): void`; constants `EDGE_PX = 24`, `SWIPE_PX = 56`.

- [ ] **Step 1: Write the failing tests**

`web/src/lib/edgeSwipe.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EDGE_PX, SWIPE_PX, isEdgeSwipe, useEdgeSwipe } from './edgeSwipe';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('isEdgeSwipe', () => {
  it('accepts a long, mostly horizontal drag that starts at the left edge', () => {
    expect(isEdgeSwipe({ x: 5, y: 300 }, { x: 5 + SWIPE_PX, y: 310 })).toBe(true);
  });
  it('rejects a drag that starts away from the edge', () => {
    expect(isEdgeSwipe({ x: EDGE_PX + 1, y: 300 }, { x: 200, y: 300 })).toBe(false);
  });
  it('rejects a short drag', () => {
    expect(isEdgeSwipe({ x: 5, y: 300 }, { x: 5 + SWIPE_PX - 1, y: 300 })).toBe(false);
  });
  it('rejects a mostly vertical drag (a scroll)', () => {
    expect(isEdgeSwipe({ x: 5, y: 100 }, { x: 5 + SWIPE_PX, y: 400 })).toBe(false);
  });
  it('rejects a drag to the left', () => {
    expect(isEdgeSwipe({ x: 5, y: 300 }, { x: -50, y: 300 })).toBe(false);
  });
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

function Probe({ enabled, onSwipe }: { enabled: boolean; onSwipe: () => void }) {
  useEdgeSwipe(enabled, onSwipe);
  return null;
}
function touch(type: 'touchstart' | 'touchend', x: number, y: number) {
  const e = new Event(type, { bubbles: true });
  const t = { clientX: x, clientY: y };
  Object.assign(e, { touches: type === 'touchstart' ? [t] : [], changedTouches: [t] });
  act(() => void document.dispatchEvent(e));
}
function mount(enabled: boolean, onSwipe: () => void) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Probe enabled={enabled} onSwipe={onSwipe} />));
}

describe('useEdgeSwipe', () => {
  it('calls back for an edge swipe', () => {
    const fn = vi.fn();
    mount(true, fn);
    touch('touchstart', 4, 300);
    touch('touchend', 120, 310);
    expect(fn).toHaveBeenCalledTimes(1);
  });
  it('ignores a swipe that starts mid-screen', () => {
    const fn = vi.fn();
    mount(true, fn);
    touch('touchstart', 150, 300);
    touch('touchend', 300, 300);
    expect(fn).not.toHaveBeenCalled();
  });
  it('does nothing when disabled', () => {
    const fn = vi.fn();
    mount(false, fn);
    touch('touchstart', 4, 300);
    touch('touchend', 120, 300);
    expect(fn).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/lib/edgeSwipe.test.tsx`
Expected: FAIL, cannot resolve `./edgeSwipe`.

- [ ] **Step 3: Implement**

`web/src/lib/edgeSwipe.ts`:

```ts
import { useEffect, useRef } from 'react';

/** A swipe counts when it starts this close to the left edge… */
export const EDGE_PX = 24;
/** …travels at least this far right… */
export const SWIPE_PX = 56;

export interface Point {
  x: number;
  y: number;
}

/** …and is mostly horizontal (vertical travel at most half the horizontal), so a scroll never opens it. */
export function isEdgeSwipe(start: Point, end: Point): boolean {
  const dx = end.x - start.x;
  return start.x <= EDGE_PX && dx >= SWIPE_PX && Math.abs(end.y - start.y) <= dx / 2;
}

/** Calls `onSwipe` after a swipe in from the left edge. Does nothing while `enabled` is false. */
export function useEdgeSwipe(enabled: boolean, onSwipe: () => void): void {
  const cb = useRef(onSwipe);
  cb.current = onSwipe;
  useEffect(() => {
    if (!enabled) return;
    let start: Point | null = null;
    const down = (e: TouchEvent) => {
      const t = e.touches[0];
      start = e.touches.length === 1 && t ? { x: t.clientX, y: t.clientY } : null;
    };
    const up = (e: TouchEvent) => {
      const t = e.changedTouches[0];
      if (start && t && isEdgeSwipe(start, { x: t.clientX, y: t.clientY })) cb.current();
      start = null;
    };
    document.addEventListener('touchstart', down, { passive: true });
    document.addEventListener('touchend', up, { passive: true });
    return () => {
      document.removeEventListener('touchstart', down);
      document.removeEventListener('touchend', up);
    };
  }, [enabled]);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/lib/edgeSwipe.test.tsx`
Expected: PASS (8 tests).

- [ ] **Step 5: Wire into the shell**

In `web/src/components/AppShell.tsx` add imports `import { useEdgeSwipe } from '../lib/edgeSwipe';` and `import { usePhone } from '../lib/usePhone';`. After the `useIdleLock(...)` line add:

```tsx
  const phone = usePhone();
  useEdgeSwipe(phone && !drawer, () => setDrawer(true));
```

(`drawer` and `setDrawer` are declared just above it.)

- [ ] **Step 6: Run the shell tests**

Run: `npx vitest run src/components/AppShell.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/edgeSwipe.ts web/src/lib/edgeSwipe.test.tsx web/src/components/AppShell.tsx
git commit -m "feat(web): swipe in from the left edge to open the drawer on a phone"
```

---

### Task 6: Pin the map's touch pan and pinch with tests

The map already pans with one pointer and zooms with two (`ConceptMap.tsx` `onPointerDown`/`onPointerMove`; `.cmap-svg` has `touch-action: none`). It has no test for either. This task adds them so later changes cannot break phone use. No production code changes unless a test shows a bug.

**Files:**
- Test: `web/src/map/ConceptMap.test.tsx` (append)

**Interfaces:**
- Consumes: helpers already in that file: `entry`, `base`, `render`, `node(id)` (returns the node `<g>`, whose `transform` is `translate(x y)`), `fire`, `act`.

- [ ] **Step 1: Check the helpers**

Run: `grep -n "^function node\|^const node\|^function render\|^function fire\|^const fire" web/src/map/ConceptMap.test.tsx`
Expected: all four exist. Use their real signatures in Step 2. If `node` is declared inside a `describe`, place the new tests in the same `describe` instead of at the end of the file.

- [ ] **Step 2: Write the tests**

```tsx
describe('touch', () => {
  const svg = () => host!.querySelector<SVGSVGElement>('.cmap-svg')!;
  const ptr = (type: string, id: number, x: number, y: number) =>
    act(() => void svg().dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true })));
  const pos = (id: string) => {
    const m = /translate\(([-\d.]+) ([-\d.]+)\)/.exec(node(id).getAttribute('transform')!)!;
    return { x: Number(m[1]), y: Number(m[2]) };
  };

  it('one finger dragged on empty map pans it', () => {
    render({ entries: [entry(base())] });
    const before = pos('n3');
    ptr('pointerdown', 1, 20, 20);
    ptr('pointermove', 1, 60, 40);
    ptr('pointerup', 1, 60, 40);
    const after = pos('n3');
    expect(after.x - before.x).toBeCloseTo(40, 0);
    expect(after.y - before.y).toBeCloseTo(20, 0);
  });

  it('two fingers moving apart zoom the map', () => {
    render({ entries: [entry(base())] });
    const spread = (id: string) => {
      const a = pos(id);
      const b = pos('n1');
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    const before = spread('n3');
    ptr('pointerdown', 1, 100, 100);
    ptr('pointerdown', 2, 140, 100);
    ptr('pointermove', 2, 220, 100);
    ptr('pointerup', 2, 220, 100);
    ptr('pointerup', 1, 100, 100);
    expect(spread('n3')).toBeGreaterThan(before);
  });
});
```

- [ ] **Step 3: Run**

Run: `npx vitest run src/map/ConceptMap.test.tsx -t "touch"`
Expected: PASS. If the pan assertion fails because the first move is inside the drag threshold (`DRAG_PX`), the code applies the full move on the first move past it (see `onPointerMove`), so the expected values hold; if `PointerEvent` is undefined in jsdom, define it in the test file as `class extends MouseEvent` with `pointerId` and `pointerType` copied from the init. If a test reveals a real bug in pan or pinch, stop and report it instead of patching around it.

- [ ] **Step 4: Run the whole map suite**

Run: `npx vitest run src/map`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/map/ConceptMap.test.tsx
git commit -m "test(web): pin the map's touch pan and pinch zoom"
```

---

### Task 6b: One quiet pump for the selection wave on a phone

Added after the plan was first written. Owner: the selection wave need not be exaggerated; one efficient pump or glow is enough. Assumed to mean phone only (desktop keeps the two-ring wave from `967b9a5`); confirm with the owner.

**Files:**
- Modify: `web/src/styles/phone.css` (inside the `@media (max-width: 760px)` block)
- Test: `web/src/styles/phoneCss.test.ts` (extend)

**Interfaces:**
- Consumes: `.cmap-sel-wave` and `.cmap-sel-wave.is-echo` markup from `ConceptMap.tsx` (two rings per selection; the node sets inline `--wave-scale`, which the phone keyframes ignore).

- [ ] **Step 1: Write the failing test**

Add to `phoneCss.test.ts`:

```ts
  it('plays one short pump for a selection on a phone, with no echo ring', () => {
    expect(rules('.cmap-sel-wave.is-echo')).toMatch(/display:none;/);
    expect(rules('.cmap-sel-wave')).toMatch(/animation:cmap-sel-pump 600ms /);
    expect(phone).toMatch(/@keyframes cmap-sel-pump \{[\s\S]*?to \{[^}]*scale\(1\.5\)/);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/styles/phoneCss.test.ts -t "one short pump"`
Expected: FAIL.

- [ ] **Step 3: Implement**

Inside the phone `@media` block in `phone.css`:

```css
  /* Selection: one short pump from the ring instead of two long waves. The echo is not drawn; the map's own
     fallback timer clears the wave, since the echo's animationend is what normally does. */
  .cmap-sel-wave {
    animation: cmap-sel-pump 600ms cubic-bezier(0.2, 0.7, 0.2, 1) 120ms forwards;
  }
  .cmap-sel-wave.is-echo {
    display: none;
  }
  @keyframes cmap-sel-pump {
    from {
      opacity: 0.55;
      transform: scale(1);
    }
    to {
      opacity: 0;
      transform: scale(1.5);
    }
  }
```

The `from` frame must match how `cmap-sel-wave` starts (read `map.css` `@keyframes cmap-sel-wave`, ~line 540) so the ring starts from the same opacity and origin; adjust the `from` values to match. Reduced motion already hides `.cmap-sel-wave` (map.css), which still wins.

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/styles`
Expected: PASS, including `mapSelCss.test.ts` unchanged.

- [ ] **Step 5: Check in the Task 7 browser pass**

Select a node on a phone viewport: one pump, no second ring, nothing left drawn afterwards, and a second selection plays again.

- [ ] **Step 6: Commit**

```bash
git add web/src/styles/phone.css web/src/styles/phoneCss.test.ts
git commit -m "feat(web): one quiet pump for the selection wave on a phone"
```

### Task 7: Browser pass at phone size and fixes

No new test file; this task is the verification the spec asks for. Fixes found here are small CSS or markup changes, each with a CSS-rule test in `phoneCss.test.ts` when it is a rule worth pinning.

**Files:**
- Modify: whichever `web/src/styles/*.css` files the pass shows need changes (prefer `phone.css`)
- Test: `web/src/styles/phoneCss.test.ts` (extend for each rule added)

- [ ] **Step 1: Start the app**

Run the full local stack from the repo root and wait until it answers:

```bash
docker compose -f compose.yaml -f compose.local.yaml up -d --build
```

The app is then on `http://127.0.0.1:8088`. If Docker is unavailable or the model fetch fails, run `npm run dev:server` and `npm run dev:web` in two terminals (web on `http://localhost:5173`, proxying `/api` to `:8080`); the server needs the environment in `server/` docs. If neither works, stop and ask the owner how they run it locally. Do not mock the server.

- [ ] **Step 2: Resize and visit each screen**

With the Playwright MCP tools, set the viewport to 375×812, then 390×844. Visit, signing in with a test account the owner provides or creates for this purpose: sign-in, Home (empty search), Home after typing a query, Home after pressing Load map, a vault, a note in view mode, the same note after opening the Backlinks row, settings.

- [ ] **Step 3: Check each screen**

For each screen run, via `browser_evaluate`:

```js
() => ({ w: document.scrollingElement.scrollWidth, c: document.scrollingElement.clientWidth })
```

Expected: `w <= c` (no horizontal scroll). Also check with `browser_evaluate` that every visible `button, a, summary` has a hit area of at least 44×44 (width and height from `getBoundingClientRect`, counting a `::after` expansion by testing with `document.elementFromPoint` at the box corners 22px from centre). Take a screenshot of each screen and look at it: text not clipped, nothing overlapping the topbar, doc bar sticks under the topbar while scrolling a long note.

- [ ] **Step 4: Check the drawer**

Open the drawer with the topbar button. Close with the scrim. Open with a swipe: in Playwright, dispatch a `touchstart` at x=4 and a `touchend` at x=140 on `document`, same y. If the browser's own back gesture can fire on a real phone for the same swipe, note it in the report and ask the owner whether to remove the swipe (spec risk).

- [ ] **Step 5: Fix what the pass found**

For each defect: write the CSS rule in `phone.css` (or the owning sheet), add an assertion for it to `phoneCss.test.ts` when it is a rule worth pinning, re-run the screen, confirm. Keep a list of defects and fixes for the report.

- [ ] **Step 6: Run everything**

Run (repo root): `npm test`
Expected: all suites pass (web ≥ 625 plus the new tests; core, server, mcp unchanged).

Run: `npm run build -w web`
Expected: build succeeds with no type errors.

- [ ] **Step 7: Tear down and commit**

```bash
docker compose -f compose.yaml -f compose.local.yaml down
git add -A web/src
git commit -m "fix(web): phone layout fixes from the 375px browser pass"
```

(Skip the commit if the pass found nothing to fix, and say so in the report.)
