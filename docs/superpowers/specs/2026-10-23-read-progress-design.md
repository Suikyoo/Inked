# Read progress — design

Date: 2026-10-23. Status: approved for build (owner asked for autonomous build after the brainstorm).

## Intent

Much of what lands in Inked is written by the AI through the MCP, not by the owner. The owner wants to see, at a glance on
the concept map, how much of each note they have actually read. A golden arc on the note's ring fills as they read and
shrinks again when new text is added to a note they had finished.

This is a personal tracker. It answers "what have I read?" for the signed-in user only.

## Goals

- The browser detects how far the owner has read each note, in steps of 0, 25, 50, 75 and 100 percent.
- The browser reports reached checkpoints to the server, which stores them per user and per note, so progress syncs
  across devices.
- When a note grows after it was read (an MCP append, an edit on another device), its progress drops in proportion.
  Example: a note read to 100 % that doubles in size shows 50 %.
- The owner's own edits in the web app do not lower their progress.
- The concept map draws a golden progress arc on each note dot's ring. Length = progress. No arc at 0 %.
- Network cost stays small: batched writes, no request per scroll event.

## Non-goals

- Progress anywhere other than the concept map (sidebar tree, note header, LocalMap). Can follow later.
- Manual "mark as read / unread" controls.
- Progress for openboard visitors or inside the openboard map.
- Progress for folder Index notes (they have no dot on the map).
- Reads through the MCP (`read_note`) do not count. Only the owner reading in the web app counts.
- Sharing progress with other users. Vaults are single-owner today.

## Anti-goals

- No note content, title, or plaintext-derived value goes to the server. The server stores only ids, a checkpoint
  number and a ciphertext size it already knows. Zero-knowledge stays intact.
- No regression from simple re-renders, title renames, or small noise in size. A note read to 100 % must not flicker to
  75 % because of a rename or a few bytes of ciphertext overhead.
- No chatty network: no write per scroll tick, no write when nothing new was reached.

## Decisions

### Server storage

New table, appended to the `SCHEMA` string in `server/src/db.ts` (created with `CREATE TABLE IF NOT EXISTS`, so no
migration step is needed):

```sql
CREATE TABLE IF NOT EXISTS read_progress (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  note_id    TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  pct        INTEGER NOT NULL,   -- 25, 50, 75 or 100
  read_size  INTEGER NOT NULL,   -- notes.size of the version the checkpoint was reached on
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, note_id)
);
```

`size` is `enc_body.length` (ciphertext body only, set by the server on every write). Title renames do not change it.

### API

- `GET /api/vaults/:id/tree` adds `read: { pct, size } | null` to each note head (LEFT JOIN on `read_progress` for the
  current user). No extra request on load. `NoteHeadDTO` in `inked-core` gains the optional field.
- `POST /api/read-progress` with body `{ items: [{ noteId, pct, size }] }`, 1 to 200 items. `pct` must be one of
  25, 50, 75, 100; `size` a non-negative integer. Requires a signed-in user and the existing `X-Inked: 1` header like
  every non-GET call.
  - Items for notes the user does not own (or that no longer exist) are skipped silently, so a queued item for a note
    deleted meanwhile does not fail the batch.
  - Upsert rule (coverage wins): the server knows the note's current `size`. For the stored row and the new item it
    computes `coverage = min(pct / 100 * read_size, current_size)`. The new item replaces the row when its coverage is
    greater than or equal to the stored one; otherwise the stored row stays. Ties go to the new item (so a shrunk note
    re-anchors to its new size). A stale or delayed write from another device can therefore never lower progress; only
    real growth of the note lowers the shown fraction.
  - Returns `{ ok: true }`.

### Effective progress (client)

Shown progress is computed in the browser from the stored row and the note's current size:

```
fraction = (pct / 100) * read_size / current_size     (clamped to 0..1; 0 when current_size is 0 → treat as 1)
shown    = floor((fraction + 0.03) * 4) * 25           (0, 25, 50, 75 or 100)
```

The 0.03 slack absorbs ciphertext overhead and tiny edits, so a note at 100 % stays at 100 % after a typo fix elsewhere.
One pure function in `web/src` holds this formula, unit-tested.

### Detecting reading (client)

- Two surfaces count, both rendering `<article className="md">`:
  - the note screen's reading view (`web/src/pages/NotePane.tsx`); edit mode (textarea) does not count;
  - the Home page's node preview panel beside the map (`web/src/pages/NodePreview.tsx`), which is likely where the
    owner reads while watching the MCP build notes. Its scroll container differs from the note screen's (the note
    screen scrolls the window). One hook takes the article element and its scroll container.
  - The preview only counts when the body on screen belongs to the current head (the store already drops cached bodies
    when a newer head arrives). Report the size of that head.
  - Moving through dots with the arrow keys must not mark every short note read: the ~1.5 s hold below applies in both
    places, and the hold restarts whenever the shown note changes.
- Reached fraction = how far the bottom of the viewport has passed through the rendered article:
  `(viewportBottom - articleTop) / articleHeight`, clamped to 0..1. If the article's bottom edge is within the viewport,
  the fraction is 1. A note short enough to fit on screen is therefore 100 % read on open.
- Measure on scroll and resize (throttled to about once per 250 ms) and once after the note renders. Only while
  `document.visibilityState === 'visible'`.
- A checkpoint counts once the position has held for about 1.5 s (debounce). This stops a misclick, or arrowing past a
  dot, from marking a note read. Builder's call on the exact timing.
- Checkpoint reached = `floor(fraction * 4) * 25`. Report it only when it is higher than the current *effective* progress
  for this note version. Report `size` = the size of the version on screen (the note head's `size` when the body was
  loaded), not the server's latest, so text added meanwhile is never marked read.
- Images loading late change the article height; the throttled resize/scroll measure handles it. Do not over-engineer.

### Own edits keep progress

When a body save from the note editor succeeds and the note's size changes, the client re-anchors progress: it
records the effective progress shown before the save, against the new size (the server's coverage rule then keeps
whichever covers more). This includes editor saves replayed from the offline queue (`web/src/state/pending.ts`) and
saves the owner makes over a conflicting version.

- A note created through the web app's new-note UI starts at 100 % against its size after its first editor save:
  the owner wrote it.
- A note created from an Ask answer (`web/src/ask/AskAnswer.tsx`) is AI text: it starts unread like an MCP note.
- Renames and moves send no body and do not touch progress.
- Edits by the MCP go through the same server route but never run this client step, so they lower progress as
  intended. Edits in another browser tab or device re-anchor, because that device runs the same client code.
- Future: when PIN lock ships, locking or unlocking re-encrypts the body and changes `size`; that path must re-anchor
  the same way (not a concern for this build).

### Batching

A small client module (`web/src/state/readProgress.ts` or similar) owns a queue keyed by note id:

- Enqueue keeps only the newest entry per note (highest pct for the same size; newest size otherwise).
- The store updates immediately (optimistic), so the map responds at once.
- Flush: every 10 s when the queue is non-empty, on `visibilitychange` to hidden, and on `pagehide` (using
  `fetch(..., { keepalive: true })`; `sendBeacon` cannot send the `X-Inked` header). Also flush before sign-out.
- On a failed flush, put items back unless a newer entry for the same note arrived; retry on the next tick. Drop the
  queue on sign-out or account switch after one flush attempt.
- At most ~4 writes per note version over its life. A read/unread toggle would not be meaningfully cheaper, so the
  five-step design stays.

### Store

`NoteView` in `web/src/state/store.ts` gains `read: { pct: number; size: number } | null`. `openNoteHead` copies it from
the DTO. Local saves keep the head's `read` (then re-anchor as above). When a tree reload replaces a head with a newer one
from elsewhere, take the server's `read` value unless a local queued entry for that note is newer.

### Concept map

- `SceneDot` (`web/src/map/scene.ts`) gains `progress: number` (0, 25, 50, 75, 100), computed from the store via the
  effective-progress function. `GraphNote` / `buildVaultGraph` carry the inputs. Openboard entries have no progress
  (0), so no arcs appear there.
- In `ConceptMap.tsx`, each note dot draws a progress arc at the same radius as its selection ring
  (`selRingRadius(dot.degree)`): a `<circle className="cmap-progress" pathLength={1}>` with
  `stroke-dasharray: <p> 1`, rotated so it starts at 12 o'clock and runs clockwise. Nothing is drawn at 0.
- Layering: the arc sits under the selection ring. When a note is selected, the white selection ring would hide the arc,
  so on selection the arc stays visible just outside the selection ring (builder picks the offset, about
  `GHOST_OUTSET`, consistent with how the hover ghost moves out). Hover ghost and save/click ripples are unchanged.
- The arc animates its length change (about `--dur-2`, `--ease-out`) and honours `prefers-reduced-motion`.
- The dot's `aria-label` gains ", read 75 %" when progress is above 0. Nothing is added at 0.
- Stroke width matches `.cmap-sel` (1.5).

### Colour

New tokens in `web/src/styles/tokens.css`:

- `--gold: #f2c14e` — the progress arc.
- `--gold-done: #f7d27a` — optional brighter tone for a full 100 % ring, if it reads better on screen; builder's call
  after a visual check.

Why this gold: the purple ink `#7452e0` sits at hue ~254°. Its exact complement (~74°) is chartreuse and reads as
green on the dark ground. A warm gold at hue ~42° is a split-complement: it still contrasts strongly with the violet,
reads as "gold" rather than "lime", and stays clear of the existing `--ok` green and `--danger` red. Lightness is high
enough to stand out on `--canvas #1a1920` without glowing harder than the wet-ink glow.

## Known limits (accepted)

- Progress tracks size only. An AI rewrite of about the same length keeps the old progress. An AI rewrite that shrinks
  a partly read note can raise the shown fraction (coverage is capped at the current size). Detecting "changed but not
  grown" would need a per-version marker that tells owner writes from MCP writes; out of scope.
- A prepend counts the same as an append: the shown fraction drops, though the unread text is at the top.

## Constraints

- TypeScript; SQLite via `node:sqlite`; Fastify routes with JSON schema validation like `server/src/routes/notes.ts`.
- Dark theme only (no light tokens exist).
- Vitest for server (`server/test`, `call()` helper) and web (jsdom). TDD.
- Existing tests stay green.

## Left to the builder

- File and function names, exact debounce and throttle timings, the selected-state arc offset, and whether
  `--gold-done` is used.
- Whether the tree endpoint's LEFT JOIN or a small follow-up query fills `read`.
- How the reading-view measurement hooks into `NotePane` / `useNoteEditor` (a hook such as `useReadProgress` is fine).
