# Note PIN lock: design

Date: 2026-10-22

## Intent

Inked encrypts everything in the browser, but once the owner is signed in every note is decrypted in memory and readable by anyone sitting at that browser. The owner does not feel safe leaving some notes behind only that. This feature adds an extra lock on individual notes: a locked note is encrypted with its own key, and that key can only be recovered by typing a 6-digit PIN (or, as a fallback, the account recovery key). Without the PIN, a signed-in session sees only "Locked note".

The owner first asked for a passkey-derived key and then chose a PIN instead, because a PIN works on every device. The owner understands the trade-off described under "What the lock does and does not protect".

## Goals

- Lock a single note with a 6-digit PIN from its menu; unlock to read and edit it; remove the lock; change the PIN.
- A locked note's title and body are unreadable without the PIN, even in a signed-in session and even to the server operator.
- Locked content never leaks into search, the semantic index, Ask/RAG, the concept map, previews, openboard publishing or the MCP tools.
- A forgotten PIN is recoverable only through the account recovery key. The owner is told this before setting a PIN.
- The dialog and the docs state the honest limits of a 6-digit lock.

## Non-goals

- No passkeys or WebAuthn in this version.
- Not hiding that a locked note exists: its id, folder, size, timestamps and the fact it is locked stay visible to the server and in the tree.
- No lock on folders or vaults, and no sharing of locked notes.
- Images are not protected (see Known limits).
- No attempt to stop a determined attacker who holds both the owner's password and a database copy (see below).

## Anti-goals (a failure even if it technically works)

- Any plaintext of a locked note, or its title, landing in `state.bodies`, a search or embedding index, a prompt sent to an LLM, an openboard publish, or an MCP response.
- Storing the PIN, or anything from which the PIN can be read back without guessing it.
- A forgotten PIN being silently recoverable through the password alone.
- Corrupting or losing a note while locking or unlocking it (the conversion must be atomic).

## What the lock does and does not protect

| Attacker has | Result |
|---|---|
| Someone at your unlocked browser without the PIN | Blocked. Wrong guesses are slowed and counted. |
| A hijacked session running script in the page | Slowed, not blocked. The script can try PINs through the page; each try costs one argon2 run (about a second), so all 1,000,000 tries take days. |
| Your password only, no database | Blocked. |
| A stolen database only | Blocked in practice: needs your password and the PIN together. |
| Your password and a copy of the database | Not blocked. They can try all 1,000,000 PINs offline; each costs one argon2 run, so it is hours to days on rented hardware, not forever. |
| Your recovery key and a copy of the database | Not blocked. The recovery key opens locked notes. |

Server-side attempt counting is advisory. The server cannot verify a PIN and a script that never reports a failure is never counted, so the counter only defeats casual guessing through the UI.

## Decisions (by the owner)

- **PIN, not passkey.** Exactly 6 digits, typed by the user. The owner accepts the risk in the table above.
- **Never stored.** The PIN is never stored in any form. A wrong PIN fails by failing to decrypt.
- **Recovery:** a forgotten PIN is recoverable only with the account recovery key; the password alone cannot recover it. If neither the PIN nor the recovery key is available the note is lost. (The owner did not answer this question directly; it was my recommendation and was not objected to, so it is recorded as a call below.)

## Constraints from the codebase (verified)

- Encryption lives in `core/src/crypto`: AES-GCM with the `"v1." + base64url(iv12 || ct || tag16)` format (`cipher.ts`); `encryptNoteMeta/decryptNoteMeta` (JSON `{title}`, AAD `inked/note-meta/<vaultId>/<noteId>`) and `encryptNoteBody/decryptNoteBody` (AAD `inked/note-body/<vaultId>/<noteId>`) in `fields.ts` take a `CryptoKey`, so a per-note key can be passed straight in. AAD strings are in `aad.ts`. `keys.ts` has `wrapKey(key, kek, aad)`, `unwrapKey(wrapped, kek, aad, role, extractable)` with `KeyRole = 'userKey' | 'vaultKey'`, and `generateVaultKey` to copy for a note key. Argon2id runs through hash-wasm in `kdf.ts` (`argon2Direct`, injectable `Argon2Fn`) and in a worker in the web app (`web/src/lib/argon2.worker.ts`); `DEFAULT_KDF_PARAMS` and `MIN_KDF_PARAMS` are m=65536 KiB, t=3, p=1, with `assertKdfParams` caps m<=1048576, t<=16, p<=8.
- The account key is the `userKey`: a non-extractable AES-GCM `CryptoKey` held in `AppStore` (`web/src/state/store.ts`), set in `enterUnlocked`, cleared in `dropKeys`. Because it is non-extractable it cannot be mixed into HKDF, so "PIN combined with the account key" has to be nested wrapping.
- Recovery: `recovery.ts` (`generateRecoveryKey`, `parseRecoveryKey`, `deriveRecoveryKeys` giving `recoveryKEK`) and the store's `recover`, `prepareRecoveryKeyRotation`, `commitRecoveryKeyRotation`, `changePassword`. Only the `userKey` is re-wrapped today; `changePassword` leaves the userKey unchanged, `recover` keeps it, rotation replaces the recovery KEK.
- Server: Fastify and `node:sqlite`; notes table `notes(id, vault_id, folder_id, enc_meta, enc_body, size, created_at, updated_at)`; no migration framework (`CREATE TABLE IF NOT EXISTS`, `PRAGMA user_version = 1`), so a new table is easy and new columns on `notes` need an explicit guarded `ALTER`. `PUT /api/notes/:id` uses optimistic concurrency via `baseUpdatedAt`/`bumpTimestamp`. `GET /api/vaults/:id/bodies` returns every body and feeds search, graph, semantic, Ask and MCP; `GET /api/vaults/:id/tree` returns heads with `enc_meta`. `schemas.ts` has `ciphertext(max)` (pattern `^v1\.[A-Za-z0-9_-]{38,}$`) and `wrappedKey` (1024 chars). `FailureLimiter` is in-memory only.
- Readers of decrypted content that must be taught about locked notes: the web store (`loadBodies`, `loadNote`, `saveNoteBody`, `renameNote`, copy/duplicate, `refreshNoteHead`, `pending.ts`), search (`core/src/search`, HomePage, askStore, `mcp/src/ops.ts`), the semantic store and `note_vectors`, RAG/Ask (`core/src/rag`, `web/src/ask`), the concept map (`web/src/map/graph.ts` `buildVaultGraph`, `localGraph`, backlinks in `NotePane`), `NodePreview`, openboard `collect.ts`, and the MCP vault model and tools.
- UI: note menu in `web/src/components/VaultTree.tsx` (`itemsFor`), dialogs in `components/Dialog.tsx` (`PromptDialog` trims and rejects empty, so a PIN dialog needs its own input), idle lock in `components/AppShell.tsx` (`useIdleLock`, 15 minutes), `AppStore.lock()`/`dropKeys()`.
- Tests: Vitest everywhere (`npm test -w core|server|web|mcp`); `core/src/crypto/crypto.test.ts`, `server/test/data.test.ts`, `server/test/helpers.ts` (`makeApp`).

## Design

### Key layering

Per locked note there is a random AES-GCM 256 note key.

- The note's title and body are encrypted with the note key (same `v1.` format, same note AAD strings, so server validation is unchanged). Because the key differs from the vault key, a locked note cannot be swapped with an ordinary note's ciphertext.
- `pinWrap` = the note key wrapped first by the `userKey` (AAD `inked/note-key-user/<noteId>`), then that wrapped value encrypted by the PIN key (AAD `inked/note-key-pin/<noteId>`). The PIN key is `argon2id(PIN, pinSalt, kdfParams)`, 32 bytes. Opening needs both the PIN and the `userKey`.
- `recoveryWrap` = the note key wrapped by the account `recoveryKEK` (AAD `inked/note-key-recovery/<noteId>`). It exists so the recovery key can reset a forgotten PIN. It is the documented weak point: whoever holds the recovery key and the database can open locked notes.
- Add `aad.noteKeyUser(noteId)`, `aad.noteKeyPin(noteId)`, `aad.noteKeyRecovery(noteId)` and `KeyRole 'noteKey'`.
- KDF parameters are stored per lock so they can be raised later. Default is `DEFAULT_KDF_PARAMS` with `t` raised so a PIN derivation takes about 1 second on a mid-range phone; never below `MIN_KDF_PARAMS`.

### Data (server)

New table `note_locks(note_id PRIMARY KEY REFERENCES notes ON DELETE CASCADE, lock_id, pin_wrap, recovery_wrap, kdf_salt, kdf_params, fails INTEGER NOT NULL DEFAULT 0, locked_until TEXT, created_at, updated_at)`. Note rows keep their current shape; a note is locked exactly when it has a `note_locks` row. Note head JSON gains `locked: boolean`. Deleting a note cascades.

### Server API (owner, session cookie, `X-Inked: 1` on non-GET)

- `POST /api/notes/:id/lock` — body `{ pinWrap, recoveryWrap, kdfSalt, kdfParams, encMeta, encBody, baseUpdatedAt }`: in one transaction, requires the note be unlocked and `baseUpdatedAt` current (409 `conflict` otherwise), stores the note re-encrypted under the note key, inserts the lock row, deletes that note's `note_vectors` row.
- `GET /api/notes/:id/lock` — returns `{ pinWrap, kdfSalt, kdfParams, lockedUntil }`; refuses with 423 and `retryAfter` while `locked_until` is in the future.
- `POST /api/notes/:id/lock/failed` and `.../lock/ok` — the client reports a wrong PIN or a success. After 5 reported failures the server sets `locked_until` (15 minutes) and refuses `GET .../lock`; `ok` resets. Advisory only (see table).
- `POST /api/notes/:id/unlock` — body `{ encMeta, encBody, baseUpdatedAt }`: re-encrypted under the vault key, deletes the lock row, in one transaction.
- `PUT /api/notes/:id/lock/pin` — body `{ pinWrap, kdfSalt, kdfParams }` to change the PIN; `PUT .../lock/recovery-wrap` body `{ recoveryWrap }`.
- `POST /api/auth/locked-notes/rewrap` — atomic bulk update of `recoveryWrap` for recovery-key rotation.
- `PUT /api/notes/:id` keeps working for a locked note (the client sends ciphertext under the note key) but can never remove the lock row.
- `GET /api/vaults/:id/bodies` excludes locked notes' bodies entirely, so they are never downloaded for search, graph, semantic indexing, Ask or MCP. `GET /api/vaults/:id/tree` includes them with `locked: true`.
- `PUT /api/notes/:id/vector` for a locked note is refused.
- Owner-only throughout; another user's note gives 404.

### Client behavior

- `NoteView` gets `locked`. A locked note shows as "Locked note" with a lock icon in the tree, the map (no link edges), search results (title shown as "Locked note", never matched), and previews.
- Opening a locked note shows a 6-digit PIN field (numeric keypad on phones, no autofill, not stored anywhere). The client fetches the lock material, runs argon2 in the existing worker, decrypts, and keeps the note key and plaintext only in a separate in-memory `lockedNotes` cache. Plaintext of a locked note must never enter `state.bodies`, the semantic index, Ask context or openboard collection.
- Wrong PIN: clear message, an increasing delay on the client (30 seconds after 5 failures, doubling), failures reported to the server.
- Re-lock: the note key and plaintext are dropped after 5 minutes without interaction with that note, when the app locks or the user signs out (`dropKeys`), and when the note is closed. The 5-minute figure is my call.
- Menu items on a note: "Lock note…", and for a locked note "Unlock (remove lock)…", "Change PIN…", "Forgot PIN (use recovery key)…". Moving a locked note is allowed without the PIN; renaming and editing need it unlocked; deleting is allowed without the PIN as for any note.
- Setting a PIN: enter it twice. Reject PINs that are not exactly 6 digits, all the same digit, or a straight run (123456, 654321). The dialog states, before the PIN is accepted: "A 6-digit PIN can be guessed by someone who has both your password and a copy of the database. If you forget the PIN and lose your recovery key, this note is gone for good."
- Forgot PIN: the user pastes the recovery key, the client unwraps `recoveryWrap`, then asks for a new PIN and re-wraps.
- Pasting images into a locked note is disabled (images are not protected, see Known limits).

### Readers (all must exclude locked notes)

Search and title search; semantic embedding, coverage, and dropping any existing vector at lock time; Ask/RAG retrieval and the text fallback; the concept map and backlinks (a locked note neither links out nor appears as a link target); `NodePreview`; openboard publish collection, where locked notes are skipped and counted before the destructive step exactly like unreadable notes (so an overwrite never silently removes the published copy without telling the owner); MCP `read_note`, `update_note`, `append_to_note`, search and tree titles, which refuse with a clear "note is locked" error and show titles as "Locked note".

### Account flows

- Password change: nothing to do (the `userKey` is unchanged).
- Recovery with the recovery key (forgot password): the `userKey` is preserved, so locked notes keep working with their PINs.
- Recovery-key rotation: every locked note's `recoveryWrap` needs re-wrapping under the new `recoveryKEK`, which needs the note key, which needs that note's PIN. The rotation dialog lists the account's locked notes and asks for their PINs. Notes whose PIN is not provided keep their old `recoveryWrap`; they are listed as "still openable with your previous recovery key; rotate again after entering their PIN". Rotation itself is never blocked.

### Known limits

- Images referenced by a locked note stay encrypted under the vault key in the shared images table, not under the note key. They are readable in a signed-in session. Documented, not fixed.
- Size, timestamps, folder, and the existence of the note are visible.
- The note key and plaintext sit in page memory while unlocked.

## Clarifications from the builder check

- **Guard against writing the wrong ciphertext into a locked note.** The server cannot tell note-key ciphertext from vault-key ciphertext, so each lock gets a random `lockId` (16 random bytes, base64url, regenerated every time a note is locked), stored in `note_locks` and returned in the note head JSON and by `GET .../lock`. `PUT /api/notes/:id` on a locked note must carry the matching `lockId` or it gets 409 `locked`; a PUT without `lockId` to a note that is currently locked, or with one to a note that is not, is refused the same way. A stale client, another tab or MCP therefore cannot overwrite a locked note with vault-key ciphertext. MCP never writes locked notes at all.
- **Other copies of a note's content.** The server has no revisions, trash, soft delete, export, import or account-delete code, so there is no other stored copy to protect. The note menu has no duplicate action (Open, Rename, Move, Publish, Delete today); if the builder finds one, it is refused for a locked note. Offline pending edits in `pending.ts` hold ciphertext, and for a locked note they must be encrypted under the note key and carry the `lockId`.
- **Forgot PIN** resets the PIN and keeps the lock. It needs the signed-in session plus the pasted recovery key, does not call `GET .../lock`, and so bypasses the advisory lockout. `PUT .../lock/pin` also resets `fails` and `locked_until`, as does any successful `lock/ok`, from any device.
- **userKey stability.** Only `changePassword` and `recover` exist and both keep the `userKey`. There is no account reset, multi-device enrollment or vault-key rotation today. If one is ever added it must re-wrap every `pinWrap`'s inner layer, so it is called out in `docs/architecture.md`.
- **No sharing exists.** Vaults belong to one user (`vaults.user_id`); invites create separate accounts, not shared vaults. So there are no collaborators to hide locked notes from.
- **Client-side delay state** (30 seconds after 5 failures, doubling) is kept per note in `sessionStorage`, so a page reload does not reset it but closing the tab does. The server counter is global per note and advisory.
- **Rotation with skipped PINs:** the dialog warns clearly that the old recovery key can still open the listed notes, which matters most if that key was the reason for rotating, and tells the owner to rotate again after entering those PINs. It does not block.

## Left to the builder

Exact table DDL and column types; API payload shapes within what is above; the argon2 `t` value that gives about 1 second on a mid-range phone; the PIN dialog component and keypad styling within `DESIGN.md`; the `lockedNotes` cache shape; how the rotation dialog collects PINs; error copy beyond what is quoted; test design, including leak tests for each reader above.

## Calls made without the owner (review these)

- Recovery is through the account recovery key only (the owner was asked and did not choose between this and password recovery).
- Server-side counting is advisory and lockout is 5 reported failures for 15 minutes; the client delay is 30 seconds after 5 failures, doubling.
- Idle re-lock is 5 minutes of no interaction with the note, plus app lock, sign out and closing the note.
- PIN rules: exactly 6 digits, no all-same-digit, no straight runs; entered twice.
- Moving and deleting a locked note do not need the PIN; renaming and editing do.
- Recovery-key rotation never blocks, and lists notes that keep the old recovery wrap.
- Images in locked notes are not protected and pasting images into a locked note is disabled.
- Locked notes are skipped (with a count shown first) by openboard publishing and excluded from the MCP tools instead of being unlockable through them.
- `docs/architecture.md` gets a section covering the layering, the table above and the known limits.
