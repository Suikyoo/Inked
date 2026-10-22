# Openboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an owner publish decrypted vaults, folders and notes to a separate public store, share them through secret whimsy-slug links, and manage it all from a separate editor UI; visitors get a read-only map, tree rail and reading drawer.

**Architecture:** New plaintext tables in the server DB, filled by the browser from the main app (the only place with vault keys). Owner API under `/api/openboard/*` (session cookie), public read API under `/api/ob/:token/*`. Two new web entry pages (`openboard.html` visitor, `openboard-editor.html` editor) share one read-only map component extracted from the notes app; neither imports crypto or the store.

**Tech Stack:** Fastify 5 + `node:sqlite` (server), React 18 + Vite 8 multi-page build + react-router 7 (web), Vitest 5, markdown-it + DOMPurify, existing sandboxed mermaid frame.

**Spec:** `docs/superpowers/specs/2026-10-22-openboard-design.md`

## Global Constraints

- Private tables and ciphertext are never modified or read by any openboard code path.
- Link token format: `<adjective>-<animal>-<scene>-<suffix>`, e.g. `gratifying-beaver-in-the-sun-7k3q9x2mp4rt`; scene is a fixed phrase like `in-the-sun`; picked with `crypto.randomInt` / `crypto.randomBytes`. The suffix is **12** base32 chars (lowercase `a-z2-7`, 60 bits). The spec says 8 chars but its own "80+ bits" target needs 12; this plan overrides that one number.
- Unknown token and deleted token return the identical `404 { error: 'not_found' }`; failed lookups are rate limited per IP.
- Overwrite is a true replace (not merge); a vault overwrite keeps the published vault id so link grants survive. Conflict identity is the name chain (vault name, folder names, note title).
- Images: png, jpeg, gif, webp only, max 10 MiB (`IMAGE_BLOB_MAX` semantics from the private route, but for plaintext bytes); SVG rejected; sniff magic bytes, never trust the client content type.
- Publishing happens only from the main app. Editor and visitor bundles must not import `inked-core` crypto, `hash-wasm`, `state/store`, or `@huggingface/transformers`.
- Visitors get title search only: no Ask, no semantic search. Preview in the editor uses an owner-authed endpoint and does not count views.
- All non-GET requests carry `X-Inked: 1` (existing CSRF rule). Public GETs need no cookie.
- UI copies the Inked look (`DESIGN.md` tokens); visitor layout is tree rail + map + right reading drawer.
- `[[link]]` to a note outside the link's granted published content renders as plain text and creates no map edge.

## Review Focus

1. A link for vault A must never return vault B's notes or images, even when the visitor guesses ids; another user's content must never appear in any owner endpoint. (Tasks 3, 4)
2. A wrong, malformed or deleted token must look identical and get locked out after repeated failures. (Task 4)
3. Declining the overwrite changes nothing; a publish that fails midway leaves the old content intact (single transaction). (Task 2)
4. Hostile note content (`<script>`, `javascript:` links, raw HTML) renders inert, and a file with SVG bytes or a wrong magic number is rejected as an image. (Tasks 3, 7)
5. A link granting zero vaults, a published vault with zero notes, and duplicate sibling names or non-ASCII names must not crash the map or the tree. (Tasks 2, 6, 7)

---

## File Structure

Server (`server/`):
- `src/db.ts` — modify: add `ob_*` tables to `SCHEMA`.
- `src/openboard/words.ts` — create: word lists.
- `src/openboard/token.ts` — create: `generateLinkToken`.
- `src/openboard/store.ts` — create: all SQL for published content, links, payloads.
- `src/routes/openboard.ts` — create: owner routes.
- `src/routes/openboardPublic.ts` — create: token routes.
- `src/context.ts`, `src/app.ts` — modify: `obLimiter`, route registration, HTML entry routing.
- `test/openboard-*.test.ts` — create per task.

Core (`core/src/openboard.ts`): shared DTO types, exported from `core/src/index.ts` (type-only use by server).

Web (`web/`):
- `openboard.html`, `openboard-editor.html`, `vite.config.ts` (multi-page input + manifest).
- `src/map/ConceptMap.tsx` — modify: drop `useNavigate`, take `onOpenNote`.
- `src/map/mapEntries.ts` — create: store-free `mapEntries` (moved from `useVaultGraphs.ts`).
- `src/state/vaultStats.ts` — create: pure `vaultStats` moved out of `StoreContext.tsx`.
- `src/openboard/` — create: `api.ts`, `entries.ts`, `Reader.tsx`, `TreeRail.tsx`, `visitor/` (entry + page), `editor/` (entry + page, `LinksTab.tsx`, `ContentTab.tsx`), `publish/` (`collect.ts`, `PublishDialog.tsx`).
- `src/components/Sidebar.tsx`, `src/components/VaultTree.tsx` — modify: menu items.

---

### Task 1: Link token generator

**Files:**
- Create: `server/src/openboard/words.ts`, `server/src/openboard/token.ts`
- Test: `server/test/openboard-token.test.ts`

**Interfaces:**
- Produces: `generateLinkToken(): string`; `LINK_TOKEN_RE: RegExp` (`/^[a-z]+(?:-[a-z]+)*-[a-z2-7]{12}$/`); `ADJECTIVES`, `ANIMALS`, `SCENES: readonly string[]` from `words.ts`.

- [ ] **Step 1: Write the failing test**

```ts
it('matches the token format', () => { expect(generateLinkToken()).toMatch(LINK_TOKEN_RE); });
it('has enough word entropy', () => {
  expect(ADJECTIVES.length).toBeGreaterThanOrEqual(256);
  expect(ANIMALS.length).toBeGreaterThanOrEqual(256);
  expect(SCENES.length).toBeGreaterThanOrEqual(64);
});
it('words are lowercase a-z and unique', () => { /* each list: /^[a-z]+$/ (SCENES: /^[a-z]+(-[a-z]+)*$/), new Set size === length */ });
it('does not repeat across 2000 calls', () => { expect(new Set(Array.from({length: 2000}, generateLinkToken)).size).toBe(2000); });
it('ends with a 12-char suffix', () => { expect(generateLinkToken().split('-').pop()).toHaveLength(12); });
```

- [ ] **Step 2: Run to verify fail**

Run: `npm test -w server -- test/openboard-token.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement** the three exports. Word lists are written by hand (friendly, safe words; no names or slurs). `generateLinkToken` picks each word with `crypto.randomInt` and builds the suffix from `crypto.randomBytes(8)` mapped to base32 characters, first 12.

- [ ] **Step 4: Run to verify pass.** Same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/openboard server/test/openboard-token.test.ts
git commit -m "feat(openboard): whimsy link token generator"
```

---

### Task 2: Published content store and owner publish/unpublish API

**Files:**
- Modify: `server/src/db.ts` (SCHEMA), `server/src/app.ts` (register `openboardRoutes`)
- Create: `core/src/openboard.ts` (+ export in `core/src/index.ts`), `server/src/openboard/store.ts`, `server/src/routes/openboard.ts`
- Test: `server/test/openboard-publish.test.ts`

**Interfaces:**
- Produces, in `core/src/openboard.ts`:
```ts
export interface ObVault { id: string; name: string; color: string; updatedAt: string }
export interface ObFolder { id: string; vaultId: string; parentId: string | null; name: string }
export interface ObNote { id: string; vaultId: string; folderId: string | null; title: string; body: string; createdAt: string; updatedAt: string }
export interface ObPayload { vaults: ObVault[]; folders: ObFolder[]; notes: ObNote[] }
export interface PublishRequest {
  kind: 'vault' | 'folder' | 'note';
  vaultName: string; color: string;
  destPath: string[];                       // folder names under the vault; [] = vault root. Ignored for kind 'vault'.
  rootName: string;                         // vault name for 'vault', folder name for 'folder', note title for 'note'
  folders: { key: string; parentKey: string | null; name: string }[];  // subtree below the root; empty for note
  notes: { folderKey: string | null; title: string; body: string }[];  // folderKey null = directly in the root
  overwrite: boolean;
}
export interface PublishResult { vaultId: string; imageRefs: string[] }   // image ids referenced by published bodies
export interface PublishConflict { error: 'conflict'; target: { kind: 'vault'|'folder'|'note'; name: string; path: string[] }; removes: { folders: number; notes: number } }
```
- Produces routes: `POST /api/openboard/publish` (201 `PublishResult`, 409 `PublishConflict`), `GET /api/openboard/content` (`ObPayload` with `body: ''` on notes), `DELETE /api/openboard/vaults/:id`, `/folders/:id`, `/notes/:id` (204). Store functions in `store.ts`: `publish(db, userId, req, imageQuotaCheck?) `, `listContent(db, userId)`, `deleteVault/Folder/Note(db, userId, id)`.
- Tables (all `ob_`-prefixed, FK cascade): `ob_vaults(id, user_id→users, name, color, created_at, updated_at)`, `ob_folders(id, vault_id→ob_vaults, parent_id→ob_folders, name)`, `ob_notes(id, vault_id, folder_id, title, body, created_at, updated_at)`, `ob_images(vault_id, id, size, mime, data BLOB, created_at, PRIMARY KEY(vault_id,id))`, `ob_links(id, user_id, label, token UNIQUE, views INTEGER NOT NULL DEFAULT 0, created_at)`, `ob_link_vaults(link_id, ob_vault_id, PRIMARY KEY(link_id, ob_vault_id))`. Server generates all new ids (`randomUUID`).

- [ ] **Step 1: Write the failing tests** (use `makeApp`, `call` and the signed-in account helper from `server/test/helpers.ts`):
  - `publishes a vault and lists it`: POST kind `vault` with one folder, two notes → 201; `GET /content` returns 1 vault, 1 folder, 2 notes with empty bodies.
  - `publish requires login`: no cookie → 401.
  - `conflict without overwrite`: publish the same vault name twice → second is 409 with `target.kind === 'vault'` and `removes.notes === 2`; content unchanged afterwards.
  - `vault overwrite keeps the vault id`: second publish with `overwrite: true` returns the same `vaultId`, old notes gone, new notes present.
  - `folder overwrite removes extras`: publish folder `A` {notes 1,2}, then folder `A` {notes 2} with overwrite → only note 2 remains in `A`; sibling folders untouched.
  - `note overwrite`: same title at same `destPath` conflicts; with overwrite replaces the body.
  - `publishing a folder into a missing destPath creates the folders`.
  - `a failing publish rolls back`: a request whose second note violates a body size limit (> 1 MiB body) → 400/413 and the first publish's content is intact.
  - `another user cannot see or delete my content`: second account gets empty `/content`, and `DELETE /vaults/:id` → 404.
  - `unpublish a folder cascades`; `unpublish a vault removes link grants` (grant row for that vault is gone).
  - `returns imageRefs`: bodies containing `inked://img-a` and `inked://img-b` → `imageRefs` is `['img-a','img-b']`.
  - duplicate sibling names and a non-ASCII folder name publish and list without error.

- [ ] **Step 2: Run to verify fail.** `npm test -w server -- test/openboard-publish.test.ts` → FAIL.

- [ ] **Step 3: Implement** the DDL, types, `store.ts` and `routes/openboard.ts` (`{ onRequest: requireUser(ctx) }`, JSON schema validation like `routes/notes.ts`; body limits: 1 MiB per note body, 5000 notes and 2000 folders per request, request `bodyLimit` 64 MiB). The whole publish runs in one `transaction()`: resolve the target by name chain, return the conflict (or throw a typed error mapped to 409 with the `PublishConflict` body) when it exists and `overwrite` is false, delete the target subtree when overwriting (vault: delete its folders/notes/images rows but keep the `ob_vaults` row and bump `updated_at`), insert the new subtree. After inserting, drop any `ob_images` rows whose id is no longer referenced by a body in that vault. `imageRefs` comes from scanning bodies with `parseImageUri` semantics: pattern `inked://<id>`; ids must match the existing image id charset (reuse `imageParams` from `schemas.ts`).

- [ ] **Step 4: Run to verify pass.** Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(openboard): published content store and owner publish API"`

---

### Task 3: Published images and links API

**Files:**
- Modify: `server/src/openboard/store.ts`, `server/src/routes/openboard.ts`, `server/src/app.ts` (octet-stream parser scope already used for private images; register the image route inside it)
- Test: `server/test/openboard-links.test.ts`, `server/test/openboard-images.test.ts`

**Interfaces:**
- Consumes: Task 1 `generateLinkToken`; Task 2 tables and `ObPayload`.
- Produces (core type): `ObLink { id: string; label: string; token: string; vaultIds: string[]; views: number; createdAt: string }`.
- Produces routes (owner): `POST /api/openboard/vaults/:vaultId/images/:imageId` (raw bytes, 201 `{id,size}`, 409 exists, 400 not a supported image, 413 over quota, 404 when the published vault is not the caller's or the id is not referenced by any note body in that vault); `GET /api/openboard/links` → `ObLink[]`; `POST /api/openboard/links` body `{ label: string; vaultIds: string[] }` → 201 `ObLink`; `PATCH /api/openboard/links/:id` body `{ label?: string; vaultIds?: string[] }` → `ObLink`; `DELETE /api/openboard/links/:id` → 204; `GET /api/openboard/preview?linkId=<id>` (omit `linkId` for all published content) → `ObPayload` with bodies, `views` untouched.
- Store: `sniffImage(buf: Buffer): 'image/png'|'image/jpeg'|'image/gif'|'image/webp'|null`.

- [ ] **Step 1: Write the failing tests**
  - Links: create with two vaults returns a token matching `LINK_TOKEN_RE` and `views: 0`; label 1-80 chars, empty label → 400; `vaultIds` containing another user's or unknown vault → 400; listing returns only mine; PATCH replaces the vault set; DELETE removes the link and a second DELETE → 404; another user's link id → 404 on PATCH and DELETE; `preview?linkId=` returns only that link's vaults, with bodies.
  - Images: PNG bytes upload and are stored; SVG text (`<svg…`) → 400; bytes with a PNG header but `content-type: image/svg+xml`... the route only accepts `application/octet-stream`, other types → 415; 10 MiB + 1 → 413; reference check (id not in any body) → 404; duplicate → 409; per-user quota over `imageQuotaBytes` counts private and published bytes together → 413.

- [ ] **Step 2: Run to verify fail.** `npm test -w server -- test/openboard-links.test.ts test/openboard-images.test.ts` → FAIL.

- [ ] **Step 3: Implement** the store functions and routes. `sniffImage` checks the PNG signature, JPEG `FF D8 FF`, `GIF87a/GIF89a`, and `RIFF....WEBP`. Link creation retries token generation on a UNIQUE collision (up to 5 times, then 500).

- [ ] **Step 4: Run to verify pass.** Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(openboard): links, preview and published images"`

---

### Task 4: Public token API

**Files:**
- Create: `server/src/routes/openboardPublic.ts`
- Modify: `server/src/context.ts` (add `obLimiter: FailureLimiter` to `AppContext`, built as `new FailureLimiter(20, 60_000)`), `server/src/app.ts` (construct, register, prune in the hourly sweeper), `server/src/openboard/store.ts`
- Test: `server/test/openboard-public.test.ts`

**Interfaces:**
- Consumes: Tasks 2-3 store and tables.
- Produces: `GET /api/ob/:token` → `ObPayload & { label: string }` (only vaults granted to the link, with bodies; increments `ob_links.views` by 1); `GET /api/ob/:token/images/:vaultId/:imageId` → image bytes with the sniffed `content-type`, `cache-control: private, max-age=3600`, only if the vault is granted to the token. Both are cookie-free, no CSRF header needed (GET), and return `404 { error: 'not_found' }` for anything else. Store: `findLinkByToken(db, token): { id: string; label: string; userId: string } | null`, `grantedPayload(db, linkId): ObPayload`, `bumpViews(db, linkId): void`.

- [ ] **Step 1: Write the failing tests**
  - `returns only granted vaults`: publish vaults A and B, link grants A → payload has only A's folders and notes; B's note titles do not appear anywhere in the response text.
  - `counts one view per call`: three GETs → `views` is 3 in `GET /links`; owner `preview` does not change it.
  - `edited grants take effect immediately` (PATCH, then GET).
  - `deleted link and unknown token are identical`: same status and body; malformed token (fails `LINK_TOKEN_RE`) also gives that same 404 without a DB lookup.
  - `rate limits failures per ip`: 21 bad tokens from one `ip` → a 429 with `retry-after`; a valid token from a different ip still works; a valid token from the locked ip is also refused until the lock clears (document this in the test name).
  - `image only if its vault is granted`: link grants A; image of B → 404; image of A → 200 with `image/png`.
  - `image id from another vault with the same id` (PK is vault+id): resolves by the vault in the URL.
  - `response is not cached` for the JSON (`cache-control: no-store`, already applied to `/api/` paths).
  - `a link granting zero vaults returns empty arrays`, 200.

- [ ] **Step 2: Run to verify fail.** `npm test -w server -- test/openboard-public.test.ts` → FAIL.

- [ ] **Step 3: Implement.** Bad-token lookups call `ctx.obLimiter.attempt(ip)` before the DB lookup and `reset` is **not** called on success (the limiter counts attempts; a valid hit is cheap, but use `fail` only on misses: check `retryAfter(ip)` first, call `fail(ip)` on a miss). Use `request.ip` (already honors `trustProxy`).

- [ ] **Step 4: Run to verify pass.** Expected: PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(openboard): public token API with rate limiting and view counts"`

---

### Task 5: Serving the two web entry pages

**Files:**
- Modify: `server/src/app.ts` (not-found handler), `web/vite.config.ts`, `web/package.json` (no new deps)
- Create: `web/openboard.html`, `web/openboard-editor.html`, `web/src/openboard/visitor/main.tsx`, `web/src/openboard/editor/main.tsx` (each renders a placeholder `<div id="openboard-root">`-mounted component showing "Openboard" for now)
- Test: `server/test/openboard-html.test.ts`

**Interfaces:**
- Produces: `GET /ob/<anything>` serves `openboard.html`; `GET /openboard` and `GET /openboard/<anything>` serve `openboard-editor.html`; everything else still falls back to `index.html`. `/api/**` stays JSON 404. Vite builds three pages with `build.manifest: true`.

- [ ] **Step 1: Write the failing test**: `makeApp({ webDist })` where `webDist` is a temp dir containing `index.html` ("main"), `openboard.html` ("visitor") and `openboard-editor.html` ("editor"): `/ob/some-token` → body contains "visitor"; `/openboard` and `/openboard/links` → "editor"; `/v/x` → "main"; `/api/ob/zzz` is not the HTML; a response for `/ob/x` has the standard security headers (`content-security-policy` present).

- [ ] **Step 2: Run to verify fail.** `npm test -w server -- test/openboard-html.test.ts` → FAIL.

- [ ] **Step 3: Implement** the branch in `setNotFoundHandler` (check `request.url` pathname before the generic fallback) and the `rollupOptions.input` map `{ main: 'index.html', openboard: 'openboard.html', 'openboard-editor': 'openboard-editor.html' }`. In `vite.config.ts` dev `server.proxy` already forwards `/api`; add dev rewrites so `/ob/*` and `/openboard*` open the matching page.

- [ ] **Step 4: Run tests and a real build.** `npm test -w server -- test/openboard-html.test.ts` → PASS; `npm run build -w web` → succeeds and `web/dist/openboard.html`, `web/dist/openboard-editor.html` exist.

- [ ] **Step 5: Commit** `git commit -m "feat(openboard): serve visitor and editor entry pages"`

---

### Task 6: Shared read-only map

**Files:**
- Modify: `web/src/map/ConceptMap.tsx` (remove `useNavigate`; new required prop `onOpenNote: (vaultId: string, noteId: string) => void` replaces the `navigate(noteHref(...))` call at the dot open handler), its caller(s) (find with `grep -rn "<ConceptMap" web/src`: pass `onOpenNote={(v, n) => navigate(noteHref(v, n))}`), `web/src/map/useVaultGraphs.ts`, `web/src/state/StoreContext.tsx`
- Create: `web/src/map/mapEntries.ts`, `web/src/state/vaultStats.ts`, `web/src/openboard/entries.ts`, `web/scripts/check-openboard-bundle.mjs`
- Test: `web/src/openboard/entries.test.ts`, existing `ConceptMap.test.tsx` updated

**Interfaces:**
- Produces: `mapEntries` and `LayoutCache` and `GraphState` exported from `map/mapEntries.ts` (same signatures as today; `useVaultGraphs.ts` re-exports and keeps hooks); `vaultStats` exported from `state/vaultStats.ts` (same signature as today in `StoreContext.tsx`, which re-exports it); `openboardEntries(payload: ObPayload, now?: number): MapEntry[]` in `openboard/entries.ts` (builds `VaultView`/`TreeView` from plaintext, `status: 'ready'`, bodies ready, one entry per vault, empty vault yields an entry with an empty graph).
- `check-openboard-bundle.mjs`: reads `web/dist/.vite/manifest.json`, walks the static import closure of the `openboard.html` and `openboard-editor.html` entries and exits 1 if any chunk or source path matches `hash-wasm`, `@huggingface`, `inked-core/crypto`, `state/store`, or `argon`.

- [ ] **Step 1: Write the failing tests**
  - `entries.test.ts`: payload with 2 vaults / folders / notes where note A body contains `[[B]]` → entry graph has an edge A→B; a link to a non-existent title adds no edge; an empty vault gives an entry and no throw; duplicate sibling names and non-ASCII names produce distinct nodes; `<script>` in a note body is untouched data here (rendering is Task 7).
  - `ConceptMap.test.tsx`: clicking a note dot calls `onOpenNote(vaultId, noteId)` and renders without a Router around it.

- [ ] **Step 2: Run to verify fail.** `npm test -w web -- src/openboard/entries.test.ts src/map/ConceptMap.test.tsx` → FAIL.

- [ ] **Step 3: Implement** the extractions and the prop change. Keep behavior of the notes app identical: run the whole web suite after.

- [ ] **Step 4: Run** `npm test -w web` → all existing tests plus the new ones PASS. The bundle check runs in Task 7 once real entries exist.

- [ ] **Step 5: Commit** `git commit -m "refactor(web): router-free ConceptMap and store-free mapEntries for openboard"`

---

### Task 7: Visitor page

**Files:**
- Create: `web/src/openboard/api.ts`, `web/src/openboard/Reader.tsx`, `web/src/openboard/TreeRail.tsx`, `web/src/openboard/visitor/VisitorPage.tsx` (+ styles in `web/src/styles/openboard.css`); modify `web/src/openboard/visitor/main.tsx`
- Test: `web/src/openboard/visitor/VisitorPage.test.tsx`, `web/src/openboard/Reader.test.tsx`

**Interfaces:**
- Consumes: Task 4 API; Task 6 `ConceptMap`, `openboardEntries`; `renderMarkdown(src, env)` from `markdown/render.ts`.
- Produces: `fetchPublic(token: string): Promise<ObPayload & { label: string }>` and `publicImageUrl(token, vaultId, imageId): string` in `api.ts` (a bare `fetch`, no `X-Inked-User`); `<Reader note vaultId token payload onOpenNote />` (renders sanitized markdown; `inked://id` images become `<img src=publicImageUrl(...)>`; mermaid blocks use the existing frame; `[[Title]]` to a note in `payload` becomes a button that calls `onOpenNote`, otherwise plain text); `<TreeRail payload selectedId onSelect collapsed onToggle />`; `<VisitorPage />` reads the token from `location.pathname` (`/ob/:token`) with no router dependency beyond `MemoryRouter` if a component needs one.
- Layout: top bar (label, title search input), collapsible left rail (collapsed by default on widths under 900px), map filling the rest, right drawer opens on node click and re-centers the map on that node, Escape closes the drawer. Not-found shows a plain "This link doesn't exist or was removed" page.

- [ ] **Step 1: Write the failing tests** (jsdom, `fetch` stubbed):
  - renders vault names in the rail and a map for the payload; clicking a note in the rail opens the drawer with its rendered body.
  - title search `foo` filters rail rows and highlights hits on the map via the `hits` prop.
  - `Reader` strips `<script>`, `onerror` attributes and `javascript:` hrefs; a body with `![x](inked://abc)` renders an `img` whose `src` is `/api/ob/<token>/images/<vault>/abc`.
  - a 404 response renders the not-found page and no map.
  - zero vaults renders an empty-state message, not an error.
  - drawer closes on Escape.

- [ ] **Step 2: Run to verify fail.** `npm test -w web -- src/openboard` → FAIL.

- [ ] **Step 3: Implement.** Pass `loading`, `selected`, `onSelect`, `onOpenNote` and the other required `ConceptMap` props; omit the optional semantic ones. No page title or note body is logged.

- [ ] **Step 4: Run** `npm test -w web` → PASS; then `npm run build -w web && node web/scripts/check-openboard-bundle.mjs` → exits 0 with "openboard bundles clean".

- [ ] **Step 5: Commit** `git commit -m "feat(openboard): visitor page with map, tree rail and reader"`

---

### Task 8: Editor

**Files:**
- Create: `web/src/openboard/editor/EditorPage.tsx`, `LinksTab.tsx`, `ContentTab.tsx`, `NewLinkDialog.tsx`; extend `web/src/openboard/api.ts`; modify `editor/main.tsx`
- Test: `web/src/openboard/editor/EditorPage.test.tsx`

**Interfaces:**
- Consumes: Tasks 2-3 owner routes; Task 7 `Reader`, `TreeRail`; `Dialog`/`ConfirmDialog` from `components/Dialog.tsx`; the same session check the main app's `Gate` uses (read `App.tsx`; reuse its endpoint, do not add a new one).
- Produces in `api.ts` (all send `X-Inked: 1`): `listLinks(): Promise<ObLink[]>`, `createLink(label: string, vaultIds: string[]): Promise<ObLink>`, `updateLink(id: string, patch: { label?: string; vaultIds?: string[] }): Promise<ObLink>`, `deleteLink(id: string): Promise<void>`, `listContent(): Promise<ObPayload>`, `previewPayload(linkId?: string): Promise<ObPayload>`, `unpublish(kind: 'vault'|'folder'|'note', id: string): Promise<void>`.
- UI: not signed in → a "Sign in to Inked" link to `/login`. Tabs "Links" and "Published content". Links rows: URL (`${location.origin}/ob/${token}`), label, vault chips, view count, Copy (clipboard), Edit vaults (dialog with vault checkboxes), Delete (`ConfirmDialog`). Content tab: published tree with Unpublish (confirm) at vault/folder/note level, plus the shared `ConceptMap` showing `previewPayload(selectedLinkId)`; a "Preview as" select lists "All published" and each link label.

- [ ] **Step 1: Write the failing tests** (jsdom, `fetch` stubbed): lists links with view counts; creating a link with no vaults selected is disabled; Copy writes the full URL; Delete asks to confirm and removes the row on yes, does nothing on cancel; Unpublish confirm calls `DELETE` and refreshes; "Preview as" a link refetches `preview?linkId=` and the map shows only those vaults; 401 shows the sign-in prompt.

- [ ] **Step 2: Run to verify fail.** `npm test -w web -- src/openboard/editor` → FAIL.

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run** `npm test -w web` → PASS; `npm run build -w web && node web/scripts/check-openboard-bundle.mjs` → clean.

- [ ] **Step 5: Commit** `git commit -m "feat(openboard): editor with links, published content and map preview"`

---

### Task 9: Publish flow in the main app

**Files:**
- Create: `web/src/openboard/publish/collect.ts`, `web/src/openboard/publish/PublishDialog.tsx`
- Modify: `web/src/components/Sidebar.tsx` (vault menu, next to "Vault settings"), `web/src/components/VaultTree.tsx` (`itemsFor`: folder and note menus), the account area that already links to Settings (add an "Openboard editor" anchor with `target="_blank"` to `/openboard`)
- Test: `web/src/openboard/publish/collect.test.ts`, `PublishDialog.test.tsx`

**Interfaces:**
- Consumes: Task 2 `PublishRequest`/`PublishResult`/`PublishConflict`; Task 3 image upload route; Task 8 `listContent` for the destination tree; the store's existing body loading and image decryption (`decryptImage`, `imageStore`, find the current accessors with `grep -rn "decryptImage\|loadBody" web/src/state`).
- Produces: `collectUnit(store, vaultId: string, target: { kind: 'vault' } | { kind: 'folder'; id: string } | { kind: 'note'; id: string }): Promise<{ request: Omit<PublishRequest, 'overwrite' | 'destPath'>; images: Map<string, () => Promise<Uint8Array>> }>` (loads and decrypts every body in the subtree; `images` maps each referenced image id to a lazy decrypt-and-return); `publishUnit(unit, destPath: string[], overwrite: boolean): Promise<{ status: 'ok'; result: PublishResult } | { status: 'conflict'; conflict: PublishConflict }>`; `<PublishDialog target onClose />` runs the flow below.
- Flow: (1) notice "Published content is stored readable by the server and anyone with a link." with Cancel/Continue. (2) vault target skips to step 4; folder/note target shows the destination tree (published vaults and folders from `listContent`, plus "New vault on openboard" with a name field; selecting a folder sets `destPath`). (3) `publishUnit(..., overwrite=false)`. (4) on `conflict` show `ConfirmDialog` "Replace '<name>' on openboard? This overwrites N notes and removes M items there." with Cancel / Overwrite; Overwrite resends with `overwrite=true`; Cancel closes with no change. (5) after success upload each id in `result.imageRefs` that exists in `images` via the Task 3 route (skip ids that fail to decrypt and show a warning count), then show "Published." with a link to the editor.

- [ ] **Step 1: Write the failing tests**
  - `collect.test.ts` (fake store with 2 folders, 3 notes, one body containing `inked://img1`): a vault target returns every folder and note with decrypted bodies and `images` has key `img1`; a folder target returns only that subtree with `rootName` equal to the folder's name; a note target returns one note and no folders; private ids never appear in the request (keys are local).
  - `PublishDialog.test.tsx` (stubbed fetch): folder publish shows the destination tree; picking "Papers" sends `destPath: ['Research','Papers']`; a 409 shows the overwrite confirm with the counts from the conflict; Cancel sends no second request; Overwrite sends `overwrite: true`; image upload happens only after publish success; menu items "Publish to openboard" exist for vault, folder and note menus.

- [ ] **Step 2: Run to verify fail.** `npm test -w web -- src/openboard/publish` → FAIL.

- [ ] **Step 3: Implement.** Bodies are sent as stored (image refs stay `inked://<id>`). Local keys for folders are the private folder ids.

- [ ] **Step 4: Run** `npm test -w web` → PASS.

- [ ] **Step 5: Commit** `git commit -m "feat(openboard): publish to openboard from the main app"`

---

### Task 10: Docs and full verification

**Files:**
- Modify: `docs/architecture.md` (new "Openboard" section: the one deliberate plaintext exception, tables, routes, who can read), `docs/deploy.md` only if the `/ob` and `/openboard` routes need a note (they do not need nginx changes).

- [ ] **Step 1: Write the doc section** (what is stored in plaintext, that unpublishing deletes it, token format, rate limit, view counts).

- [ ] **Step 2: Run the whole suite.** `npm test` at the repo root → all workspaces PASS.

- [ ] **Step 3: Build and bundle check.** `npm run build -w web && node web/scripts/check-openboard-bundle.mjs` → clean; `npm run build -w server` (or the repo's server build script) succeeds.

- [ ] **Step 4: Run it for real.** Start the app with the `run` skill, publish a vault, create a link, open `/ob/<token>` in a private window, confirm the map renders, the view count rises in the editor, overwrite asks for confirmation, and deleting the link makes the URL a not-found page.

- [ ] **Step 5: Commit** `git commit -m "docs(openboard): architecture notes and verification"`
