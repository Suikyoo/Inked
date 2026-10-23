# Read Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track how far the owner has read each note (0/25/50/75/100), store it server-side per user and note, and draw it as a golden arc on the note's ring in the concept map.

**Architecture:** Pure progress math lives in `inked-core` (shared by server and web). The server stores one row per (user, note) with the checkpoint and the ciphertext size it was reached on, returns it with the vault tree, and accepts batched writes with a coverage-wins rule. The web app measures reading in the note screen and the Home preview, batches writes through a small queue, keeps progress on `NoteView`, and the map draws an SVG arc from it.

**Tech Stack:** TypeScript, Fastify, `node:sqlite`, React, Vitest (node + jsdom).

**Spec:** `docs/superpowers/specs/2026-10-23-read-progress-design.md`

## Global Constraints

- Checkpoints are exactly 0, 25, 50, 75, 100. The server accepts only 25, 50, 75, 100 (0 is never stored).
- Shown progress: `fraction = pct/100 * read_size / current_size` clamped to 0..1 (current_size 0 → 1); `shown = floor((fraction + 0.03) * 4) * 25`.
- Server coverage rule: `coverage = min(pct/100 * read_size, current_size)`; new item replaces stored row when its coverage ≥ stored coverage.
- Batch: 1..200 items per `POST /api/read-progress`; flush every 10 s when non-empty, on `visibilitychange` → hidden, on `pagehide` (fetch `keepalive: true`), and before sign-out/lock.
- Reading hold before a checkpoint counts: ~1.5 s, restarting when the shown note changes.
- No plaintext-derived value is sent to the server: only note id, pct, ciphertext size.
- Gold token: `--gold: #f2c14e` in `web/src/styles/tokens.css`. Arc stroke width 1.5 (matches `.cmap-sel`).
- Openboard maps show no arcs. MCP code is not touched.
- Existing tests stay green: `npm test` in `core`, `server`, `web`.

## Review Focus

1. A tree reload or `loadNote` arriving after a local checkpoint must not wipe or lower the local `read` (heads are replaced wholesale in `putHead`) — tests in Task 4.
2. Viewing an older body while the head already has a newer, larger size must not mark the new text read (size reported must belong to the body on screen) — tests in Task 5.
3. A failed or offline flush must keep the items and retry, and must not resend after sign-out to another account — tests in Task 3.
4. Selecting a note on the map must keep the gold arc visible next to the white selection ring — test in Task 6.
5. A note that shrinks (current size < read size) shows 100 % and does not throw or show >100 — tests in Task 1.

---

### Task 1: Core progress math

**Files:**
- Create: `core/src/readProgress.ts`
- Create: `core/src/readProgress.test.ts`
- Modify: `core/src/index.ts` (add `export * from './readProgress';`)
- Modify: `core/package.json` exports (add `"./readProgress": "./src/readProgress.ts"`)
- Modify: `core/src/types.ts:27-34` (`NoteHeadDTO` gains `read?: ReadMark | null;`)

**Interfaces:**
- Produces:
  - `type Checkpoint = 0 | 25 | 50 | 75 | 100`
  - `interface ReadMark { pct: number; size: number }`
  - `const STORED_CHECKPOINTS: readonly number[] = [25, 50, 75, 100]`
  - `readCoverage(mark: ReadMark, currentSize: number): number` — `min(pct/100 * size, currentSize)`
  - `preferRead(stored: ReadMark | null | undefined, next: ReadMark, currentSize: number): ReadMark` — returns `next` when `readCoverage(next) >= readCoverage(stored)` or no stored
  - `shownProgress(mark: ReadMark | null | undefined, currentSize: number): Checkpoint` — spec formula; null/undefined → 0
  - `checkpointOf(fraction: number): Checkpoint` — `floor(clamp(fraction,0,1) * 4) * 25`

- [ ] **Step 1: Write failing tests** in `core/src/readProgress.test.ts`:
  - `shownProgress(null, 100) === 0`; `shownProgress({pct:100,size:4000}, 4000) === 100`
  - doubled note: `shownProgress({pct:100,size:4000}, 8000) === 50`
  - slack: `shownProgress({pct:100,size:4000}, 4100) === 100` (ciphertext noise); `shownProgress({pct:100,size:4000}, 4400) === 75`
  - shrink: `shownProgress({pct:50,size:4000}, 1000) === 100`; `shownProgress({pct:100,size:10}, 0) === 100`
  - `checkpointOf(0.24) === 0`, `checkpointOf(0.25) === 25`, `checkpointOf(0.999) === 75`, `checkpointOf(1) === 100`, `checkpointOf(1.7) === 100`, `checkpointOf(-1) === 0`
  - `preferRead`: stale lower on same size keeps stored (`{100,S}` vs `{25,S}` → `{100,S}`); re-anchor after growth wins (`{100,1000}` vs `{100,2000}` at current 2000 → next); tie goes to next (`{100,1000}` vs `{100,800}` at current 800 → `{100,800}`); stale old-version write loses (`stored {100,2000}`, `next {100,1000}`, current 2000 → stored).
- [ ] **Step 2: Run** `cd core && npx vitest run src/readProgress.test.ts` — expect FAIL (module missing).
- [ ] **Step 3: Implement** the functions above in `core/src/readProgress.ts`; add the `read` field to `NoteHeadDTO`; wire exports.
- [ ] **Step 4: Run** `cd core && npm test && npm run typecheck` — expect PASS.
- [ ] **Step 5: Commit** `feat(core): read progress math`.

### Task 2: Server storage and API

**Files:**
- Modify: `server/src/db.ts` (append `read_progress` table from the spec to `SCHEMA`, add index `CREATE INDEX IF NOT EXISTS read_progress_note ON read_progress(note_id);`, add `ReadProgressRow` type)
- Create: `server/src/routes/readProgress.ts`
- Modify: `server/src/app.ts` (register `readProgressRoutes(app, ctx)` next to `noteRoutes`)
- Modify: `server/src/routes/vaults.ts:69-81` (tree query LEFT JOINs `read_progress` on `note_id` and `user_id = current user`)
- Modify: `server/src/routes/access.ts:83-90` (`noteHeadJson` emits `read: { pct, size } | null` when the row carries `read_pct`/`read_size`; other callers that do not select them emit no `read` key)
- Create: `server/test/readProgress.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks. The server does not depend on `inked-core` (it builds with plain `tsc` to `dist`), so the route carries its own small `coverage(pct, readSize, currentSize)` helper with the same formula as the Global Constraints; a comment points at `core/src/readProgress.ts` as the twin.
- Produces: `POST /api/read-progress` body `{ items: { noteId: string(uuid); pct: 25|50|75|100; size: integer ≥ 0 }[] }` (minItems 1, maxItems 200, `additionalProperties: false`) → `{ ok: true }`. Tree note heads gain `read: { pct, size } | null`.

- [ ] **Step 1: Write failing tests** in `server/test/readProgress.test.ts` (reuse `makeApp`, `setupAdmin`, `inviteUser`, `call`, `fakeCipher`; copy the small `createVault`/`createNote` helpers pattern from `data.test.ts`):
  - `tree returns read: null for unread notes`
  - `stores a checkpoint and returns it in the tree` → POST `{noteId, pct:50, size}` then tree head `read` equals `{pct:50,size}`
  - `same size keeps the higher checkpoint` (POST 100 then 25 → 100)
  - `stale write for an older smaller version does not lower progress`: note size S1; POST `{100,S1}`; PUT body to bigger S2; POST `{100,S2}`; POST `{100,S1}` again → tree `read` = `{100,S2}`
  - `skips notes of another user and unknown ids without failing the batch` (other user's note id + random uuid + own note → 200; only own row stored; other user's tree shows `read: null`)
  - `rejects pct 0 or 30, negative size, 0 or 201 items` → 400
  - `requires a session` → 401; `requires X-Inked header` → same status other POST routes return without it
  - `deleting the note removes its progress` (delete note → no row; recreate tree has no stale entry; check via direct DB or that POST for it is skipped)
  - `progress is per user`: two users cannot see each other's rows (covered by the skip test plus tree check).
- [ ] **Step 2: Run** `cd server && npx vitest run test/readProgress.test.ts` — expect FAIL.
- [ ] **Step 3: Implement.** Route: for each item, look up the note with the same ownership join as `ownedNote` but without throwing (skip if absent); read the stored row; `preferRead(stored, item, note.size)`; upsert when the result is the item. Run the whole batch inside `transaction(db, …)`. Tree: select `rp.pct AS read_pct, rp.read_size AS read_size` via `LEFT JOIN read_progress rp ON rp.note_id = notes.id AND rp.user_id = ?`.
- [ ] **Step 4: Run** `cd server && npm test && npx tsc -p tsconfig.json --noEmit` — expect PASS, existing tests green.
- [ ] **Step 5: Commit** `feat(server): store read progress per user and note`.

### Task 3: Web API call and batching queue

**Files:**
- Modify: `web/src/api/client.ts` (`RequestOptions.keepalive?: boolean` passed to `fetch`; `CallOptions.keepalive?: boolean` forwarded by `data()`; `api.saveReadProgress(items: ReadProgressItem[], opts?: CallOptions)` → `POST /api/read-progress`)
- Create: `web/src/state/readProgress.ts`
- Create: `web/src/state/readProgress.test.ts`

**Interfaces:**
- Consumes: `ReadMark` from `inked-core`.
- Produces:
  - `interface ReadProgressItem { noteId: string; pct: number; size: number }`
  - `class ReadProgressQueue` constructor `(send: (items: ReadProgressItem[], opts: { keepalive: boolean }) => Promise<void>, intervalMs = 10_000)`
    - `enqueue(item: ReadProgressItem): void` — one entry per note; a later entry for the same note replaces an earlier one unless same `size` and lower `pct`; starts the interval timer if idle
    - `flush(opts?: { keepalive?: boolean }): Promise<void>` — sends up to 200 per request; on failure re-queues items for notes that got no newer entry meanwhile; no-op when empty or a flush is running (returns the running one)
    - `clear(): void` — drops entries and stops the timer
    - `get size(): number`

- [ ] **Step 1: Write failing tests** (fake timers) in `web/src/state/readProgress.test.ts`:
  - `batches entries and sends once after 10 s`
  - `keeps the higher pct for the same size and the newest size otherwise`
  - `re-queues on failure and retries on the next tick`
  - `a newer entry enqueued during a failed flush wins over the re-queued one`
  - `splits more than 200 entries into several requests`
  - `flush({keepalive:true}) passes keepalive to send`
  - `clear stops the timer and drops entries`
- [ ] **Step 2: Run** `cd web && npx vitest run src/state/readProgress.test.ts` — FAIL.
- [ ] **Step 3: Implement** queue and API call.
- [ ] **Step 4: Run** the test file and `npx tsc -b` in `web` — PASS.
- [ ] **Step 5: Commit** `feat(web): batched read progress queue`.

### Task 4: Store integration

**Files:**
- Modify: `web/src/state/store.ts`
- Modify: `web/src/ask/AskAnswer.tsx:65` (pass `{ read: false }`)
- Test: `web/src/state/store.test.ts` (add `saveReadProgress: vi.fn()` to the hoisted `api` mock; new `describe('read progress')`)

**Interfaces:**
- Consumes: Task 1 functions, Task 3 `ReadProgressQueue`, `api.saveReadProgress`.
- Produces:
  - `NoteView.read?: ReadMark | null`
  - `AppStore.markRead(vaultId: string, noteId: string, pct: Checkpoint, size: number): void` — ignores pct 0; computes `preferRead(head.read, {pct,size}, head.size)`; if the shown progress or stored mark changes, patches the head's `read` (without touching `updatedAt`) and enqueues
  - `AppStore.createNote(vaultId, folderId, title, body = '', opts: { read?: boolean } = {})` — `read` defaults to `true`: sets `read = {pct:100,size:note.size}` and enqueues
  - `AppStore.flushReadProgress(opts?: { keepalive?: boolean }): Promise<void>`

- [ ] **Step 1: Write failing tests:**
  - `loadTree copies read from the DTO`
  - `markRead updates the head and sends one batch after 10 s` (fake timers; `api.saveReadProgress` called with `[{noteId,pct:50,size}]`)
  - `markRead ignores a checkpoint at or below the shown progress`
  - `loadNote keeps the head's read` (putHead with a head lacking `read` keeps `prev.read`) — Review Focus 1
  - `tree reload keeps local read when it covers more than the server's` (server returns `read:null`, local has `{100,S}` → stays) — Review Focus 1
  - `saveNoteBody re-anchors: a note shown at 100 stays 100 after the owner grows it`
  - `saveNoteBody re-anchor keeps 50 when the note was half read`
  - `createNote marks the new note read; createNote with {read:false} does not`
  - `a queued save replayed later re-anchors` (refreshNoteHead after `saved`)
  - `signOut flushes pending progress before dropping keys, then clears the queue` — Review Focus 3
- [ ] **Step 2: Run** `cd web && npx vitest run src/state/store.test.ts -t "read progress"` — FAIL.
- [ ] **Step 3: Implement:**
  - `openNoteHead` copies `read: n.read ?? null`.
  - `putHead`: when the new head has no `read` key (`read === undefined`), carry `prev.read`; when both exist, keep `preferRead(prev.read, head.read, head.size)` (null-safe).
  - `loadTree` merge: same rule for heads it keeps from the response.
  - `saveNoteBody` and the `saved` branch of `sendQueued` → `refreshNoteHead(…, { reanchor: true })`: before storing the new head, take `p = shownProgress(prev.read, prev.size)`; if `p > 0`, new `read = {pct:p,size:note.size}` and enqueue it.
  - The store owns one `ReadProgressQueue` sending via `api.saveReadProgress(items, { keepalive })` with the current user only (skip when signed out). `registerFlusher` flushes it on lock/sign-out; `dropKeys` calls `clear()`. Add `visibilitychange`(hidden) and `pagehide` listeners in the constructor's browser setup (follow the existing `beforeunload` pattern near `store.ts:345`) calling `flushReadProgress({keepalive:true})`.
- [ ] **Step 4: Run** `cd web && npx vitest run src/state` — PASS (whole state folder, existing tests green).
- [ ] **Step 5: Commit** `feat(web): keep read progress on note heads`.

### Task 5: Reading detection hook, wired into NotePane and NodePreview

**Files:**
- Create: `web/src/pages/useReadProgress.ts`
- Create: `web/src/pages/useReadProgress.test.tsx`
- Modify: `web/src/pages/NotePane.tsx` (view-mode `<article>` at ~line 331)
- Modify: `web/src/pages/NodePreview.tsx` (`Markdown` gets optional `track?: { noteId: string; size: number | null }`; pass it only in the `selection.kind === 'note'` branch, line ~159)

**Interfaces:**
- Consumes: `store.markRead`, `checkpointOf`.
- Produces:
  - `readFraction(article: { top: number; height: number }, viewport: { top: number; bottom: number }): number` — `(viewport.bottom - article.top) / article.height` clamped 0..1; returns 1 when `article.top + article.height <= viewport.bottom` or height ≤ 0
  - `useReadProgress(articleRef: RefObject<HTMLElement | null>, target: { vaultId: string; noteId: string; size: number | null } | null): void` — `null` target or `size === null` disables tracking. Scroll container = nearest ancestor with computed `overflow-y` `auto`/`scroll`, else window. Listens to scroll (on that container) and resize, throttled ~250 ms; measures once after mount/html change; only while `document.visibilityState === 'visible'`. Holds the highest fraction seen; after it has stood ~1.5 s, calls `store.markRead(vaultId, noteId, checkpointOf(fraction), size)`. Changing `noteId` or `size` resets the hold.
- Size rule (Review Focus 2): callers pass `size = state.bodies[noteId] === shownBody ? head.size : null`. NotePane: `shownBody = editor.body`, only in view mode; NodePreview: body is `state.bodies[n.id]`, so `size = n.size` when the body is defined, else `null`.

- [ ] **Step 1: Write failing tests:**
  - `readFraction`: fits on screen → 1; halfway → 0.5; not reached → 0; zero height → 1
  - hook (jsdom, fake timers, stub `getBoundingClientRect` and `window.innerHeight`): `marks 100 after the hold for a note that fits on screen`; `does not mark before the hold elapses`; `a note change before the hold resets it` (arrowing past dots); `size null disables tracking`; `hidden document does not count`; `scrolling to halfway marks 50`
  - NotePane component test (extend `NotePane.component.test.tsx` style): `edit mode does not mark`; `stale body (store body differs from shown) does not mark` — Review Focus 2
- [ ] **Step 2: Run** `cd web && npx vitest run src/pages/useReadProgress.test.tsx` — FAIL.
- [ ] **Step 3: Implement** the hook and wire both call sites.
- [ ] **Step 4: Run** `cd web && npx vitest run src/pages` — PASS.
- [ ] **Step 5: Commit** `feat(web): detect reading in the note view and map preview`.

### Task 6: Golden progress arc on the concept map

**Files:**
- Modify: `web/src/map/graph.ts` (`GraphNote.progress: Checkpoint`; `buildVaultGraph` sets `progress: shownProgress(n.read, n.size)`)
- Modify: `web/src/map/scene.ts` (`SceneDot.progress: Checkpoint`, copied in `buildScene`)
- Modify: `web/src/map/ConceptMap.tsx` (~line 884 and the dot `aria-label` ~line 860)
- Modify: `web/src/styles/tokens.css` (map section near line 45: `--gold: #f2c14e;`)
- Modify: `web/src/styles/map.css` (`.cmap-progress`)
- Test: `web/src/map/graph.test.ts`, `web/src/map/scene.test.ts`, `web/src/map/ConceptMap.test.tsx`, `web/src/styles/mapSelCss.test.ts` (or a new `mapProgressCss.test.ts` following `cssRules.ts` helpers)

**Interfaces:**
- Consumes: `shownProgress`, `Checkpoint` from `inked-core`; `NoteView.read`.
- Produces: `<circle className="cmap-progress" r={…} pathLength={1} style={{ strokeDasharray: \`${p/100} 1\` }} />` drawn before `selRing(...)`, rotated `-90deg` so it starts at 12 o'clock and runs clockwise; omitted at progress 0. When the dot is selected, radius = `selRingRadius(dot.degree) + GHOST_OUTSET` (outside the white ring) else `selRingRadius(dot.degree)`. If the hover ghost uses the same outset when selected, use a slightly larger offset so both stay distinct (builder's call; note it in the commit).

- [ ] **Step 1: Write failing tests:**
  - graph: `progress comes from read and current size` (`{pct:100,size:100}` at size 200 → 50); missing read → 0
  - scene: dot carries `progress`
  - ConceptMap: `draws no progress arc at 0`; `draws an arc with dasharray "0.75 1" at 75`; `selected note keeps the arc outside the selection ring` (arc `r` > `.cmap-sel` `r`) — Review Focus 4; `aria-label mentions read 75 %`; openboard-style entries (no `read`) draw no arcs
  - CSS: `.cmap-progress` uses `stroke: var(--gold)`, `stroke-width: 1.5`, `fill: none`, has a `stroke-dasharray` transition, and the reduced-motion block removes the transition; `--gold` is `#f2c14e` in tokens
- [ ] **Step 2: Run** `cd web && npx vitest run src/map src/styles` — FAIL.
- [ ] **Step 3: Implement.** Transition `stroke-dasharray var(--dur-2) var(--ease-out)`; add to the existing `prefers-reduced-motion` block in `map.css` (~line 544). `transform: rotate(-90deg)` on the circle (SVG circles start at 3 o'clock).
- [ ] **Step 4: Run** `cd web && npm test && npx tsc -b` — PASS.
- [ ] **Step 5: Commit** `feat(map): golden read progress arc on note rings`.

### Task 7: End-to-end check in the browser

**Files:** none (verification only; fix anything found inside the owning task's files).

- [ ] **Step 1:** Start the dev server per the project README / `.claude/launch.json` (create a launch config if none). Sign in with local test credentials from the project's seed/dev setup.
- [ ] **Step 2:** Open a long note in view mode, scroll to the bottom, wait 2 s, return to Home: the dot shows a full gold ring. Check the network panel: one `POST /api/read-progress` within ~10 s, not one per scroll.
- [ ] **Step 3:** Append text through the MCP or another tab so the note doubles: after the tree reloads, the ring shows half.
- [ ] **Step 4:** Select the dot: gold arc stays visible outside the white ring. Screenshot at desktop and phone width (≤760 px).
- [ ] **Step 5:** Run all suites: `cd core && npm test`, `cd server && npm test`, `cd web && npm test`. All PASS.
