# Inked MCP: sign-in, config and vaults from inside the AI client: design

Date: 2026-10-13. Status: design approved section by section in conversation; awaiting review of this written spec. Base spec: `docs/superpowers/specs/2026-10-07-mcp-provisioned-actions-design.md`.

## Goal

Set up and run the Inked MCP without leaving Claude Code. The user only types credentials. They never run a terminal command, and they never see the path of a program, config file or credential file. Three things that need a terminal or a hand-edited file today move into the client:

1. **Sign-in.** Today this is `inked-mcp login` in a real TTY.
2. **Choosing vaults and actions.** Today this means hand-editing `~/.inked-mcp/config.json`.
3. **Creating a vault.** Today this is only possible in the web app.

The skills grow too. They gain a setup skill, a shared note-writing style guide, a "save this session to Inked" skill and a "document this codebase in Inked" skill.

## Decisions (owner's answers)

| Question | Decision |
|---|---|
| Where does the user type the password? | On a **local browser page** that the MCP serves on `127.0.0.1` and opens itself. The password never enters the chat or any tool argument or result. |
| Who approves a config change? | **The user, on the local page.** Claude can propose a change and open the page. Only the user's click on Apply writes the config. |
| Who approves a new vault? | **The user, on the local page.** Nothing is created until they click Create. |
| What access does Claude get to a vault it created? | It is **added to the access list automatically** after the user approves the creation. The vault starts empty, so this exposes nothing. |
| How do new tools appear after sign-in or a config change? | **In the same server process.** Tools are enabled or disabled and the server sends `notifications/tools/list_changed`. No restart or reconnect. |
| New skills | `inked-setup`, `inked-note-style`, `inked-save-session` and `inked-document-codebase`. The existing `inked-notes` is slimmed. |

### Rejected alternatives (and why)

- **Password as a tool argument, or typed in chat.** It would go to the model provider and into transcripts. That breaks the zero-knowledge promise.
- **MCP elicitation form in the client.** The MCP spec says form-mode elicitation must not carry passwords. Masking and transcript storage depend on the client.
- **Browser page with an elicitation fallback.** It adds a second code path for a rare case. The tool result already returns the page URL, so a user without a desktop browser can open it by hand.
- **Sign in, then reconnect the server.** It is simpler, but it puts a manual step back in front of the user.
- **Change config through the tool call alone.** The only gate would be the client's tool-permission prompt, which auto modes and allowlists skip. A prompt injection in a note could then widen access.
- **Claude may narrow access freely and needs approval only to widen it.** It is slightly faster for lockdowns, but it doubles the code paths. Every change going through the page is easier to reason about.

## 1. Lifecycle

`serve` always starts, even with no credential, a stale credential or a broken config. It never exits for those reasons, because an exited server in Claude Code shows up only as "failed" in `/mcp`, with no way forward for the user.

### Runtime (`src/runtime.ts`, new)

`Runtime` owns the live state and is the only place it changes:

```ts
type RuntimeState =
  | { kind: 'signed-out'; reason?: string }                          // no credential, or it went stale
  | { kind: 'config-error'; session: Session; message: string }      // signed in, config unusable
  | { kind: 'ready'; session: Session; policy: Policy; ops: Ops };
```

- `start()`: loads the credential and config, then signs in. A missing credential gives `signed-out`. `CredentialStale` gives `signed-out` with reason "Your Inked password changed; sign in again". A `ConfigError` gives `config-error`. Network errors at start also give `signed-out`, with the error message as the reason, so `inked_status` can explain it.
- `signIn(cred)`: saves the credential, opens a new `Session` and closes the old one if any. Then it re-resolves the policy.
- `reload()`: re-reads the config, re-resolves the policy against the current vault list and builds a new `Ops`.
- `signOut()`: deletes the credential file, closes the session and moves to `signed-out`.
- After every state change, `Runtime` calls `tools.sync(state)`.
- Tool handlers never keep an `Ops` reference. Each call asks `runtime.ops()`, which throws `ToolError('signed_out')` when not `ready`. A swap mid-call cannot leave a handler pointing at a closed session.
- `CredentialStale` raised by any tool call moves the runtime to `signed-out`. The credential file is kept, so `sign_in` overwrites it. The tool result says to sign in again.
- Changes are serialized: one state change at a time, guarded by a promise chain.

### Tool registration (`src/tools.ts`)

- Every tool is registered once at startup. The `RegisteredTool` handles are kept.
- `sync(state)` calls `.enable()` or `.disable()` per the visibility rules in section 3. The SDK sends `tools/list_changed` when connected.
- `buildInstructions` stays a startup snapshot, because MCP instructions cannot change after `initialize`. Its wording covers both states ("If you are not signed in, call sign_in"). The skills carry the rest.

### CLI (`src/cli.ts`)

- `serve`: builds a `Runtime`, starts it, connects stdio. On stderr it logs one line, either the existing banner or `inked-mcp <version>: signed out`.
- `login`, `status` and `logout` stay unchanged, for other MCP clients and headless machines. Skills never mention them.
- `config` (new): opens the config page from section 2 in a standalone process, signs in with the saved credential and exits after Apply or Cancel. This is the escape hatch after the user removes `config.change`.

## 2. Local approval page (`src/approval.ts`, new)

One small HTTP server per request, using `node:http` only.

### Security

- It binds to `127.0.0.1` on a port the OS picks.
- The URL is `http://127.0.0.1:<port>/t/<token>`, where the token is 32 random bytes in base64url. Any other path returns 404. The token sits in the path, not the query, so opening it on Windows needs no shell escaping.
- `Host` must equal `127.0.0.1:<port>`; anything else gets 421. This blocks DNS rebinding.
- Every POST must carry the per-page CSRF token as a hidden field. Its `Origin` must be `http://127.0.0.1:<port>` or absent.
- Response headers:
  - `Content-Security-Policy: default-src 'none'; style-src 'nonce-…'; form-action 'self'; frame-ancestors 'none'`
  - `Cache-Control: no-store`
  - `Referrer-Policy: same-origin` (not `no-referrer`: with it, browsers send `Origin: null` on the form POST, which the Origin check refuses)
  - `X-Content-Type-Options: nosniff`
- No scripts. Plain HTML forms only.
- The server closes after the first successful submit, after Cancel, or after 5 minutes. The token dies with it.
- Single flight: while one page is open, another request gets `ToolError('busy', 'Finish or cancel the open Inked page first.')`.
- The password is never logged, never put in a tool result and never written to disk. Only the derived credential is saved, exactly as `login` does today.
- The URL is returned in the tool result only when no browser could be opened (outcome `open_link`), and then reaches the model provider. That is acceptable. The page is reachable only from this machine, and a local process running as this user could already edit the config.

### Opening the browser

- Windows: `explorer.exe <url>`. macOS: `open <url>`. Linux: `xdg-open <url>`.
- The call is fire-and-forget. When the opener reports a failure, the tool returns at once with `outcome: "open_link"`, the URL and the line "No browser could be opened. Ask the user to open this link on this computer and finish there, then call inked_status." The page stays live until it is submitted or times out.

### Waiting

- The tool call awaits the page outcome. On success the page shows "Done. You can go back to Claude Code." and closes the server.
- If the client cancels the tool request, the page keeps working until it is submitted or times out. On submit, the state change and `list_changed` still happen.

### Page modes

All pages are inline HTML and CSS in the Inked palette, with no external assets.

1. **Sign-in.** Fields: Inked URL (pre-filled with the last `baseUrl` if a credential exists), username, password. Submit runs `createCredential`, then `runtime.signIn`. Wrong credentials (401/403), a bad URL, an unreachable server or a lockout show an error on the page, keep the fields except the password, and let the user retry. Outcome: `signed_in`, `cancelled` or `timed_out`.
2. **Config.**
   - Controls:
     - an "All vaults" toggle;
     - one checkbox per vault, by decrypted name;
     - action groups: Read, Write, Organize, Create vaults, plus "Let Claude open this settings page" (`config.change`);
     - writes per minute (1–1000).
   - Pre-fill: the current config, or Claude's proposal with each difference marked "proposed by Claude".
   - Unchecking `config.change` shows: "Claude won't be able to open this page again. To undo, run `inked-mcp config` in a terminal."
   - In `config-error` state, the page shows the error and says Apply replaces the file.
   - Apply writes the config atomically (temp file plus rename in the same folder), then calls `runtime.reload()`.
   - Vaults are written by name when the name is unique in the account, and by id otherwise.
   - Outcome: `config_applied` with a summary, `cancelled` or `timed_out`.
3. **Create vault.** Shows the name and color, both editable, plus the line "Claude will be able to read and write this vault." Create runs the steps in section 3. Outcome: `vault_created`, `cancelled` or `timed_out`.

## 3. Tools, actions, policy

### New actions (`src/policy.ts`)

- `vault.create`, in a new group `@manage`.
- `config.change`, in no group. Only this permission lets Claude open the config page; the page still needs the user's Apply.
- **Default with no config file:** `{ version: 1, vaults: "*", actions: ["@read", "config.change"] }`. A new user can widen access from Claude without ever seeing the file.
- **Compatibility:** the config stays `version: 1` and the new actions are additions. Existing configs keep working. Without `config.change` they get no `change_config` tool, and `inked_status` says how to enable it.

### Tool table

| Tool | Visible when | Behavior |
|---|---|---|
| `inked_status` | always | Returns `{ signedIn, user?, server?, vaults?, actions?, writesPerMinute?, problem? }`. `problem` is plain words, for example "Your Inked password changed; sign in again" or "The access settings are invalid: <message>. Use change_config to fix them". Never a path. |
| `sign_in` | `signed-out` | Opens the sign-in page and awaits it. Returns `{ outcome, user?, tools? }`. |
| `sign_out` | `ready` or `config-error` | `runtime.signOut()`. Returns a note that changing the Inked password is what revokes copies elsewhere. |
| `change_config` | `ready` with `config.change`, or `config-error` | Optional proposal: `vaults` (`"*"` or names/ids), `actions` (groups or action names), `writesPerMinute`. The proposal is validated with `parseConfig` before the page opens; an invalid proposal returns an error and opens nothing. With no arguments it opens the current config. Returns the outcome and a summary of the new access. |
| `create_vault` | `ready` with `vault.create` | `name`, optional `color` (default: the least-used of the four Inked vault colors). Opens the confirm page. On Create it runs `generateVaultKey`, then `encryptVaultMeta`, then `POST /api/vaults`. If the config's `vaults` is a list, it appends the new vault (by name if unique, else id), writes the config atomically and reloads. Counts against the write limit. Returns `{ outcome, vault?: { id, name } }`. |
| existing 12 tools | `ready` and allowed by policy | Unchanged. |

### Other changes

- `InkedApi.createVault(body)` is added. `VAULT_COLORS` and `nextVaultColor` move from `web/src/lib/util.ts` to `core`, so `web` and `mcp` share them.
- Audit log entries, ids only: `signed_in`, `sign_out`, `config_applied`, `vault_created { vaultId }`, and `cancelled` or `timed_out` for any page.
- New `ToolError` kinds: `signed_out` and `busy`. `cancelled`, `timed_out` and `open_link` are outcomes in a normal result, not errors.

## 4. Skills

All skills live in `mcp/plugin/skills/<name>/SKILL.md` and use bare tool names.

### `inked-setup` (new)

Triggers: inked tools missing or failing, "sign in to Inked", "let Claude write to <vault>", "make a new vault", "what can you do in Inked".

- **Prerequisite check:** inked is missing from the tool list, or `/mcp` shows it failed. Run `node --version`. If Node is missing or older than 22.13, offer to install it and ask before installing: `winget install OpenJS.NodeJS.LTS` on Windows, `brew install node` on macOS, the distro package or nodesource on Linux. Then ask the user to run `/reload-plugins`.
- **Sign-in:** call `inked_status`; if signed out, tell the user a browser page will open for their Inked password, then call `sign_in`. On `timed_out`, offer to try again.
- **Permissions:** explain what is allowed in plain words using `inked_status`. To change it, call `change_config` with a proposal and tell the user to confirm in the browser.
- **New vault:** `create_vault`; the user confirms in the browser.
- **Troubleshooting:**
  - stale credential: sign in again;
  - tools did not appear after sign-in: reconnect inked in `/mcp`;
  - `busy`: ask the user to finish the open page.
- **Hard rules:**
  - Never ask for the Inked password in chat.
  - If the user pastes it anyway, don't repeat it, and suggest changing it in the Inked web app.
  - Never mention Inked's own program, config or credential paths, environment variables or CLI commands unless the user asks how it works.
  - Repository file paths in notes are fine; this rule covers only Inked's own files.

### `inked-notes` (slimmed)

Keeps orientation, read-before-write, conflicts, filing, the research build order and safety. Style rules move to `inked-note-style`. Adds:
- if the tools are missing, use `inked-setup`;
- recipes for `create_vault` and `change_config`.

### `inked-note-style` (new)

Loaded by the writing skills before they write.
- One idea per note.
- Titles: unique in the vault, specific noun phrases, no dates except in log notes.
- Split a note when it covers two or more concepts worth linking, or runs past about 600 words.
- Each folder's Index is a hub: a one-line intro plus `[[links]]` to its notes.
- At least two `[[links]]` per note; no orphans.
- Markdown: `##` sections, short paragraphs, lists for parallel items, fenced code only when code is the point, no raw HTML.
- Never write secrets, tokens or credentials into a note.

### `inked-save-session` (new)

Triggers: "save this to Inked", "note this down", "log what we did".
1. **Select.** Keep decisions with their reasons, findings, gotchas and open TODOs. Drop chatter, transient debugging steps and anything secret.
2. **Locate.** `list_vaults`, `get_tree`, then choose the vault and folder. If that is unclear, ask once. `search` per topic.
3. **Write.** An existing topic note gets `append_to_note` with a `## <YYYY-MM-DD> — <context>` section. A new topic gets `create_note`, following `inked-note-style`.
4. **Gate.** Up to three notes: write directly. More than three: show the planned titles and target first and wait for an OK.
5. **Report** the titles written or appended.

### `inked-document-codebase` (new)

Trigger: "document this repo in Inked".
1. **Explore read-only:** README, manifests, entry points, directory map.
2. **Plan the outline:** Overview, Architecture, `Modules/<name>` (one note per module), Data flow, Decisions, Glossary.
3. **Ask** whether to use a new vault (`create_vault`) or a folder in an existing vault. Show the outline and wait for an OK.
4. **Build** in the research order from `inked-notes`. Each module note has purpose, key files (repo-relative paths), public interface and `[[dependencies]]`.
5. **Limits:** about 60 notes; ask before going over. Short snippets only. Never `.env` contents or secrets.
6. **Re-run:** update rather than duplicate. Search first, then append a `## Changes since <date>` section.

## 5. Docs

- `mcp/README` and the generated plugin README: "Sign in once" becomes "Ask Claude to sign you in to Inked". The CLI moves under "Other MCP clients / headless".
- `docs/mcp.md`: document the new default, the new actions, the approval page and its security properties, and `inked-mcp config`.

## 6. Testing (vitest, in `mcp/test`)

- **`runtime.test.ts`.** The full state cycle:
  - start signed out;
  - sign in to `ready`;
  - reload;
  - a stale credential mid-call goes to `signed-out` with the file kept;
  - a config error gives `config-error`;
  - sign out deletes the file;
  - state changes are serialized.
- **`approval.test.ts`.**
  - Wrong token gives 404, wrong `Host` gives 421, a missing or wrong CSRF token or a foreign `Origin` is rejected.
  - Timeout gives `timed_out`. A second request gives `busy`. The server closes after submit.
  - The CSP header is present. The password never appears in logs or results.
- **`tools.test.ts`.**
  - The `sync` visibility table, for each state and policy.
  - `list_changed` is sent on a swap, checked with the SDK's in-memory transport.
  - Handlers use the live `Ops`.
- **`policy.test.ts`.** `@manage`, `config.change`, the new default, old configs still parse.
- **`ops-write.test.ts`.** `create_vault` against the test Inked:
  - the vault decrypts with its name;
  - it is appended to a list config;
  - a `"*"` config is untouched;
  - the write limit applies.
- **`skill.test.ts`.** Loops over every skill folder:
  - front matter is valid;
  - each skill names only existing tools;
  - every tool appears in at least one skill.
- **`cli.test.ts`.** `serve` starts with no credential, and `config` opens the page.

## 7. Release

- Bump `inked-mcp` and the plugin to `0.2.0`.
- Regenerate the `inked-plugin` repository from `mcp/`, as for 0.1.0: `plugin/`, `package.json` and the README.

## Out of scope

- Deleting through the MCP. This is unchanged: there is no delete tool.
- Elicitation support.
- Remote or OAuth MCP transport.
- Importing local Markdown folders. This was considered and deferred.
