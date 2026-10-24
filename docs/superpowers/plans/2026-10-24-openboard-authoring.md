# Openboard Authoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make openboard a place the owner can write: an Edit|View editor on both openboard surfaces, owner edits against the published copy, and vaults born in openboard with no private source.

**Architecture:** `ob_vaults` gains an `origin` column (`published` | `native`) that gates every create route and keeps `publish()` from ever overwriting native content. Owner write routes reuse the visitor write validation, extracted into `server/src/openboard/write.ts`. One `ObNoteEditor` component serves both surfaces, with the save call injected; its View tab renders the draft through the reader's own `renderPublished`.

**Tech Stack:** TypeScript, Fastify 5, `node:sqlite`, React 18, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-24-openboard-authoring-design.md`

## Global Constraints

- `ob_vaults.origin TEXT NOT NULL DEFAULT 'published' CHECK (origin IN ('published','native'))`, added through `ADDED_COLUMNS` in `server/src/db.ts:187` so existing rows become `'published'`.
- `ob_notes.owner_edited_at TEXT`, added the same way. An owner edit sets it and never touches `visitor_edited_at`.
- `publish()` matches only `origin = 'published'` vaults, and refuses a name held by a native vault with **409 `name_taken`**. It must never reach the overwrite branch for a native vault.
- Create routes (folder, note, vault rename/recolour) are **native vaults only**: 400 `not_native` otherwise. Note *edits* work in any vault.
- `core/src/openboard.ts` and `server/src/openboard/types.ts` are hand-kept copies: every DTO change lands in both, identically.
- The openboard entries ship no crypto, store, session or CodeMirror code. The editor on both surfaces stays a `<textarea>`.
- Caps apply to owner writes as they do to visitors: title 200, body 100,000, 5,000 notes and 32 MiB of note text per vault.
- Every owner route checks vault ownership before anything else; another user's vault is 404, never 403.

## Review Focus

1. **The name collision in both directions.** Publishing onto a native vault's name is the data-loss path, but creating a *native* vault with a published vault's name is the mirror image — the next republish would then collide forever. Both are refused with `name_taken`. Test in Task 2 and Task 4.
2. **A visitor editing a native vault's note.** Native vaults can be put on Write links, so `editNoteAsVisitor` runs against content with no private original. It must still work, and must still set `visitor_edited_at` rather than `owner_edited_at`. Test in Task 3.
3. **An Index note in a native vault.** The Index title is reserved for folder hubs and `publish()` creates them; nothing creates one for a native folder. A native folder with no Index must not break the reader or the map. Test in Task 4.
4. **The owner's own 409.** Two browser tabs on `/openboard`, both editing the same published note: the second save carries a stale `baseUpdatedAt` and must be refused, not silently win. Test in Task 3.
5. **Deleting a native vault.** The route is shared with unpublish and already cascades; the confirm text is the only thing standing between "stop sharing" and "destroy the only copy". Test in Task 7.

---

### Task 1: The schema and the DTOs

**Files:**
- Modify: `server/src/db.ts:99-107` (SCHEMA), `server/src/db.ts:187` (ADDED_COLUMNS), the `ObVaultRow`/`ObNoteRow` types
- Modify: `core/src/openboard.ts`, `server/src/openboard/types.ts` (identical edits)
- Test: `server/test/migrate.test.ts`

**Interfaces:**
- Produces: `ObVault.origin: 'published' | 'native'`; `ObNote.ownerEdited?: boolean`; `PublishConflict.ownerEdits: number`; row types `ob_vaults.origin`, `ob_notes.owner_edited_at`.

- [ ] **Step 1: Write the failing tests**

```ts
it('adds ob_vaults.origin to an existing database, defaulting to published', () => {
  // open a db, insert an ob_vaults row through raw SQL without origin, reopen, read origin
});
it('adds ob_notes.owner_edited_at to an existing database', () => {
  // same shape; the column exists and is null
});
```

Follow `migrate.test.ts`'s existing style for opening a database twice.

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w server -- migrate`
Expected: FAIL — no such column.

- [ ] **Step 3: Add both columns and both DTO fields**

Columns in SCHEMA and in `ADDED_COLUMNS` (no backfill: the defaults are correct). `origin` on `ObVault`, `ownerEdited` on `ObNote`, `ownerEdits` on `PublishConflict`, in both copies of the DTO file.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w server -- migrate`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/db.ts core/src/openboard.ts server/src/openboard/types.ts server/test/migrate.test.ts
git commit -m "feat(server): ob_vaults.origin and ob_notes.owner_edited_at"
```

---

### Task 2: Publish refuses to overwrite native content

**Files:**
- Modify: `server/src/openboard/store.ts:96-160` (`publish`), `store.ts:117-124` (the conflict count)
- Test: `server/test/openboard-publish.test.ts`

**Interfaces:**
- Consumes: Task 1's `origin`, `owner_edited_at`, `PublishConflict.ownerEdits`.
- Produces: `nativeVaultNamed(db, userId, name): boolean` exported from `store.ts`, used by Task 4's vault-create route to refuse the mirror collision.

- [ ] **Step 1: Write the failing tests**

```ts
it('refuses to publish onto a native vault name and leaves its notes alone', async () => {
  // create a native vault "Scratch" with one note (direct SQL insert is fine here)
  // publish a vault named "Scratch" with overwrite: false -> 409 name_taken
  // publish again with overwrite: true -> still 409 name_taken
  // the native vault's note is still present
});
it('counts owner edits in the publish conflict', async () => {
  // publish "Docs"; set owner_edited_at on one note; republish without overwrite
  // -> 409 conflict with ownerEdits: 1
});
it('still republishes over a published vault of the same name', async () => {
  // the existing overwrite behaviour is unchanged
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w server -- openboard-publish`
Expected: FAIL — the publish overwrites the native vault; `ownerEdits` is undefined.

- [ ] **Step 3: Gate the lookup and add the refusal**

`publish`'s vault query gains `AND origin = 'published'`. Before the insert branch, `nativeVaultNamed` short-circuits to `new ApiError(409, 'name_taken', …)` naming the vault. The conflict object gains `ownerEdits: count('ob_notes', ' AND owner_edited_at IS NOT NULL')`.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w server -- openboard-publish`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add server/src/openboard/store.ts server/test/openboard-publish.test.ts
git commit -m "feat(server): publishing never overwrites a native openboard vault"
```

---

### Task 3: Owner note edits

**Files:**
- Create: `server/src/openboard/write.ts`
- Modify: `server/src/openboard/visitor.ts:11-50` (import from `write.ts`, re-export the `OB_VISITOR_*` names)
- Modify: `server/src/openboard/store.ts`, `server/src/routes/openboard.ts`
- Test: `server/test/openboard-owner-write.test.ts` (new)

**Interfaces:**
- Produces, from `write.ts`: `OB_NOTE_TITLE_MAX = 200`, `OB_NOTE_BODY_MAX = 100_000`, `OB_VAULT_NOTES_MAX = 5000`, `OB_VAULT_TEXT_MAX = 32 * 1024 * 1024`, `cleanTitle(title): string`, `checkBody(body): void`, `checkVaultText(db, vaultId, delta): void`, `checkVaultNotes(db, vaultId): void`, `INDEX_TITLE`.
- Produces, from `store.ts`: `editNoteAsOwner(db, userId, noteId, { baseUpdatedAt, title?, body? }): ObNote`.
- `visitor.ts` keeps exporting `OB_VISITOR_TITLE_MAX`, `OB_VISITOR_BODY_MAX`, `OB_VISITOR_VAULT_NOTES_MAX`, `OB_VISITOR_VAULT_TEXT_MAX` as aliases.

- [ ] **Step 1: Write the failing tests**

```ts
it('edits a published note and records it as an owner edit', async () => {
  // PATCH /api/openboard/notes/:id with { baseUpdatedAt, body } -> 200
  // the note's body changed; ownerEdited true; visitorEdited false
});
it('refuses a stale baseUpdatedAt', async () => { /* -> 409 stale */ });
it('404s on another user's note', async () => { /* bob's cookie -> 404 */ });
it('keeps an Index note's title', async () => { /* retitling Index -> 400 */ });
it('refuses a body past the cap', async () => { /* -> 413 too_large */ });
it('leaves visitor_edited_at alone when the owner edits a visitor-edited note', async () => {
  // visitor edits, then owner edits: both flags true
});
it('lets a visitor still edit a note in a native vault', async () => {
  // a Write link over a native vault; PATCH /api/ob/:token/notes/:id -> 200, visitorEdited true, ownerEdited false
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w server -- openboard-owner-write`
Expected: FAIL — route not found (404 from Fastify).

- [ ] **Step 3: Extract the validation, then add `editNoteAsOwner` and its route**

Move the helpers into `write.ts` unchanged apart from their names; `visitor.ts` imports them and re-exports the old constant names. `editNoteAsOwner` mirrors `editNoteAsVisitor` (`visitor.ts:53`) with two differences: ownership is checked by joining `ob_vaults.user_id` instead of the link grant, and the UPDATE sets `owner_edited_at` instead of `visitor_edited_at`. Route: `PATCH /api/openboard/notes/:id` behind `auth`, body schema mirroring the visitor PATCH.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w server -- openboard-owner-write openboard-visitor-write`
Expected: PASS (both files — the extraction must not change visitor behaviour).

- [ ] **Step 5: Commit**

```bash
git add server/src/openboard/write.ts server/src/openboard/visitor.ts server/src/openboard/store.ts server/src/routes/openboard.ts server/test/openboard-owner-write.test.ts
git commit -m "feat(server): the owner can edit a published note"
```

---

### Task 4: Native vaults, folders and notes

**Files:**
- Modify: `server/src/openboard/store.ts`, `server/src/routes/openboard.ts`
- Test: `server/test/openboard-native.test.ts` (new)

**Interfaces:**
- Consumes: Task 2's `nativeVaultNamed`; Task 3's `write.ts` helpers.
- Produces, from `store.ts`: `createNativeVault(db, userId, { name, color }): ObVault`, `updateNativeVault(db, userId, id, { name?, color? }): ObVault`, `createOwnerFolder(db, userId, { vaultId, parentId, name }): ObFolder`, `renameOwnerFolder(db, userId, id, name): ObFolder`, `createOwnerNote(db, userId, { vaultId, folderId, title, body }): ObNote`.

- [ ] **Step 1: Write the failing tests**

```ts
it('creates a native vault that shows up in the content listing', async () => {
  // POST /api/openboard/vaults { name: 'Scratch', color: '#45A89E' } -> 201, origin 'native'
  // GET /api/openboard/content lists it
});
it('refuses a native vault whose name a published vault already holds', async () => { /* -> 409 name_taken */ });
it('refuses a second native vault of the same name', async () => { /* -> 409 name_taken */ });
it('creates a folder and a note in a native vault', async () => {
  // POST folders, POST notes -> 201; the note comes back from /preview with its body
});
it('refuses a folder or a note in a published vault', async () => { /* -> 400 not_native */ });
it('refuses a rename of a published vault', async () => { /* -> 400 not_native */ });
it('renames and recolours a native vault', async () => { /* -> 200 */ });
it('reads a native vault through a read link', async () => {
  // put the native vault on a link; GET /api/ob/:token returns its folder and note
});
it('serves a native folder that has no Index note', async () => {
  // the payload has the folder with no Index; nothing errors
});
it('404s on another user's vault for every create route', async () => { /* bob -> 404 */ });
it('refuses a note past the vault note cap', async () => { /* -> 413 vault_full */ });
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w server -- openboard-native`
Expected: FAIL — routes not found.

- [ ] **Step 3: Implement the five store functions and their five routes**

Each store function runs in a `transaction`, checks ownership first (404), then `origin = 'native'` (400 `not_native`) for everything except note edits, then the `write.ts` caps, then inserts with `randomUUID()` and `nowIso()`, and calls `touchVault`. Vault name checks use `nativeVaultNamed` plus a published-name lookup, both 409 `name_taken`. Notes created here leave `published_title` NULL. Routes mirror the shapes in the spec's API table, all behind `auth` with Fastify body schemas.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w server -- openboard`
Expected: PASS across every openboard test file.

- [ ] **Step 5: Commit**

```bash
git add server/src/openboard/store.ts server/src/routes/openboard.ts server/test/openboard-native.test.ts
git commit -m "feat(server): vaults, folders and notes authored in openboard"
```

---

### Task 5: The shared editor with Edit|View

**Files:**
- Create: `web/src/openboard/ObNoteEditor.tsx`
- Create: `web/src/openboard/ObNoteEditor.test.tsx`
- Modify: `web/src/openboard/api.ts`

**Interfaces:**
- Produces:

```ts
export interface ObNoteEditorProps {
  note: ObNote;
  payload: ObPayload;
  resolveImage: (vaultId: string, imageId: string) => string;
  /** Saves title and/or body and resolves to the stored note. Throws for the caller's error text. */
  onSave: (patch: { title?: string; body: string; baseUpdatedAt: string }) => Promise<ObNote>;
  /** Turns a thrown save error into a sentence for the reader. */
  errorText: (e: unknown) => string;
  onSaved: (note: ObNote) => void;
  onCancel: () => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** True on the visitor page: the draft previews as untrusted, because that is what it becomes. */
  untrustedPreview: boolean;
  titleMax: number;
  bodyMax: number;
}
export function ObNoteEditor(props: ObNoteEditorProps): JSX.Element;
```
- Also from `api.ts`: `saveOwnerNote(noteId, patch)`, `createOwnerVault`, `updateOwnerVault`, `createOwnerFolder`, `createOwnerNote`, each an `owner(...)` call.

- [ ] **Step 1: Write the failing tests**

```ts
it('starts in Edit with the caret at the end of the body', () => {});
it('switches to View and renders the draft, not the saved note', () => {
  // type a heading into the body, switch to View, expect the rendered <h1>
});
it('renders a visitor draft as untrusted: a plain link becomes text', () => {
  // untrustedPreview -> an [x](https://e.com) in the draft renders without an <a>
});
it('resolves a [[wiki link]] in the preview against the live payload', () => {});
it('keeps the draft when switching Edit -> View -> Edit', () => {});
it('reports dirty while the draft differs, and not after', () => {});
it('keeps an Index note's title fixed', () => {});
it('shows the save error text and keeps the draft', () => {});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w web -- ObNoteEditor`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the editor**

The existing `visitor/NoteEditor.tsx` form is the starting point: same fields, same Index rule, same caret-at-end effect, same dirty reporting. Add the `segmented` Edit|View control the notes app uses (`NotePane.tsx:50`), and in View render `renderPublished({ ...note, title, body, visitorEdited: untrustedPreview || note.visitorEdited }, payload, resolveImage)` into a sanitised `dangerouslySetInnerHTML`, the way `Reader` does.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w web -- ObNoteEditor`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/openboard/ObNoteEditor.tsx web/src/openboard/ObNoteEditor.test.tsx web/src/openboard/api.ts
git commit -m "feat(web): one openboard note editor with an Edit|View toggle"
```

---

### Task 6: The visitor page uses it

**Files:**
- Modify: `web/src/openboard/visitor/NoteEditor.tsx`
- Modify: `web/src/openboard/visitor/VisitorPage.test.tsx`

**Interfaces:**
- Consumes: Task 5's `ObNoteEditor`.

- [ ] **Step 1: Update the tests**

Keep every existing assertion in `VisitorPage.test.tsx`. Add:

```ts
it('lets a visitor preview their draft before saving', () => {
  // open the editor on a Write link, type, switch to View, expect rendered markdown
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w web -- VisitorPage`
Expected: FAIL — no View control.

- [ ] **Step 3: Delegate the form**

`NoteEditor` keeps `saveVisitorNote`, `visitorWriteErrorText`, `VISITOR_TITLE_MAX` and `VISITOR_BODY_MAX`, and renders `ObNoteEditor` with `untrustedPreview` true. It needs `payload` and `resolveImage`, which `VisitorPage` already has at the call site (`VisitorPage.tsx:240`).

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w web -- VisitorPage`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add web/src/openboard/visitor/NoteEditor.tsx web/src/openboard/visitor/VisitorPage.test.tsx
git commit -m "feat(web): a visitor can preview a draft before saving it"
```

---

### Task 7: The owner control writes

**Files:**
- Modify: `web/src/openboard/editor/ContentTab.tsx`
- Modify: `web/src/openboard/editor/EditorPage.test.tsx`
- Modify: `web/src/openboard/publish/PublishDialog.tsx`

**Interfaces:**
- Consumes: Task 5's `ObNoteEditor` and the `api.ts` owner calls.

- [ ] **Step 1: Write the failing tests**

```ts
it('offers Edit on a published note and saves through the owner route', () => {});
it('creates a native vault from the Content tab', () => {});
it('warns that a native vault is stored unencrypted', () => {
  // the new-vault form carries the plaintext warning
});
it('badges native vaults in the vault list', () => {});
it('offers New folder and New note only with a native vault selected', () => {});
it('says a native vault is deleted for good, and a published one is only unpublished', () => {
  // the two confirms differ
});
it('names owner edits in the overwrite confirm', () => {
  // a 409 carrying ownerEdits: 2 -> the dialog mentions them
});
it('shows the name_taken message when a publish collides with a native vault', () => {});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w web -- EditorPage PublishDialog`
Expected: FAIL on the new cases.

- [ ] **Step 3: Implement the Content tab additions and the dialog copy**

An Edit button in the drawer's `actions` slot and `ObNoteEditor` in its `body` slot, mirroring `VisitorPage.tsx:232-252`, with `untrustedPreview` false and `onSaved` refetching the preview payload. A New vault form (name + colour, like `SettingsPage`'s `Vaults`) carrying the plaintext warning; a `native` badge in the vault list; New folder / New note shown only for a native vault. `PublishDialog` adds `ownerEdits` to the overwrite confirm and a `name_taken` branch to its error text.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w web -- openboard EditorPage PublishDialog VisitorPage`
Expected: PASS

- [ ] **Step 5: Run every gate**

Run: `npm test` then `npm run build -w web && npm run check:openboard -w web`
Expected: the four suites pass bar the pre-existing `layout.test.ts` perf budget; the build succeeds. `check:openboard` already fails on master for an unrelated hash-wasm chunk (see the vim-mode ledger) — it must not fail for any *new* reason, and in particular not for `openboard.html`.

- [ ] **Step 6: Commit**

```bash
git add web/src/openboard/editor/ContentTab.tsx web/src/openboard/editor/EditorPage.test.tsx web/src/openboard/publish/PublishDialog.tsx
git commit -m "feat(web): author openboard content from the owner control"
```

---

### Task 8: Document it

**Files:**
- Modify: `docs/architecture.md:250-275`

- [ ] **Step 1: Write the section**

Extend the openboard section with: `origin` and what it gates; that an owner edit sets `owner_edited_at`, diverges from the private note, and is discarded by the next republish (which now warns); that a publish colliding with a native vault name is refused; and that native vaults hold the only copy of their content, unencrypted, so deleting one destroys it.

- [ ] **Step 2: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: openboard authoring and native vaults"
```

---

### Task 9: Verify in the running app

**Files:** none.

- [ ] **Step 1: Walk the spec's by-hand list**

Author a native vault with a folder and two linked notes; share it on a Read link and read it as a visitor; edit a published note in the control and confirm the next republish warns before discarding it; confirm a colliding publish is refused rather than overwriting.

- [ ] **Step 2: Record what was seen**

This needs a signed-in browser session. If credentials are unavailable, say so plainly and leave the step unticked rather than claiming it passed.
