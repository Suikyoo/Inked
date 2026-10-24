# Openboard authoring: design

Date: 2026-10-24

## Intent

The owner asked: "for the openboard, there's no full on view/edit unlike the main page of Inked. Add it to both the main control and the published page". Asked what an owner edit in the control should write to, they chose **the published copy**, and added: "in the openboard control, allow me to add openboard-original vaults rather than making a vault in Inked and publishing it".

So openboard stops being only a projection of private vaults and becomes a place you can write. Three things follow: an Edit|View editor on both openboard surfaces, owner writes against `ob_notes`, and vaults that are born in openboard with no private source.

The owner then said "do everything autonomously, I will be away for long". Every call below is a ruling made without them, in the manner of `2026-10-24-openboard-write-links-design.md`: what was decided, why, and what it costs if it is wrong.

Background: `2026-10-22-openboard-design.md`, `2026-10-24-openboard-write-links-design.md`.

## The hazard this spec exists to contain

Two facts from `docs/architecture.md:256` and `server/src/openboard/store.ts:106`:

- Nothing copies openboard content back into a private vault. An edit made in openboard lives only in `ob_notes`.
- `publish()` finds its target vault **by name**. On overwrite it deletes that vault's notes, folders and images (`store.ts:127-130`).

Put those together with native vaults and you get a data-loss path: author a vault called "Scratch" in the control, later publish a private vault that happens to be called "Scratch", and the only copy of the native vault is deleted. A published vault's content survives that — the private original is still there, encrypted. A native vault's content does not exist anywhere else. Rulings 2 and 11 exist for this.

## Scope

- **A shared `ObNoteEditor`** with an `Edit | View` segmented toggle, used by both the visitor drawer and the owner's control drawer. View renders the *draft* through the same `renderPublished` pipeline the reader uses.
- **Owner write routes** for notes, folders and vaults under `/api/openboard/*`, reusing the visitor write validation.
- **Native vaults**: `ob_vaults.origin`, a New vault form in the control, and folder/note creation inside native vaults.
- **Divergence warnings**: `owner_edited_at`, `ownerEdits` in the publish conflict, and a delete confirm that tells the truth for native vaults.

## Anti-goals

- **Owner edits flowing back into the private vault.** They do not, and this spec does not add a path. The control edits the published copy; the republish warning (ruling 4) is the whole mitigation.
- **Native vaults being encrypted or becoming private vaults.** Native content is plaintext on the server's disk, by construction. It sits outside the product's "plaintext never touches disk" promise, so the UI says so every time (ruling 10).
- **Images in native vaults.** `ob_images` rows are written by `publish()` from a private vault's encrypted images; there is no upload path in the control and this spec does not add one. A native note is text and `[[links]]`. An `inked://` reference in a native note renders as "Image unavailable", which the existing reader already handles.
- **Structural edits to published vaults.** Renaming or adding folders in a vault that republishing will replace wholesale invites confusion for no gain (ruling 9).
- **CodeMirror or vim in the openboard bundles.** Project A's editor stays in the notes app. These pages ship no crypto, store or session code (`docs/architecture.md:272`, enforced by `npm run check:openboard -w web`) and the editor here stays a `<textarea>`.

## API

| Method | Path | Notes |
|---|---|---|
| PATCH | `/api/openboard/notes/:id` | `{ baseUpdatedAt, title?, body? }` → `ObNote`; 409 `stale` when `baseUpdatedAt` is not current |
| POST | `/api/openboard/notes` | `{ vaultId, folderId \| null, title, body }` → 201 `ObNote`; native vaults only |
| POST | `/api/openboard/folders` | `{ vaultId, parentId \| null, name }` → 201 `ObFolder`; native vaults only |
| PATCH | `/api/openboard/folders/:id` | `{ name }` → `ObFolder`; native vaults only |
| POST | `/api/openboard/vaults` | `{ name, color }` → 201 `ObVault` with `origin: 'native'`; 409 `name_taken` |
| PATCH | `/api/openboard/vaults/:id` | `{ name?, color? }` → `ObVault`; native vaults only; 409 `name_taken` |
| GET | `/api/openboard/content`, `/api/openboard/preview` | `ObVault` gains `origin`; `ObNote` gains `ownerEdited` |
| POST | `/api/openboard/publish` | the 409 `conflict` body gains `ownerEdits`; a new 409 `name_taken` when the name belongs to a native vault |

Every owner route sits behind the existing `requireUser` + `X-Inked` CSRF guard, and checks vault ownership before anything else. `DELETE /api/openboard/{vaults,folders,notes}/:id` already exist and are unchanged on the wire; only the confirm text in front of them changes (ruling 11).

`core/src/openboard.ts` and `server/src/openboard/types.ts` are hand-kept copies of each other — both change together, as that file's header requires.

## Rulings

1. **`ob_vaults.origin`, `'published' | 'native'`, default `'published'`.** `ob_vaults.origin TEXT NOT NULL DEFAULT 'published' CHECK (origin IN ('published','native'))`, added by the same idempotent `PRAGMA table_info` + `ALTER TABLE` path `ob_links.permission` uses, so existing vaults become `'published'`. *Why:* every later ruling needs to tell the two apart, and a column that defaults correctly needs no migration of existing rows. *Cost if wrong:* if the distinction turns out to be per-note rather than per-vault, the column is in the wrong place and the create routes move.

2. **A publish that collides with a native vault's name is refused, never overwritten.** `publish()`'s vault lookup gains `AND origin = 'published'`, so a native vault is never a republish target; and before inserting, publish checks for a native vault of that name and throws 409 `name_taken` with a message naming the clash. *Why:* the overwrite branch is a delete. A published vault's content is recoverable from the private original; a native vault's is not. Asymmetric loss gets the cautious answer. *Cost if wrong:* the owner has to rename one of the two vaults before publishing, which is an annoyance. The alternative is silently destroying the only copy of something they wrote.

3. **An owner edit sets `owner_edited_at`, not `visitor_edited_at`.** A new nullable column, with `ownerEdited` on the `ObNote` DTO. *Why:* `visitorEdited` is not just a label — it drives the untrusted-body rendering that turns every non-wiki link into plain text (`Reader.tsx:76-80`) and the editor tree's tag. Owner-authored text is exactly as trustworthy as published text, and degrading the owner's own links would be a bug. *Cost if wrong:* none that loses data; if owner edits should be visually flagged like visitor ones, it is a UI change over a column that already exists.

4. **The publish conflict counts `ownerEdits` and the overwrite confirm names them.** Counted the way `visitorEdits` is (`store.ts:123`), and `PublishConflict` gains the field. The confirm says how many notes in the target the owner edited in openboard, alongside the visitor count, because republishing discards both. *Why:* ruling 2 protects native vaults; this protects edits made to *published* vaults, which are a real divergence the owner chose to accept. Accepting it is fine; being surprised by it is not. *Cost if wrong:* an extra sentence in a confirm dialog.

5. **A native vault's notes keep `published_title` NULL**, as visitor-added notes do. Nothing needs to distinguish them by that column; the distinguishing fact is the vault's `origin`. *Why:* `published_title` exists so a republish can match a note a visitor renamed (`store.ts` publish matching). A native vault is never republished, so the column has no work to do there.

6. **Owner writes reuse the visitor write validation.** `cleanTitle`, `checkBody`, `checkVaultText`, the note-count cap and the Index-title rules move from `server/src/openboard/visitor.ts` into a new `server/src/openboard/write.ts` under neutral names (`OB_NOTE_TITLE_MAX`, `OB_NOTE_BODY_MAX`, `OB_VAULT_NOTES_MAX`, `OB_VAULT_TEXT_MAX`); `visitor.ts` re-exports the `OB_VISITOR_*` names so nothing outside it breaks. *Why:* those caps protect the server's disk and the reader's browser, and both are the same whoever is typing. The owner is trusted not to be hostile, not trusted to be careful with a 32 MB vault. *Cost if wrong:* the owner hits a 100 KB note limit the notes app does not impose (the private editor's limit is the note-too-large path in `useNoteEditor`); raising it for owner writes is one constant.

7. **One editor component, two save functions.** `ObNoteEditor` takes `{ note, payload, mode, onSave, onCancel, onDirtyChange, resolveImage }` and knows nothing about tokens or sessions; the visitor page passes `saveVisitorNote`, the control passes the owner PATCH. *Why:* the Edit|View toggle, the dirty-draft guard, caret-at-end, the stale-save message and the Index-title rule are identical on both surfaces, and the write-links spec already paid for that behaviour once. *Cost if wrong:* if the two surfaces diverge later, splitting a component is cheaper than reconciling two that drifted.

8. **View renders the draft, not the saved note.** The preview builds a throwaway `ObNote` from the current title and body and calls `renderPublished` against the live payload, so `[[links]]` resolve exactly as they will once saved. On the visitor page the draft is rendered with `visitorEdited` forced true — the visitor's own text *will* be untrusted once saved, so showing it any other way would promise links that stop working. In the control the note's own flags are used unchanged. *Why:* a preview that lies about link behaviour is worse than no preview. *Cost if wrong:* a visitor sees their links as plain text in preview and that is also what readers get, so there is nothing to correct.

9. **Edit anywhere, create only in native vaults.** Owner note edits work in any vault, published or native. New folders and notes, and vault rename/recolour, are refused with 400 `not_native` on a published vault. *Why:* a note edit to a published vault is a contained divergence the republish warning covers. A new folder in one is content republishing will delete wholesale without ever matching it, which is a worse surprise for no benefit. *Cost if wrong:* dropping the origin check on those routes is a one-line change per route if the owner wants it.

10. **Native vaults are labelled as plaintext, every time.** The New vault form carries a one-line warning that a vault made here is stored unencrypted on the server, and native vaults wear a badge in the control's tree and vault list. *Why:* "private by construction — plaintext never touches disk" is one of four product principles (`PRODUCT.md`). Native vaults are a deliberate exception, and an exception the owner cannot see is a broken promise rather than a choice. *Cost if wrong:* a badge and a sentence are easy to remove if they are noise.

11. **Deleting a native vault says what it really does.** `DELETE /api/openboard/vaults/:id` already cascades (`store.ts:527`). In front of it, a published vault's confirm keeps today's unpublish wording; a native vault's says its notes are deleted for good because there is no other copy. *Why:* the same button means "stop sharing" on one row and "destroy the only copy" on the next. *Cost if wrong:* nothing; it is text in front of an unchanged route.

## Surfaces

**Visitor page.** `visitor/NoteEditor.tsx` keeps its save call and limits but hands its form body to `ObNoteEditor`, gaining the toggle. The drawer's `body` slot already hosts it (`VisitorPage.tsx:240-252`); nothing about the drawer, the dirty guard or Escape handling changes.

**Owner control.** `editor/ContentTab.tsx` renders published content read-only through `ReaderDrawer` today (`ContentTab.tsx:129`). Its `actions` slot gains an **Edit** button and its `body` slot the same `ObNoteEditor`, mirroring the visitor page exactly. The Content tab gains a New vault form, and, with a native vault selected, New folder and New note. Saving refetches the preview payload the tab already drives off.

## Files

| Path | Change |
|---|---|
| `server/src/db.ts` | `ob_vaults.origin`, `ob_notes.owner_edited_at`, both via the idempotent column-add path |
| `server/src/openboard/write.ts` | new — validation and caps shared by visitor and owner writes |
| `server/src/openboard/visitor.ts` | imports from `write.ts`, re-exports the `OB_VISITOR_*` names |
| `server/src/openboard/store.ts` | owner note/folder/vault writes; `origin` in publish matching; `name_taken`; `ownerEdits` in the conflict |
| `server/src/routes/openboard.ts` | the eight routes in the API table |
| `server/src/openboard/types.ts`, `core/src/openboard.ts` | `ObVault.origin`, `ObNote.ownerEdited`, `PublishConflict.ownerEdits` (kept identical) |
| `web/src/openboard/ObNoteEditor.tsx` | new — the shared editor with the Edit\|View toggle |
| `web/src/openboard/visitor/NoteEditor.tsx` | delegates its form to `ObNoteEditor` |
| `web/src/openboard/editor/ContentTab.tsx` | Edit action, editor in the drawer, New vault/folder/note |
| `web/src/openboard/api.ts` | the owner write calls |
| `web/src/openboard/publish/PublishDialog.tsx` | `ownerEdits` in the overwrite confirm; the `name_taken` message |

## Testing

- **Server (`server/test`)** — an owner edit updates the note and sets `owner_edited_at` without touching `visitor_edited_at`; a stale `baseUpdatedAt` is 409; creating a folder or note in a published vault is 400 `not_native`; a native vault blocks a same-name publish with 409 `name_taken` and its notes are still there afterwards (the regression test for the hazard above); the publish conflict reports `ownerEdits`; owner writes respect the body and vault-text caps; every owner route 404s on another user's vault.
- **Web** — `ObNoteEditor` toggles Edit|View and previews the *draft*; a visitor preview renders non-wiki links as plain text; the dirty guard still fires with the toggle in either position; `ContentTab` shows Edit only where editing is allowed and refetches after a save; the native-vault delete confirm differs from the unpublish one.
- **Gates** — `npm test` across all four workspaces; `npm run build -w web && npm run check:openboard -w web` to prove the openboard entries still carry no crypto, store or session code.
- **By hand** — author a native vault with a folder and two linked notes, share it on a Read link, confirm a visitor reads it; edit a published note in the control and confirm the next republish warns before discarding it; confirm the native-vault name collision is refused rather than silently overwriting.
