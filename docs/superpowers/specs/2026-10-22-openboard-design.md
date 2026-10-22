# Openboard: design

Date: 2026-10-22

## Intent

Inked keeps everything encrypted in the browser, so a note can only be read by its owner. That makes sharing impossible. Openboard adds a deliberate, owner-controlled exception: the owner chooses vaults, folders and files to publish as plaintext into a separate public space, then shares secret links to it. A visitor opens a link and sees a wide, read-only concept map of what the owner chose to show, with a reader for each note.

It is similar in spirit to a published Claude artifact or a Node-RED dashboard: it is not part of the private system, it is a shelf the owner puts things on. The private encrypted vaults never change.

## Goals

- Publish a vault, folder or note from the normal Inked UI via the three-dots menu ("Publish to openboard"). The browser decrypts and uploads plaintext.
- A visitor with a link sees a read-only map of the vaults that link allows, a slim tree rail, and a reading drawer. No login.
- An owner-only "openboard editor" (its own UI, not a page inside the notes app layout) to create and delete links, choose per link which published vaults it shows, see view counts, manage published content (browse, unpublish), and preview the map as a given link's visitors would see it.
- Overwrite safety: publishing to a path that already exists on openboard asks first, for vaults, folders and notes alike.

## Non-goals

- No public directory, no discovery, no per-user public page. Access is only by holding a link.
- No visitor accounts, comments, editing, or per-visitor logs.
- No link expiry (not requested; can be added later).
- No Ask/RAG and no semantic search on openboard. Visitors get title search only.
- No MCP tools for openboard in this version.
- Publishing is a one-shot copy, not live sync. Republish to update.

## Anti-goals (would make this a failure even if it works)

- Any change to the private encrypted data, or any plaintext of unpublished content reaching the server.
- A link revealing vaults it was not granted, or a deleted link continuing to work.
- Link guessing being practical.
- The visitor bundle shipping crypto or editor code it does not need.

## Decisions (by the owner)

- **Access model:** only people given a link can view. Each link is a secret URL.
- **Link format:** whimsy slug plus a random suffix, e.g. `/ob/gratifying-beaver-in-the-sun-7k3q9x2m`. Slug is adjective, animal, preposition and scene from word lists, picked with `crypto.getRandomValues`. The "small model" in the app is an embedding model and cannot generate text, so word lists are used. The random suffix (8 chars, base32) keeps total entropy near 80 bits or more because the link is the only access control.
- **Visitor layout:** left slim collapsible tree rail, wide map in the middle, right reading drawer that opens on node click while the map stays visible and re-centers on the node. Look copies the existing Inked UI (dark, purple ink) with most sidebar information removed to give the map room.
- **Editor:** separate UI, reached from a menu entry in the main app. Two areas: Links (label, vault chips, view count, Copy, Edit vaults, Delete) and Published content (tree with Unpublish at each level). It includes the same map as the visitor view so the owner sees how publishing will look, with a "preview as this link" switch.
- **Per-link vault selection:** creating a link prompts for which published vaults it shows. Links can be deleted; deletion takes effect immediately.
- **View counts:** one count per link, incremented each time the link is opened.
- **Publishing files and folders:** a destination picker shows the openboard tree (and an option to create a new vault there) so the owner chooses which vault/folder receives the content.
- **Overwrite:** if the target vault, folder or note already exists at that path on openboard, show a confirm dialog and hard overwrite only if the owner agrees.

## Constraints from the codebase (verified)

- Server: Fastify 5, ESM, `node:sqlite`. Schema is a single `CREATE TABLE IF NOT EXISTS` string in `server/src/db.ts`; new tables are easy to add there. Routes live in `server/src/routes/` and register in `app.ts`. Authed routes use `requireUser`; every non-GET needs the `X-Inked: 1` header. Only login has a rate limiter (`limiter.ts`); a new limiter instance is needed for public token lookups.
- Server holds no vault keys. Today it stores only ciphertext. Openboard needs new tables holding plaintext, filled by the client.
- Data model: ids are client-generated; folders have `parentId`, notes have `folderId`; there are no stored paths, so "path" means the chain of folder names. A folder's hub is a note titled `Index`. Images are `inked://<id>` in markdown, encrypted blobs in SQLite (png, jpeg, gif, webp, max 10 MiB).
- Web: Vite + React 18 + react-router 7. Concept map in `web/src/map`: `graph.ts`, `layout.ts`, `scene.ts` are pure over plain tree/body data; `ConceptMap.tsx` takes `entries` but is coupled to the router (`noteHref`, `useNavigate`) and `useVaultGraphs` reads app state. Markdown render (`web/src/markdown/render.ts`) is pure markdown-it plus DOMPurify and has no crypto dependency; images become `data-inked-image` placeholders resolved elsewhere. Mermaid renders in a sandboxed iframe at `/frame/` and works on plaintext.
- Menus: `components/Menu.tsx`; vault menu in `Sidebar.tsx`, folder and note menus in `VaultTree.tsx` (`itemsFor`). Dialogs in `components/Dialog.tsx` (`ConfirmDialog`, `SelectDialog`).
- Deploy: Fastify serves `web/dist` with an SPA fallback; nginx is a plain proxy with access logging off (good, tokens in URLs are not logged). CSP is strict (`default-src 'self'`).
- Tests: Vitest in each workspace; no Playwright in the repo scripts.

## Design

### Data (server, plaintext, separate from private tables)

New tables, owner-scoped: published vaults, folders, notes (name/title and markdown body), images (plaintext blob), links (owner, label, token, created, view count), and a link-to-published-vault join. Nothing here references or alters private vault rows. Deleting a published vault removes its descendants and its link grants.

### Publish flow (main app)

1. Owner opens the three-dots menu on a vault, folder or note and picks "Publish to openboard". A short notice says the content will be stored readable by the server and anyone with a granting link.
2. Vault: publishes the whole tree under the vault name. Folder or note: shows the destination picker (openboard vault/folder tree, or "new vault").
3. Browser decrypts, rewrites `inked://` image references to openboard image ids, uploads plaintext.
4. If the target exists at the same name path, the server answers with a conflict listing what would be replaced. The UI shows the overwrite confirm. On confirm the client resends with an overwrite flag and the server replaces the target subtree inside one transaction. Declining changes nothing.

### Links

- Created in the editor with a label and a vault selection. The server generates the token (word lists plus random suffix) and returns the URL. Resolving a token returns only the vaults granted to that link.
- Deleting a link removes its row and grants; the URL then returns the same not-found as an unknown token.
- Failed lookups are rate limited per IP with a new limiter, as a backstop.

### Visitor view (`/ob/:token`)

Its own small bundle and HTML entry with no crypto, no editor, no auth. Loads the granted vaults' tree and bodies through a public read-only API, draws the shared read-only map component, tree rail, reading drawer, title search. Images load from a public image endpoint keyed by the token. View count increments once per page open.

### Openboard editor

Its own bundle and HTML entry, authenticated by the existing session cookie but with no vault keys needed (it only touches published plaintext and links). It reuses the same map and tree components as the visitor view.

### Shared map

Extract the map so it takes plain data and an injected note-open callback and href builder instead of using the router and app store directly. The notes app, the editor preview, and the visitor view all use this one component so the preview cannot drift from the real result.

## Left to the builder

Table and column details; exact API shapes and payload limits; how large publishes are chunked; how the public bundle and editor bundle are built and routed (extra Vite inputs plus Fastify routing for `/ob/*` and the editor path); word lists; the extraction refactor of the map; visual polish within the existing design system (`DESIGN.md`); tests, including that no plaintext or foreign vault leaks across links or users.

## Calls made without the owner (review these)

- Link token is stored so the editor can show and copy it again later (owner already trusts the server with the plaintext it grants access to).
- Path identity for overwrite is the name chain (vault name, folder names, note title), matching what the owner sees; sibling duplicates collide and are replaced together.
- Images inside published notes are published decrypted with the note.
- Visitors get title search only; no Ask, no semantic search.
- A deleted link and an unknown token are indistinguishable to visitors.
- Publishing happens only from the main app, which holds the vault keys. The editor never publishes, so it needs no crypto and only reads, unpublishes and previews plaintext on the server.
- Published images belong to a published vault (not a note or the owner). The public image endpoint serves an image only if its vault is granted to the token. The private limits carry over: png, jpeg, gif, webp, max 10 MiB; SVG and other types are rejected.
- "Hard overwrite" means true replace, not merge: publishing folder A over an existing A deletes anything in the old A that the new A does not contain. The conflict payload lists what will be replaced and removed. A vault overwrite keeps the published vault's id and replaces its contents in place, so existing link grants survive.
- Publishing a different private vault that has the same name as an openboard vault is treated as the same target and triggers the overwrite confirm. No "republish" shortcut is stored.
- Opening a link counts one view on the public token lookup. The editor's "preview as this link" uses an owner-authed endpoint and does not count.
- A `[[link]]` in a published note to a note that is not published, or is outside the link's granted vaults, renders as plain text with no link and is not a map edge.
- Visitor loading shape (one call versus tree first, bodies on demand) is the builder's call; the map needs bodies to draw links.
- `docs/architecture.md` gets a short section stating that openboard is the one deliberate plaintext exception.
