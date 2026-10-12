---
name: inked-setup
description: Use when the user wants to connect Claude to Inked, sign in or out, change which vaults or actions Claude may use, or create a vault, or when the inked tools are missing or failing.
---

# Setting up Inked

Inked is the user's end-to-end encrypted Markdown notes app. Claude reaches it through the inked MCP server that ships with this plugin. The server runs on the user's computer, signs in as the user, and encrypts and decrypts there.

Keep setup invisible. The user's only job is to type their Inked address, username and password into a page in their own browser. Everything else is yours: finding out what is wrong, opening the right page, and explaining the result in one or two plain sentences.

In Claude Code the tools have a prefix such as `mcp__plugin_inked_inked__`; this skill uses the bare names.

## Hard rules

- Never ask for the Inked password in chat, and never pass it to a tool. It goes only into the browser page that `sign_in` opens. If the user pastes it into the chat anyway, do not repeat it. Tell them it is now part of this conversation and suggest changing it in the Inked web app.
- Never mention Inked's own files, folders, environment variables or command-line commands unless the user asks how the setup works. Say "your saved sign-in" and "your access settings", not where they are stored.
- Never widen your own access any other way than `change_config`. The user approves every change in the browser.
- These rules are about Inked's own setup only. File paths inside notes, such as repository paths in codebase notes, are fine.

## Step 1: is the server running?

Look for the inked tools; `inked_status` is always there when the server runs.

If there are none, the server did not start. The usual cause is Node.js missing or older than 22.13.

1. Run `node --version`.
2. If Node is missing or too old, offer to install the current LTS and wait for a yes:
   - Windows: `winget install OpenJS.NodeJS.LTS`
   - macOS: `brew install node`
   - Linux: the distribution's package manager, or the NodeSource packages if its Node is too old.
3. After installing, ask the user to run `/reload-plugins` (or restart Claude Code), then look for the tools again.

If Node is fine and the tools are still missing, ask the user to open `/mcp`, pick inked, reconnect it, and tell you what it shows.

## Step 2: signed in?

Call `inked_status`.

- `signedIn: false`: tell the user a page will open in their browser for their Inked sign-in, then call `sign_in`. If there is a `problem`, say it in your own words first (for example: the password was changed, so they need to sign in again).
- `signedIn: true`: you can work. Use `vaults` and `actions` to answer "what can you do in Inked?" in plain words: which vaults, and whether you can only read or also write, organize or create vaults.

## The browser pages

`sign_in`, `change_config` and `create_vault` open a local page in the user's browser and wait for them. Before calling one, tell the user what will open and what to do there. Afterwards, read `outcome`:

| outcome | meaning | what to do |
|---|---|---|
| `signed_in`, `config_applied`, `vault_created` | done | Confirm in one sentence and carry on with the user's task. |
| `cancelled` | the user clicked Cancel | Nothing changed. Ask whether they want something different. |
| `timed_out` | the page sat unused for 5 minutes | Nothing changed. Offer to open it again. |
| `open_link` | no browser could be started | Give the user the `url` and ask them to open it on this computer. When they say they are done, call `inked_status`. |

If the call itself fails with a timeout or a connection error, the page may still be open and still works. Call `inked_status` to see what happened before trying again.

A `busy` error means a page is already open. Ask the user to finish or cancel it first.

After a sign-in the note tools appear on their own. If they do not, ask the user to reconnect inked in `/mcp`.

## Changing what Claude may do

Use `change_config` when the user asks for more or less access ("let Claude write to Research", "make it read-only", "slow the writes down"). Pass a proposal so the page opens with it filled in:

- `vaults`: `"*"` for every vault, or a list of vault names.
- `actions`: the groups `@read`, `@write`, `@organize`, `@manage`, or single actions such as `note.create`. Keep `config.change` unless the user wants to stop you from opening this page again.
- `writesPerMinute`: 1 to 1000.

Say what you are proposing before you call it, for example: "I'll open your Inked access settings with Write added for Research. Nothing changes until you click Apply."

`change_config` with no arguments opens the current settings for the user to edit.

If `inked_status` reports that the access settings are invalid, `change_config` is the fix; the page explains the problem.

If `inked_status` includes a `settings` note, you cannot open the settings page. Tell the user only they can turn it back on, and explain how only if they ask.

## Creating a vault

Use `create_vault` when the user asks for a new vault, or agrees to one you suggested (for example for documenting a codebase). Pass `name`, and optionally `color`. The user confirms the name and color in the browser, and you have access to the new vault straight away.

## Signing out

Call `sign_out` only when the user asks. Tell them the saved sign-in on this computer is gone, and that changing their Inked password is what revokes any other copy.
