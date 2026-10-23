# Openboard write links: design

Date: 2026-10-24

## Intent

The owner asked: "can we allow openboard write permissions? Just add it as a permission on the link generator, with read as default". A link becomes either **Read** (today's behaviour, the default) or **Write**. A visitor holding a Write link can edit the published notes in the vaults that link covers and add new notes there. The owner was away and said "just do what you recommend", so every call below is a ruling made without them. Each one says what was decided, why, and what it costs if it is wrong.

Background: `docs/superpowers/specs/2026-10-22-openboard-design.md`.

## Scope

- Link generator (`NewLinkDialog`): a permission choice, Read selected by default.
- Link list: each link shows its permission; the owner can change it (and the vaults) in one Edit dialog, or delete the link to revoke it.
- Server: `ob_links.permission`, `'read'` or `'write'`, default `'read'`. Existing rows become `'read'`. Two new public write routes, both refused for Read links.
- Visitor page: on a Write link, Edit (title and body) in the reading drawer and a New note button in the top bar.
- Publish dialog: the overwrite confirm warns when the replaced content holds visitor edits.

## Anti-goals

- A Read link can write anything. (Checked server-side on every write, not only hidden in the UI.)
- A visitor write reaches the private encrypted tables, or any `ob_*` row outside the vaults the link grants.
- A visitor's Markdown runs script, loads remote content or impersonates a site link on another person's screen.
- One visitor can fill the server's disk or lock other visitors out of reading.

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/ob/:token` | response gains `permission: 'read' \| 'write'`; notes gain `visitorEdited: boolean` |
| PATCH | `/api/ob/:token/notes/:noteId` | `{ baseUpdatedAt, title?, body? }`; 200 with the note; 409 `stale` when `baseUpdatedAt` is not the current value |
| POST | `/api/ob/:token/notes` | `{ vaultId, folderId \| null, title, body }`; 201 with the note |
| POST, PATCH | `/api/openboard/links`, `/api/openboard/links/:id` | accept `permission`; `ObLink` gains `permission` |
| POST | `/api/openboard/publish` | the 409 `conflict` body gains `visitorEdits` (notes in the target changed or added by visitors) |

Fastify validates the request's shape first (400 on a malformed body, whatever the link). Then write routes check, in order: token (the existing failed-lookup limiter), permission (403 `read_only`), the write limiter (429 `locked`), the vault grant (404), then content rules (400 / 413).

## Rulings

1. **Permission is per link, two values, stored as a column.** `ob_links.permission TEXT NOT NULL DEFAULT 'read' CHECK (permission IN ('read','write'))`. `openDb` adds the column with `ALTER TABLE` when `PRAGMA table_info(ob_links)` lacks it, so it is idempotent and existing links become Read. *Why:* the owner asked for a permission on the link, with Read as default. *If wrong:* a finer model (per vault, per folder, append-only) needs a new column or table; the API field can grow new values without breaking Read.

2. **Visitors can edit title and body, and create notes. They cannot delete, move, rename folders or upload images.** *Why:* the owner asked for "write"; edit and create cover the plain meaning and are recoverable (republish restores the owner's version). Delete and move are destructive with no history to undo them. Images need an upload path for anonymous users, with quota abuse to solve. *If wrong:* visitors cannot tidy up; the owner unpublishes a note from the editor instead. Delete can be added later behind the same permission.

3. **The owner can change a link's permission at any time, and the change is immediate.** The server reads `permission` on every write, so a downgrade or a delete stops writes at once. The Edit dialog in the link list changes permission and vaults together; Delete revokes. *Why:* the owner asked to change it or revoke it. *If wrong:* nothing lost; the dialog is the only UI.

4. **Republishing overwrites visitor edits, with a warning.** Publishing over a target still replaces it (the existing "hard overwrite" ruling). A note publish finds its target by title or by the title the owner published it under (`ob_notes.published_title`), so a note a visitor renamed is still replaced rather than left beside the new copy. The conflict response counts `visitorEdits`, the notes in the target that visitors edited or created, and the overwrite confirm in the publish dialog says that many visitor changes are discarded. The editor's content tree marks visitor-edited notes, so the owner can read them before republishing. *Why:* the private vault is the owner's source of truth and openboard is a copy; merging plaintext edits back would need the vault keys and a merge UI, which this request does not cover. *If wrong:* the owner loses visitor work they wanted. They are warned with a count first, and can copy text from the editor's preview before confirming.

5. **Visitor edits never reach private vaults.** The write routes only touch `ob_notes` and `ob_vaults.updated_at`. There is no "pull into my vault" action. *Why:* the zero-knowledge boundary is the product's core promise; writing back would need the browser's keys and is a separate feature. *If wrong:* the owner copies visitor text by hand. Left open below.

6. **Provenance: `ob_notes.visitor_edited_at` and `ob_notes.published_title`.** `visitor_edited_at` is set on every visitor write, null for content the owner published; a republish creates fresh rows, so it clears. It is exposed as `visitorEdited: boolean`. `published_title` keeps the title the owner published a note under (null for a note a visitor added), so republishing finds a renamed note (ruling 4); the migration fills it from `title` for existing rows. *Why:* the owner needs to see what visitors changed (ruling 4) and the reader needs to know which bodies are untrusted (ruling 7). *If wrong:* one nullable column to drop.

7. **Visitor-edited notes render as untrusted.** The reader keeps the existing pipeline (markdown-it with raw HTML off, DOMPurify, Mermaid in its sandboxed frame), and for a note with `visitorEdited` it also turns every link that is not a resolved `[[wiki link]]` into plain text, the same rule `renderUntrustedMarkdown` applies to Ask answers. Published `inked://` images still resolve, because they can only point at images the owner published into that vault. Remote images are already plain links (and then plain text). The reader shows a small "Edited by a visitor" tag. `renderUntrustedMarkdown` itself is not called: it drops wiki links and images, which the board needs. *Why:* a Write link lets strangers put content in front of other visitors and the owner; a clickable external link is the phishing path. *If wrong:* an owner's own external link in a note a visitor touched becomes unclickable text until the next republish.

8. **Limits.** Title 1 to 200 characters, stored trimmed, with no control characters, line or paragraph separators, or bidi overrides and isolates. Body up to 100,000 characters, checked only when the body changes, so a visitor can still retitle a longer note the owner published. A vault refuses visitor writes that would take it past 5,000 notes or 32 MiB of note text in UTF-8 bytes (413 `vault_full`). The owner's publish limits do not change. *Why:* a Write link is anonymous; these bound what one link can cost without getting in the way of normal notes. *If wrong:* a visitor with a very long note is refused with a clear message; the constants are in one place (`server/src/openboard/visitor.ts`).

9. **Rate limit: 30 writes per minute per IP**, then a one-minute lock (429 with `retry-after`). A new `FailureLimiter` instance (`obWriteLimiter`) whose `attempt()` counts every write. Reads are not limited by it, so a locked writer can still read. *Why:* the visitor UI saves on an explicit Save, so 30 a minute is far above normal use, and the existing limiter class already gives the pattern. *If wrong:* a shared IP (an office) can lock itself out of writing for a minute.

10. **Concurrent edits: optimistic, like private notes.** A PATCH carries `baseUpdatedAt`; a mismatch is 409 `stale` and changes nothing. The visitor's draft stays in the editor, with a message to copy it and reload. Leaving a note, closing the drawer, starting a new note or closing the tab with unsaved changes asks first, and Save sends only the fields that changed. *Why:* two visitors on one link will collide; silent last-write-wins loses work without anyone noticing. *If wrong:* a visitor has to reload and re-apply; no data is lost.

11. **Index notes keep their role.** A visitor cannot create a note titled `Index`, rename a note to `Index`, or rename an existing folder Index note. They can edit an Index note's body. *Why:* `Index` makes a note its folder's hub on the map; letting visitors add or remove one changes the board's structure, which ruling 2 keeps out. *If wrong:* visitors cannot add a hub to a folder that lacks one.

12. **Where a new note goes.** The New note dialog asks for a title and a place: any vault the link grants, at its top level or in one of its folders. Default: the folder of the note being read, else the first vault's top level. After creating, the drawer opens it in edit mode. *Why:* a visitor needs to put a note somewhere; folders already exist and creating folders is out (ruling 2). *If wrong:* a cosmetic default.

13. **Images in visitor edits.** A visitor can reference an image already published in that vault (`inked://<id>`), but cannot upload. Removing an image reference in a visitor edit does not delete the image; orphaned images are dropped at the owner's next publish or unpublish in that vault, as today. *Why:* a visitor edit should never destroy owner content beyond the note text, which republish restores. *If wrong:* an orphan image keeps using the owner's quota until the next publish.

14. **No CSRF change.** Public write routes have no cookies, so CSRF does not apply, but the global `X-Inked: 1` rule for non-GET requests still holds and the visitor client sends it.

15. **Read stays the default everywhere.** The dialog preselects Read, the API defaults a missing `permission` to `read`, and the column default is `read`.

## Left open

- Pull visitor edits back into a private vault (needs keys and a merge UI).
- Revision history and undo for visitor edits.
- Visitor delete, move, folder creation and image upload.
- Showing the owner a diff of visitor edits against the private note.
- Per-link write rate limits (today only per IP).
- Wiki links resolve by case-insensitive title with the most recently edited note winning, so a visitor note titled "docs" takes over an owner's `[[Docs]]` buttons. The target still renders as untrusted, so this is cosmetic; a fix would prefer owner notes when resolving.

## Review outcome

A final review found no security issue. It found a lost-draft path, renamed notes surviving a republish, large owner notes being uneditable, a character-based vault cap and loose title rules; all were fixed and are reflected in rulings 4, 6, 8 and 10 above.
