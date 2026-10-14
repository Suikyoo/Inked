# Inked web: phone-width layout: design

Date: 2026-10-14. Status: design approved section by section in conversation; awaiting review of this written spec.

## Goal

Make the existing Inked website usable on a phone. The owner mostly wants to **find and read notes** on a phone. Editing must still work, but it is secondary.

This is responsive web only. A native or wrapped mobile app is a future project (it would cache the indexed files on the device). Nothing in this spec prepares for it beyond keeping the web code clean.

## Decisions (owner's answers)

| Question | Decision |
|---|---|
| Form of the mobile version | Responsive behaviour of the website. Mobile app is a later project. |
| Main phone use | Find and read notes. |
| Home on a phone | Search bar on top, then a concept map that is **hidden behind a "Load map" button**. |
| Where the map appears after the tap | **Inline**, in the same place on Home. No full-screen sheet. |
| Does desktop get "Load map" too | **No.** Phone only. Desktop keeps the map auto-loaded. |
| Performance on first visit | **Out of scope.** A web app is limited here. The future mobile app addresses it. |
| Approach | Extend the existing layout (approach A): finish and verify the phone rules that exist, add the missing structure. No new navigation model (no bottom tab bar). |

## What exists today

Phone support is partial, not absent. At `max-width: 760px` the CSS already:

- turns the sidebar into a drawer with a sticky 48px topbar and a scrim (`shell.css`, `AppShell.tsx`);
- puts search results above the map on Home and shrinks the map to `aspect-ratio: 100 / 60` (`home.css`, `map.css`);
- reduces note and settings padding (`note.css`, `settings.css`);
- always shows tree row actions (no hover needed).

The context panel (`.ctx`) already stacks under the note at `max-width: 1080px`.

There is no JS viewport detection except `prefers-reduced-motion`.

## Design

### 1. Home on a phone

Order, top to bottom: search bar, Ask, results, **Load map** button.

- Before the button is pressed, none of these run: `useVaultGraphs`, the `dotIds` and `neighbours` derivations that depend on it, and the `ConceptMap` component. `hitIds` needs only note ids from the search rows, so it stays ungated.
- After the press, `ConceptMap` mounts inline in the same slot. The choice lives in component state only, so a new visit starts hidden again.
- Touch in the inline map: one-finger drag pans, two-finger pinch zooms, a tap selects a node. The SVG gets `touch-action: none` and uses pointer events. The hover ghost and click-to-replay added in `967b9a5` apply only under `@media (hover: hover)`.
- The vault route renders the same Home page with a vault focused, so the button applies there too.
- Desktop (`>760px`) is unchanged.

Risk: `ConceptMap.tsx` has its own pointer-drag code (`useSpringDrag`). Pinch and touch pan must not change desktop spring-drag behaviour. Tests cover this.

### 2. Vault and note reading

- The sticky topbar also shows the current note title, truncated, so the reader keeps their place after scrolling.
- `.doc-bar` (edit | view toggle) gets 44px touch targets. View mode is the default on a phone. Edit stays reachable.
- Note body (`.md`): 16px base size, `overflow-wrap: anywhere`. Code blocks and tables scroll inside their own box, never the page. Images use `max-width: 100%`.
- Context panel on a phone: backlinks and the local map become collapsed expandable rows below the note, so the note comes first. The local map there is also behind "Load map".
- Drawer: keeps closing on navigation and on scrim tap. Add swipe-from-left-edge to open. Tree rows get a 44px minimum height.
- Settings and sign-in pages: audit only. Fix overflow and target size. No redesign.

### 3. Touch rules

One phone block in `base.css`:

- `100dvh` instead of `100vh` where the layout fills the screen;
- `env(safe-area-inset-*)` padding on the topbar and bottom edges;
- form inputs at 16px, so iOS does not zoom on focus;
- 44px minimum size for buttons, tree rows and menu items;
- hover-only affordances move behind `@media (hover: hover)`.

### 4. One breakpoint, one source of truth

A new `usePhone()` hook wraps `matchMedia('(max-width: 760px)')` and is the only JS reader of the phone breakpoint. CSS cannot import the constant, so a test asserts that the exported `PHONE_QUERY` matches the `max-width` of the phone blocks in the CSS files.

## Testing

Test-first, following the existing patterns.

- Vitest: `usePhone()` with a mocked `matchMedia`, including a viewport change after mount.
- Vitest: on a phone, `HomePage` does not mount `ConceptMap` and does not compute `useVaultGraphs` until "Load map" is pressed; after the press it mounts once. On desktop it mounts as before and shows no button.
- Vitest: the `cssRules.test.ts` pattern gains assertions that the phone block contains the 44px, 16px, `dvh` and safe-area rules, and that `PHONE_QUERY` matches the CSS.
- Vitest: pointer-drag tests in `ConceptMap.test.tsx` keep passing; add a two-pointer pinch test.
- Playwright at 375×812 and 390×844 on Home, a vault, a note, settings and sign-in: assert `document.scrollingElement.scrollWidth <= clientWidth`, and take a screenshot of each for review.
- Existing suites (`npm test`) must pass unchanged on desktop behaviour.

## Out of scope

PWA install and offline, bottom tab bar, native or wrapped app, first-visit performance work, touch-optimised editing (toolbar, keyboard avoidance), tablet-specific layouts, landscape-specific layouts.

## Open risks

- Pinch zoom in `ConceptMap` may interact with the existing viewport and spring-drag code. Found by the new tests and the Playwright pass.
- Swipe-from-edge can clash with the browser's own back gesture on some phones. If it does in testing, drop the swipe and keep the topbar button.
