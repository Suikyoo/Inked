# Inked MCP server

## What it is

`inked-mcp` is a local MCP server that lets an AI client (Claude Code, Claude Desktop, Cursor and others) read and write your Inked notes. It runs on your machine, over stdio, and acts as you: it signs in, decrypts and encrypts everything locally, and talks to your Inked server through the normal API. The Inked server stays zero-knowledge. It never sees your password, a key that can decrypt, or any plaintext, and it cannot tell the MCP from a browser.

You decide what the AI may do. A config file lists which vaults it may touch and which actions it may take. Tools you do not grant are never registered, so the AI never sees them. There is no delete tool under any config.

One thing to understand clearly: whatever the MCP returns to the AI client (note titles, bodies, search results) leaves your device and goes to the model provider behind that client. That is inherent to using an AI with your notes, and it is your choice. Only grant access to vaults you are comfortable sharing that way.

## Install

From the repository root:

```bash
npm install
```

```bash
npm run build -w mcp
```

```bash
npm install -g ./mcp
```

Check that it works:

```bash
inked-mcp status
```

Before you sign in, `status` tells you to run `inked-mcp login` first. After signing in it shows who you are, the vaults and actions the config allows, and the write limit.

## Sign in

**In an AI client, ask it to sign you in to Inked.** The server starts even without a credential and offers a `sign_in` tool. The tool opens a page on `http://127.0.0.1` in your browser, where you type your Inked address, username and password. The password stays in that page and in the server process; it never reaches the AI. When you submit, the server saves the same credential `login` would, and the note tools appear without a restart. See [The local approval page](#approval-page).

The rest of this section is the terminal alternative, for headless machines and clients without a browser.

```bash
inked-mcp login
```

Run this in a real terminal (PowerShell or cmd on Windows). The hidden password prompt needs a terminal that is a TTY, so it does not work in Git Bash/mintty. If PowerShell's execution policy blocks the `inked-mcp.ps1` shim, run `inked-mcp.cmd login` instead. If you did not install globally, `node <path-to-repo>/mcp/dist/cli.cjs login` does the same.

It asks for your Inked URL, your username and your password. You can pass the first two as `--url` and `--username` to skip those prompts. The password is typed hidden and is never saved.

What is saved is a credential file at `~/.inked-mcp/credential.json`: the URL, your username and the master secret derived from your password. The master secret is enough to sign in and decrypt your data, but it cannot reveal your password. Any program running as your user can read the file, so treat it like a key.

To revoke it, change your Inked password. The saved credential then stops working and the server ends your other sessions. `inked-mcp logout` deletes the file on this machine, but it cannot revoke a copy that may exist somewhere else, so change your password if that matters.

If you run `inked-mcp login` again while an AI client is open, restart the client so it starts a fresh `serve`. A running server keeps the old credential.

The default folder is `~/.inked-mcp`. Set the `INKED_MCP_HOME` environment variable to use another folder for the credential, config and audit log.

## Choose what the AI may do

The config file is `~/.inked-mcp/config.json`. If it does not exist, the default is read-only access to every vault, plus `config.change`, so the AI can open the settings page for you to approve.

```json
{
  "version": 1,
  "vaults": ["Research"],
  "actions": ["@read", "note.create"],
  "limits": { "writesPerMinute": 120 }
}
```

- `version` must be `1`.
- `vaults` is `"*"` for all vaults, or a non-empty list of vault names or ids. Names are matched exactly after decryption. An unknown name, or a name shared by two vaults, is a config error (use the id instead): `status` stops, and `serve` keeps running with only `inked_status`, `change_config` and `sign_out` until it is fixed.
- `actions` is a non-empty list of actions or groups.
- `limits.writesPerMinute` is optional, a whole number from 1 to 1000. The default is 120.

The config is checked strictly. A typo or an unknown key is an error, never a quiet change to what the AI can do: `status` stops, and `serve` keeps running with only `inked_status`, `change_config` and `sign_out` until the config is fixed. The vault allowlist is enforced inside the MCP process only.

### Change access from the AI client

You rarely need to edit this file. Ask the AI for the access you want. Its `change_config` tool opens a settings page in your browser, pre-filled with its proposal and with each proposed change marked. Nothing changes until you click Apply. The server then writes the file and reloads at once, with no restart.

The AI can only open that page while the config grants `config.change`. If you remove it, run `inked-mcp config` in a terminal to open the same page yourself. What you apply there reaches a running AI client the next time it checks its status, or after you reconnect inked in /mcp.

### Actions

| Action | Tool | What it allows |
|---|---|---|
| `vault.list` | `list_vaults` | List the vaults you may use |
| `tree.read` | `get_tree` | Read a vault's folder tree and note titles |
| `note.read` | `read_note` | Read a note's title and body |
| `search` | `search` | Fuzzy search over titles and bodies |
| `folder.create` | `create_folder` | Create a folder (its Index note is created too) |
| `note.create` | `create_note`, `create_notes` | Create one note, or 1 to 50 in a batch |
| `note.append` | `append_to_note` | Add text to the end of a note |
| `note.update` | `update_note` | Replace a note's title and/or body |
| `note.move` | `move_note` | Move a note to another folder in the same vault |
| `folder.rename` | `rename_folder` | Rename a folder |
| `folder.move` | `move_folder` | Move a folder within the same vault |
| `vault.create` | `create_vault` | Create a vault. You confirm each one in the browser, and the AI then has access to it |
| `image.create` | `add_image` | Add images to notes (fetches web links; reads folders you list as `imageDirs`). In no group |
| `config.change` | `change_config` | Open the access settings page with a proposal. You apply or cancel |

### Groups

| Group | Expands to |
|---|---|
| `@read` | `vault.list`, `tree.read`, `note.read`, `search` |
| `@write` | `folder.create`, `note.create`, `note.append`, `note.update` |
| `@organize` | `note.move`, `folder.rename`, `folder.move` |
| `@manage` | `vault.create` |

No group includes `image.create`; list it explicitly in `actions`.

### Never grantable

These do not exist as tools and no config can add them:

- deleting notes or folders
- renaming or deleting vaults
- changing your password, the recovery key, invites or admin tasks

Do these in the Inked web app.

### Example configs

Read-only, all vaults:

```json
{"version":1,"vaults":"*","actions":["@read"]}
```

Capture into one vault (read, create notes, append):

```json
{"version":1,"vaults":["Inbox"],"actions":["@read","note.create","note.append"]}
```

Research builder (read, write and reorganize in one vault, with an explicit write limit):

```json
{"version":1,"vaults":["Research"],"actions":["@read","@write","@organize"],"limits":{"writesPerMinute":120}}
```

To see what a config resolves to, run `inked-mcp status`. To check another file without moving it, pass `--config`:

```bash
inked-mcp status --config ./capture.json
```

### Different policies for different clients

`serve` accepts `--config`, so each client can use its own file:

```bash
inked-mcp serve --config ~/.inked-mcp/capture.json
```

Put that command and its arguments in the client's MCP settings (see below). A file given with `--config` that does not exist is an error, not a fallback to the default.

Changes made on the settings page the AI opens apply at once. Changes made with `inked-mcp config` in a terminal, or by editing the file by hand, reach a running AI client the next time it checks its status, or after you reconnect inked in /mcp.

## Adding images

Grant the single action `image.create` (it is in no group and is off by default) to let the AI use `add_image`. The tool takes a vault and one of:

- `url`: a public `https://` image link. The MCP downloads it on your machine, from your IP address, so the host sees that request. It refuses addresses that are not public (loopback, private and link-local ranges, in IPv4 and IPv6), connects to the address it checked, re-checks every redirect (at most 3), and stops at 10 MB.
- `path`: a local file. This is off until you list absolute folders in the config file, for example `"imageDirs": ["C:\\Users\\you\\Pictures\\notes"]`. A file is read only if it resolves, after symlinks, inside one of those folders.

Only PNG, JPEG, GIF and WebP are accepted, judged by the file's bytes. The MCP encrypts the image with the vault key before upload, so the server never sees it, and returns `![alt](inked://id)` for the AI to put in a note. The audit log records the vault and image id, never the URL, the path or the bytes. The settings page keeps your `imageDirs` when you apply changes; edit them in the file.

## Diagrams

Notes can hold diagrams written in Mermaid. Put the diagram in a fenced block tagged `mermaid`; Inked draws it in the browser when the note is viewed, and the source stays plain text in the note, so `read_note` and search see it as written. Diagrams need no tool and no action. Each browser can turn drawing off under Settings, "Diagrams"; the source then stays plain text.

## Connect a client

### Claude Code (plugin)

The repository includes a Claude Code plugin that bundles the MCP server and the `inked-notes` skill, which teaches the AI to orient itself, search before writing, and link notes. The plugin carries its own copy of the server, built by `npm run build -w mcp` into `mcp/plugin/server/`, so build first, then add the repository as a marketplace and install the plugin:

```bash
npm run build -w mcp
```

```bash
claude plugin marketplace add <path-to-repo>
```

```bash
claude plugin install inked@inked
```

Inside a session you can use `/plugin marketplace add <path-to-repo>` and `/plugin install inked@inked` instead. In Claude Code the tools appear as `mcp__plugin_inked_inked__<tool>`, for example `mcp__plugin_inked_inked__list_vaults`.

The plugin runs the bundled server with `node` and the default folder, so it uses the credential and config you set up above. It does not need `inked-mcp` on your PATH. To sign in, ask Claude to sign you in to Inked. After you update the repository, run `npm run build -w mcp` again and then `/reload-plugins`.

Without the plugin, add the server directly. Options go before the name; omit `--env` to use the default `~/.inked-mcp`. This form uses `node` with the absolute path to the built file, which works on every platform:

```bash
claude mcp add --env INKED_MCP_HOME=<dir> --transport stdio inked -- node <path-to-repo>/mcp/dist/cli.cjs serve
```

On native Windows, `npm install -g ./mcp` creates an `inked-mcp.cmd` shim, and a client cannot start a `.cmd` file directly. If you want to use the global `inked-mcp` command instead of `node`, wrap it in `cmd /c`:

```bash
claude mcp add --transport stdio inked -- cmd /c inked-mcp serve
```

### Claude Desktop

Add this to `claude_desktop_config.json` and restart Claude Desktop. Use the absolute path to `mcp/dist/cli.cjs` in your clone (on Windows, escape backslashes or use forward slashes):

```json
{
  "mcpServers": {
    "inked": { "command": "node", "args": ["<path-to-repo>/mcp/dist/cli.cjs", "serve"] }
  }
}
```

On Windows, if you prefer the global command, use `"command": "cmd", "args": ["/c", "inked-mcp", "serve"]`.

To give Claude the same guidance the plugin gives, upload each folder in `mcp/plugin/skills` as a skill in Claude Desktop's skill settings.

### Cursor

Add this to `.cursor/mcp.json` (project) or your global Cursor MCP settings:

```json
{
  "mcpServers": {
    "inked": { "command": "node", "args": ["<path-to-repo>/mcp/dist/cli.cjs", "serve"] }
  }
}
```

On Windows, the global command form is `"command": "cmd", "args": ["/c", "inked-mcp", "serve"]`.

In any client, add `"--config", "<file>"` to `args` to use a specific policy.

<a id="approval-page"></a>

## The local approval page

Sign-in, access changes and new vaults need you, not the AI. For each one, the server starts a small web page for that single step:

- It listens on `127.0.0.1` only, on a random port, at a URL with a 32-byte random token. Any other path returns 404.
- It refuses requests whose `Host` is not that address, which stops DNS rebinding. It refuses form posts from another origin or without the page's CSRF token.
- It runs no scripts and loads nothing from the internet. Its Content Security Policy allows only its own inline styles.
- It closes after one successful submit, after Cancel, or after 5 minutes. Only one page is open at a time.
- The AI receives the outcome (signed in, applied, created, cancelled, timed out), never what you typed. If no browser can be opened, the AI gets the link to give you.

The audit log records `signed_in`, `config_applied` and `vault_created` events, with ids only.

## Audit log

Every tool call is recorded as one JSON line in `~/.inked-mcp/audit.log`: the time, the tool, the vault id, the ids touched, whether it succeeded, and a short error code on failure. It never records titles, bodies, folder names or vault names, and never any key or secret. The log is local only; the Inked server cannot tell MCP calls from browser use.

## Troubleshooting

<a id="cloudflare"></a>

### Cloudflare blocks the MCP

If your Inked is behind Cloudflare, Bot Fight Mode or Super Bot Fight Mode can challenge clients that are not browsers, so `login` or `serve` fails because it gets a web page instead of an API response. Either add a WAF custom rule that skips bot protection for `/api/*` on the Inked hostname, or turn the mode off for that hostname.

### "Inked credential is stale"

Your password changed (or the credential was revoked). In an AI client, ask it to sign you in again. In a terminal, run `inked-mcp login`, then restart the client.

### "Not permitted by the Inked MCP config"

The AI asked for an action your config does not grant. Ask the AI to change its access (it opens the settings page), or run `inked-mcp config`.

### "Write limit reached"

More writes than `limits.writesPerMinute` in a minute. Wait a moment, or raise the limit in the config (up to 1000) and restart the client.

### Config error

`status` stops with `Config error: ...` when the config has a typo, an unknown action, or a vault name that is missing or ambiguous. `serve` keeps running with only `inked_status`, `change_config` and `sign_out`, so the AI can open the settings page and you can fix it there.
