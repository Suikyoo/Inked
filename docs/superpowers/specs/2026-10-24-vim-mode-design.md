# Vim mode: design

Date: 2026-10-24

## Intent

The owner asked: "can we add a vim mode toggle? It should support vim defaults and allow me to add lua config bindings". Asked what the Lua config was for, they chose *define my own keymaps* — not reusing a real `init.lua` verbatim. Asked how far vim mode reaches, they chose *the edit textarea only*. Asked which engine, they chose CodeMirror 6 with `@replit/codemirror-vim`, knowing it replaces the textarea for every user on the instance.

The owner then said "do everything autonomously, I will be away for long". So the rulings below were made without them, in the manner of `2026-10-24-openboard-write-links-design.md`: each says what was decided, why, and what it costs if it is wrong.

## Why not real Lua

A browser can run Lua (`wasmoon`, `fengari`). It cannot run *Neovim's* Lua API — that API is Neovim's C core, not a library. Any Lua runtime we embed understands only the handful of `vim.*` functions we write by hand, so pasting arbitrary chunks of a real `init.lua` fails whatever we do. Given the owner only wants to define their own keymaps, a Lua *interpreter* buys nothing a parser does not, and costs 200–400 KB plus an eval surface pointed at decrypted user data. So: no interpreter. We parse a Lua subset and compile it.

The compiled output (`VimConfig`, a list of keymaps plus an option map) is the interface between config and editor. If the owner later wants real Lua — conditionals, loops, helper functions — a VM drops in behind that type without touching the editor.

## Scope

- **The note body editor in `NotePane` edit mode.** The `<textarea>` at `NotePane.tsx:317` becomes a CodeMirror 6 view behind an adapter. This is the only editing surface that changes.
- **A Settings section**: the on/off toggle, the config text, compile errors with line numbers.
- **`AccountSettings.vim`**: `{ on: boolean, config: string }` in the existing encrypted, synced settings blob.
- **A Lua-subset compiler**: `vim.keymap.set(...)` and `vim.o.<option> = ...` in, `VimConfig` out, line-numbered errors for everything else.

## Anti-goals

- **Neovim API compatibility.** No `require`, no plugin manager, no autocommands, no Lua functions as keymap right-hand sides. The compiler rejects them by name with an error that says so.
- **Evaluating user text.** No `loadstring`, no `eval`, no `new Function`. The config is parsed, never executed. It arrives decrypted from the settings blob and must stay inert.
- **Vim anywhere but the note body.** The title input, vault tree, search, home map and rendered view mode keep today's behaviour.
- **Vim in the openboard bundles.** The visitor and owner openboard entries ship no crypto, store or session code (`docs/architecture.md:272`, enforced by `npm run check:openboard -w web`), so they cannot read the encrypted config at all. The visitor editor stays a textarea. Project B adds its Edit|View toggle without CodeMirror.
- **A usable phone experience.** Vim mode is off by default and a soft keyboard has no Escape. The toggle is not hidden on phones, but nothing is done to make modal editing work there.

## Architecture

```
AccountSettings.vim.config  (encrypted, synced)
        │
        ▼
compileVimConfig(text)  →  { keymaps[], options, errors[] }     web/src/editor/vimConfig.ts
        │                                   │
        │                                   └──► Settings shows errors   web/src/pages/SettingsVim.tsx
        ▼
applyVimConfig(config)  →  Vim.mapclear + Vim.map per keymap           web/src/editor/applyVim.ts
        │                   (module-global, see ruling 4)
        ▼
<CodeEditor>  ──── EditorHandle ────►  NotePane / imagePaste            web/src/editor/CodeEditor.tsx
   CM6 view        body() focus()
                   selection() replaceRange()
```

`CodeEditor` owns the CM6 view and exposes an `EditorHandle`. Nothing outside `web/src/editor/` imports from `@codemirror/*` or `@replit/codemirror-vim`, so the engine stays swappable and the rest of the app keeps talking about strings and offsets.

### EditorHandle

The interface that replaces `RefObject<HTMLTextAreaElement>` for the code that used to reach into the DOM:

```ts
export interface EditorHandle {
  /** The document as it stands right now, ahead of React state. */
  body(): string;
  focus(): void;
  /** Caret/selection as character offsets into body(). */
  selection(): { start: number; end: number };
  setSelection(start: number, end: number): void;
  /** Replace [start, end) and leave the caret after the inserted text. */
  replaceRange(start: number, end: number, text: string): void;
}
```

Three call sites move onto it: the Ctrl+S flush that reads `textRef.current?.value` (`NotePane.tsx:163`), the initial-focus effects (`NotePane.tsx:138`), and image paste/drop, which reads `selectionStart/selectionEnd` and calls `setSelectionRange` (`imagePaste.ts:65,83-84`). `insertAt` in `imagePaste.ts` is pure and does not change.

### Data flow

`useNoteEditor` is unchanged. It is already a string-in/string-out hook (`body`, `setBody`, `NoteEditor` at `useNoteEditor.ts:182`), which is exactly the seam CM6 needs. `CodeEditor` takes `value`/`onChange`, and a CM6 `updateListener` calls `onChange(doc.toString())` on document changes. Autosave, the 800 ms debounce, conflict detection, the flush-on-leave paths and the ciphertext queue all keep working untouched, because they only ever saw a string.

The one subtlety every controlled CM6 component has: when `value` arrives back from React it usually equals the document we just reported, and re-setting it would reset the selection. `CodeEditor` compares incoming `value` against `view.state.doc.toString()` and dispatches a change only when they differ — which is what makes "Reload theirs" (`editor.reload`) and the post-save body still land correctly.

## Rulings

1. **CodeMirror 6 replaces the textarea for everyone, vim or not.** One editing code path. *Why:* the alternative the owner rejected — textarea when off, CM6 when on — means two editors that drift apart, and every editor bug then has two shapes. *Cost if wrong:* the app bundle grows by roughly 200 KB for CM6 core plus markdown (the openboard bundles are untouched), and edit mode gains markdown syntax highlighting, which is a visible change for every user on the instance. Reverting means restoring one `<textarea>` and the three `EditorHandle` call sites.

2. **The vim extension is dynamically imported, only when the toggle is on.** CM6 itself is statically imported; `@replit/codemirror-vim` (~100 KB) is loaded by `applyVim.ts` behind `await import()` the first time vim mode is enabled, and the editor reconfigures itself through a `Compartment` when it lands. *Why:* users who never turn vim on should not pay for it, and the editor must not flash or block on first paint. *If wrong:* a static import is a one-line change.

3. **The config lives in `AccountSettings`, not localStorage.** `core/src/crypto/fields.ts:100` gains `vim?: { on: boolean; config: string }`, with `isAccountSettings` validating it and `encryptAccountSettings` carrying it. *Why:* a keymap config is something you write once and want on every machine you sit at; the blob is already encrypted, already synced, and already has read-merge-write conflict handling in `AccountSettingsStore`. The three existing `prefs` booleans are per-browser *device* choices (is the model downloaded here), which a keymap is not. *Cost if wrong:* a config you want to differ per device cannot; moving to `prefs` is a small change, and nothing else depends on the location.

4. **Keymaps are applied globally, once, and reapplied wholesale on change.** `Vim.map/noremap/unmap/mapclear` mutate module-level state in `@replit/codemirror-vim` — they are not per-view. So `applyVimConfig` calls `Vim.mapclear(ctx)` for each of `normal`, `insert`, `visual` and then replays the compiled keymaps, and it runs when the compiled config changes rather than per editor mount. *Why:* it is the library's actual shape; pretending it is per-instance would leak one note's mappings into the next. *Cost if wrong:* nothing in this app opens two editors at once, so global is indistinguishable from per-instance today. If a future split view needs divergent mappings, the library cannot do it at all and the engine choice would have to be revisited.

5. **`vim.keymap.set` is the supported binding form, with a string right-hand side.** Accepted: a mode as `'n' | 'i' | 'v'` or a list of them, an `lhs` string, an `rhs` string, and an optional trailing table whose keys are parsed and ignored except that unknown keys are not an error (so `desc = "..."`, `silent = true`, `noremap = true` all pass). `noremap = true` and the `vim.keymap.set` default both compile to `Vim.noremap`; `remap = true` compiles to `Vim.map`. *Why:* this is the modern idiom the owner would reach for, and `noremap` by default matches `vim.keymap.set`'s real behaviour. *Cost if wrong:* `rhs` as a Lua function is the other common idiom and cannot work without a VM — the compiler rejects it with "a function right-hand side needs real Lua; use a key sequence string", which is an honest dead end rather than a silent no-op.

6. **A fixed option allowlist, everything else is an error.** `vim.o.<name>` and `vim.opt.<name>` accept `number`, `relativenumber`, `wrap`, `tabstop`, `expandtab`, `ignorecase`, `smartcase` and `scrolloff`, each mapped onto a CM6 extension or a vim option. An unknown name errors with the list of what is supported. *Why:* silently swallowing `vim.o.swapfile = false` teaches the owner the config does more than it does. *Cost if wrong:* adding an option is one table entry plus the extension that implements it.

7. **A config that does not compile applies no custom keymaps; vim defaults still work.** Settings shows every error with its line number, and the editor runs with built-in vim bindings only. There is no "last known good" config. *Why:* predictable. A half-applied config — some lines in, some rejected — would leave the owner guessing which half. *Cost if wrong:* a one-character typo costs all custom keymaps until it is fixed, which is loud and quickly diagnosed, rather than quiet and lasting.

8. **Ctrl+E and Ctrl+S stay app-level and shadow vim.** The window listener at `NotePane.tsx:154-168` keeps toggling edit/view and flushing the save, so vim's Ctrl+E (scroll down one line) and Ctrl+S are unavailable in this editor. *Why:* both are affordances the owner already uses, and the mode toggle has no other keyboard route. *Cost if wrong:* letting the editor claim them when vim is on means not calling `preventDefault` for those two keys while the view has focus.

9. **Escape belongs to vim inside the editor.** Nothing in `NotePane` binds Escape on the body today — only the title input does, where it reverts the title (`NotePane.tsx:267`) — so there is no conflict to resolve, and CM6 keeps Escape for insert→normal. Escape must not be made to leave the editor or close anything later without revisiting this.

10. **Vim mode is off by default.** A fresh account, and every existing account, behaves exactly as today apart from markdown highlighting in edit mode.

11. **Vim key behaviour is verified by running the app, not by jsdom tests.** The compiler is unit-tested exhaustively and headlessly — it is pure text in, data out. The `CodeEditor` component tests assert the wiring (a document change calls `onChange`; a `value` that differs dispatches; paste of an image file inserts a token at the selection) and do *not* assert that `ciw` changes a word, because CM6's key handling in jsdom depends on layout measurement that jsdom does not do. *Why:* a test that fakes enough of CM6 to make `ciw` pass proves the fake works. *Cost if wrong:* vim regressions are caught by hand. Mitigated by the compiler being where our own logic actually lives — the vim behaviour is the library's, covered by its own suite.

## Config examples

What compiles:

```lua
-- escape insert mode without reaching for Escape
vim.keymap.set('i', 'jk', '<Esc>')
vim.keymap.set({'n', 'v'}, 'H', '^')
vim.keymap.set({'n', 'v'}, 'L', '$')
vim.keymap.set('n', '<Space>w', ':w<CR>', { desc = 'save the note' })

vim.o.relativenumber = true
vim.o.ignorecase = true
vim.o.scrolloff = 4
```

What is rejected, each with its line number:

| Config | Error |
|---|---|
| `vim.keymap.set('n', 'x', function() ... end)` | a function right-hand side needs real Lua; use a key sequence string |
| `require('lazy').setup(...)` | `require` is not supported; this config defines keymaps and options only |
| `if vim.fn.has('mac') then ... end` | control flow is not supported; this config defines keymaps and options only |
| `vim.o.swapfile = false` | unknown option `swapfile`; supported: number, relativenumber, wrap, … |
| `vim.keymap.set('q', 'x', 'y')` | unknown mode `q`; use `n`, `i` or `v` |

## Files

| Path | Change |
|---|---|
| `core/src/crypto/fields.ts` | `AccountSettings.vim`, validated in `isAccountSettings`, carried in `encryptAccountSettings` |
| `web/src/editor/vimConfig.ts` | new — the Lua-subset compiler |
| `web/src/editor/vimConfig.test.ts` | new — the bulk of the tests |
| `web/src/editor/applyVim.ts` | new — dynamic vim import, `Vim.mapclear`/`map` replay, option→extension mapping |
| `web/src/editor/CodeEditor.tsx` | new — the CM6 view and `EditorHandle` |
| `web/src/editor/CodeEditor.test.tsx` | new — wiring tests |
| `web/src/pages/NotePane.tsx` | textarea → `CodeEditor`; `textRef` → `EditorHandle` |
| `web/src/pages/imagePaste.ts` | `textRef` option → `handle`; selection via the handle |
| `web/src/pages/SettingsVim.tsx` | new — toggle, config field, errors |
| `web/src/pages/SettingsPage.tsx` | mount the Vim section |
| `web/package.json` | `codemirror`, `@codemirror/lang-markdown`, `@codemirror/state`, `@codemirror/view`, `@replit/codemirror-vim` |

## Testing

- **Compiler (`vimConfig.test.ts`)** — the whole accepted grammar: single and list modes, optional opts table, `noremap`/`remap`, comments, blank lines, `vim.o` and `vim.opt`, string escapes, `<`-notation keys left verbatim. Every rejection in the table above, asserting the line number and that no keymaps survive a failed compile.
- **`applyVim.test.ts`** — a stub `Vim` object records calls: compiled keymaps produce one `mapclear` per context then `noremap`/`map` in order; recompiling replaces rather than appends.
- **`CodeEditor.test.tsx`** — `onChange` on document change; an external `value` change dispatches while an echoed one does not; `EditorHandle.body()` is ahead of React state; image paste inserts at the selection.
- **Existing tests** — `NotePane.component.test.tsx` and `NotePaste.component.test.tsx` query the editor by `role="textbox"`, which CM6's `contenteditable` content element also carries, so most should survive the swap; any that reach for `HTMLTextAreaElement` specifics are updated to the handle.
- **Gates** — `npm test` across all four workspaces, and `npm run build -w web && npm run check:openboard -w web` to prove no CodeMirror or crypto reached the openboard entries.
- **By hand, in the running app** — vim off behaves as today; vim on gives modes, `ciw`, `dd`, counts, registers, `.`, visual block, `/` search and `u`; a custom `jk` → `<Esc>` works; autosave still fires 800 ms after typing stops; image paste still lands a token at the caret; `style-src 'self'` does not block CM6's injected stylesheet (style-mod uses `sheet.insertRule`, which CSP permits, but this is worth seeing rather than assuming).
