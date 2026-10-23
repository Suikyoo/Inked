# Openboard write links Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Openboard links get a Read (default) or Write permission; Write-link visitors can edit published notes and create notes in the vaults the link grants.

**Architecture:** `ob_links.permission` and `ob_notes.visitor_edited_at` columns (added by an idempotent `ALTER TABLE` path in `openDb`). Two public write routes under `/api/ob/:token/notes` call a new `server/src/openboard/visitor.ts`, guarded by permission, a new per-IP write limiter and the vault grant. The web visitor board keeps its payload in state, adds an edit mode to the reading drawer and a New note dialog; the editor's link dialogs gain a permission choice; the publish dialog warns about visitor edits it would overwrite.

**Tech Stack:** TypeScript, Fastify 5, `node:sqlite`, React 18, Vitest (jsdom for web).

**Spec:** `docs/superpowers/specs/2026-10-24-openboard-write-links-design.md`

## Global Constraints

- Permission values: exactly `'read'` and `'write'`; default `'read'` in the column, the API and the dialog.
- `core/src/openboard.ts` and `server/src/openboard/types.ts` stay identical.
- Visitor writes touch only `ob_notes` rows (and `ob_vaults.updated_at`) of vaults the link grants. Never a private table.
- Visitor title: 1-200 chars, contains a non-space, no `\r` or `\n`. Body: at most 100,000 chars. Vault caps for visitor writes: 5,000 notes, 32 MiB (`32 * 1024 * 1024`) of total `length(body)`; over cap is 413 `vault_full`.
- Write limiter: `new FailureLimiter(30, 60_000, 60_000)`, keyed by IP, `attempt()` per write.
- Visitor bundle stays free of crypto, store and editor code (`npm run check:openboard -w web` after a build).
- Copy follows the existing tone (sentence case, curly quotes, short).

## Review Focus

- Read link sending PATCH/POST: 403 `read_only`, nothing written. Pinned in Task 2.
- Note id from a vault the link does not grant (or another user's vault): 404, nothing written. Pinned in Task 2.
- New note into a folder of a different vault than `vaultId`: 400. Pinned in Task 2.
- Link downgraded to Read while a visitor's page is open: the next save is refused and the UI says editing was turned off. Pinned in Tasks 2 and 6.
- A visitor body with `[evil](https://x)` shown to another visitor: plain text, not a link. Pinned in Task 6.

---

### Task 1: Link permission (core types, schema migration, owner API)

**Files:**
- Modify: `core/src/openboard.ts`, `server/src/openboard/types.ts` (identical edits)
- Modify: `server/src/db.ts` (SCHEMA columns + `migrate(db)` called from `openDb`)
- Modify: `server/src/openboard/store.ts` (`ObLinkRow`, `linkJson`, `createLink`, `updateLink`, `findLinkByToken`)
- Modify: `server/src/routes/openboard.ts` (link schemas)
- Test: `server/test/openboard-links.test.ts`, `server/test/data.test.ts` or new `server/test/migrate.test.ts`

**Interfaces:**
- Produces: `type ObPermission = 'read' | 'write'`; `ObLink.permission: ObPermission`; `ObNote.visitorEdited?: boolean`; `ObPublicResponse.permission: ObPermission`; `PublishConflict.visitorEdits: number`; `findLinkByToken` returns `{ id, label, userId, permission }`; `createLink(db, userId, { label, vaultIds, permission? })`; `updateLink(db, userId, id, { label?, vaultIds?, permission? })`.
- Schema: `ob_links.permission TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read','write'))`; `ob_notes.visitor_edited_at TEXT` (nullable). Both in SCHEMA for new DBs; `migrate` adds each when `PRAGMA table_info` lacks it.

- [ ] Write failing tests: create without permission -> `permission: 'read'`; create with `'write'` -> `'write'`; PATCH `{ permission: 'read' }` flips it; `{ permission: 'admin' }` -> 400; listLinks shows it. Migration: build a DB file with the 2026-10-22 `ob_links`/`ob_notes` definitions (no new columns) plus a link row, run `openDb` twice, assert both columns exist and the row reads `'read'`.
- [ ] Run `npx vitest run test/openboard-links.test.ts test/migrate.test.ts` in `server`: FAIL.
- [ ] Implement types, schema, `migrate`, store and route schema changes (`permission: { type: 'string', enum: ['read', 'write'] }`).
- [ ] Run server tests: PASS. Commit `feat(server): openboard link permission column and API`.

### Task 2: Visitor write routes

**Files:**
- Create: `server/src/openboard/visitor.ts`
- Modify: `server/src/routes/openboardPublic.ts`, `server/src/context.ts` (`obWriteLimiter`), `server/src/app.ts` (construct + prune), `server/src/openboard/store.ts` (`noteJson` adds `visitorEdited`; `grantedPayload` unchanged)
- Test: `server/test/openboard-visitor-write.test.ts`

**Interfaces:**
- Produces in `visitor.ts`: constants `OB_VISITOR_TITLE_MAX = 200`, `OB_VISITOR_BODY_MAX = 100_000`, `OB_VISITOR_VAULT_NOTES_MAX = 5000`, `OB_VISITOR_VAULT_TEXT_MAX = 32 * 1024 * 1024`; `editNoteAsVisitor(db, linkId, noteId, { baseUpdatedAt, title?, body? }): ObNote`; `createNoteAsVisitor(db, linkId, { vaultId, folderId, title, body }): ObNote`. Both run in `transaction`, set `visitor_edited_at`, bump `updated_at` with `bumpTimestamp`, and call the vault touch.
- Routes: `PATCH /api/ob/:token/notes/:noteId`, `POST /api/ob/:token/notes`. Check order: `linkFor` -> `permission !== 'write'` 403 `read_only` -> `obWriteLimiter.attempt(ip)` 429 `locked` with `retry-after` -> grant 404 -> rules. GET payload adds `permission`.
- Errors: 409 `stale` (base mismatch), 400 `invalid_request` (Index rules, folder not in vault, blank title), 413 `vault_full`, 413 `too_large` via schema maxLength on body.

- [ ] Write failing tests (visitor requests carry `x-inked: 1`, no cookie):
  - GET payload has `permission` and notes carry `visitorEdited: false`.
  - write link PATCH body+title -> 200, owner preview shows new text, `visitorEdited: true`, `updatedAt` changed.
  - stale `baseUpdatedAt` -> 409 `stale`, body unchanged.
  - read link PATCH and POST -> 403 `read_only`, nothing changed.
  - note in an ungranted vault (same owner) and a random uuid -> 404.
  - link downgraded via owner PATCH -> next visitor write 403.
  - POST create at vault root and in a folder -> 201, appears in GET payload; folder of another vault -> 400; ungranted vault -> 404.
  - title `Index` on create, rename to `Index`, rename of an Index note -> 400; body edit of an Index note -> 200.
  - title with newline / 201 chars / only spaces -> 400; body 100,001 chars -> 413.
  - 31st write within a minute from one IP -> 429 with `retry-after`; another IP still writes; GET still 200 for the locked IP.
  - vault at 5,000 notes -> create 413 `vault_full` (insert rows directly into the DB to set up).
  - private tables: row counts and `enc_body` of `notes` unchanged after visitor writes.
- [ ] Run: FAIL. Implement. Run server suite: PASS. Commit `feat(server): visitor edits and new notes on write links`.

### Task 3: Publish conflict counts visitor edits

**Files:**
- Modify: `server/src/openboard/store.ts` (`publish` conflict branches)
- Test: `server/test/openboard-publish.test.ts`

**Interfaces:**
- Produces: every `PublishConflictError` carries `visitorEdits` = notes in the target with `visitor_edited_at IS NOT NULL` (vault: all vault rows; folder: notes under the subtree CTE; note: same-title notes in that folder). Error extra includes it.

- [ ] Failing test: publish vault, visitor edits one note through a write link and creates one, republish without overwrite -> 409 with `visitorEdits: 2`; folder and note conflicts count only their target. After overwrite, payload notes have `visitorEdited: false`.
- [ ] Implement; run suite; commit `feat(server): publish conflicts count visitor edits`.

### Task 4: Editor link permission UI

**Files:**
- Modify: `web/src/openboard/api.ts` (`createLink(label, vaultIds, permission)`, `updateLink` patch takes `permission`)
- Modify: `web/src/openboard/editor/NewLinkDialog.tsx` (`PermissionChoice` radio group; `EditVaultsDialog` becomes `EditLinkDialog` with vaults + permission)
- Modify: `web/src/openboard/editor/LinksTab.tsx` (badge "Can edit" / "Read only"; button "Edit")
- Modify: `web/src/openboard/editor/ContentTab.tsx` (visitor-edited tag on tree notes)
- Modify: `web/src/styles/openboard-editor.css`
- Test: `web/src/openboard/editor/EditorPage.test.tsx`

**Interfaces:**
- Produces: `PermissionChoice({ value, onChange, disabled })` exported from `NewLinkDialog.tsx`; radio labels "Read" (hint "Visitors can read the notes.") and "Write" (hint "Visitors can also edit notes and add new ones. Republishing replaces their changes.").

- [ ] Failing tests: New link dialog has Read checked by default and POSTs `permission: 'read'`; choosing Write POSTs `'write'`; link rows show "Read only" / "Can edit"; Edit dialog PATCHes `{ vaultIds, permission }`; content tree shows "Edited by a visitor" for a `visitorEdited` note (preview payload fixture).
- [ ] Implement; run `npx vitest run src/openboard/editor`; commit `feat(web): permission choice on openboard links`.

### Task 5: Publish dialog warns about visitor edits

**Files:**
- Modify: `web/src/openboard/publish/PublishDialog.tsx`
- Test: `web/src/openboard/publish/PublishDialog.test.tsx`

- [ ] Failing test: conflict with `visitorEdits: 2` shows "2 notes there were changed by visitors through edit links. Overwriting discards those changes."; with 0 the sentence is absent; 1 uses "1 note … was changed".
- [ ] Implement; run; commit `feat(web): warn before overwriting visitor edits`.

### Task 6: Visitor editing UI

**Files:**
- Modify: `web/src/openboard/api.ts` (`saveVisitorNote(token, noteId, { baseUpdatedAt, title, body }): Promise<ObNote>`, `createVisitorNote(token, { vaultId, folderId, title, body }): Promise<ObNote>`; anonymous, `X-Inked: 1`, `credentials: 'omit'`; error code read into `ObApiError.code`)
- Modify: `web/src/openboard/Reader.tsx` (`renderPublished(note, payload, resolveImage)` strips non-wiki links when `note.visitorEdited`; tag "Edited by a visitor")
- Create: `web/src/openboard/visitor/NoteEditor.tsx` (title input + textarea, Save/Cancel, errors), `web/src/openboard/visitor/NewNoteDialog.tsx`
- Modify: `web/src/openboard/board.tsx` (`ReaderDrawer` optional `onEdit`, `editing` slot), `web/src/openboard/visitor/VisitorPage.tsx` (payload in state, `permission`, New note button)
- Modify: `web/src/styles/openboard.css`
- Test: `web/src/openboard/visitor/VisitorPage.test.tsx`, `web/src/openboard/Reader.test.tsx`

**Interfaces:**
- `ObApiError` gains optional `code?: string` (server `error` field).
- Messages: 409 `stale` -> "Someone else changed this note while you were editing. Copy your text, then reload the page."; 403 -> "Editing is turned off for this link. Reload the page."; 429 -> existing text; 413 -> "That’s too long to save here."

- [ ] Failing tests: read link shows no Edit or New note; write link: Edit in drawer opens editor with title/body, Save PATCHes with `baseUpdatedAt` + `X-Inked: 1` and no credentials, then the reader shows new text and the rail the new title; Cancel restores; 409 shows stale message and keeps draft; 403 shows turned-off message; New note dialog defaults to the read note's folder, POSTs, opens the new note in edit mode; Reader: visitor-edited body `[x](https://evil.example)` renders without `<a>`, `[[Beta]]` still a button, owner note keeps the link.
- [ ] Implement; run `npx vitest run src/openboard`; commit `feat(web): visitors edit and add notes on write links`.

### Task 7: Docs and verification

**Files:**
- Modify: `docs/architecture.md` (openboard section + API table rows)

- [ ] Update the doc. Run `npm test` in `server` and `web`, `npx tsc -b` in `web`, `npm run build -w web` then `npm run check:openboard -w web`. Browser check on local dev: create write link, edit and create as visitor, downgrade to read, republish warning.
- [ ] Commit `docs: openboard write links`.
