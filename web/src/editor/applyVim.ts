/**
 * Puts a compiled vim config into effect.
 *
 * `@replit/codemirror-vim`'s mappings live in module-global state, not per editor view, so keymaps are
 * replaced wholesale: every context is cleared, then the config is replayed (the design's ruling 4). The
 * package itself is imported dynamically by `loadVim`, so a user who never turns vim on never downloads it.
 */
import { indentUnit } from '@codemirror/language';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import type { VimKeymap, VimMode, VimOptions } from './vimConfig';

/** The slice of the vim package's global `Vim` object this module uses. */
export interface VimApi {
  map(lhs: string, rhs: string, ctx: string): void;
  noremap(lhs: string, rhs: string, ctx: string): void;
  mapclear(ctx?: string): void;
  /** Removes a binding. Called with no context, since the engine's own bindings carry none. */
  unmap(lhs: string, ctx?: string): void;
}

const CONTEXTS = ['normal', 'insert', 'visual'] as const;
const CONTEXT_OF: Record<VimMode, (typeof CONTEXTS)[number]> = { n: 'normal', i: 'insert', v: 'visual' };

/**
 * A vim key sequence split into its keys: `<Space>w` is two keys, not seven characters.
 */
export function vimKeys(lhs: string): string[] {
  return lhs.match(/<[^<>]+>|[\s\S]/g) ?? [];
}

/**
 * The leading key of every multi-key mapping in a mode where keys are commands.
 *
 * The engine binds `<Space>` and `,` — the two usual leaders — as complete commands, and its matcher takes
 * a full match the moment it has one rather than waiting for a longer sequence. So `<leader>w` never fires
 * while the bare leader is still bound. A prefix the config maps itself is left alone: that is the owner
 * saying what the bare key should do.
 *
 * Insert mode is skipped: there a bare character is text, not a command, so nothing needs freeing — and
 * freeing it would be actively harmful, since `unmap` is contextless and an insert-mode `jk` mapping would
 * take the normal-mode `j` motion with it.
 */
function prefixesToFree(keymaps: VimKeymap[]): string[] {
  const mapped = new Set(keymaps.map((k) => k.lhs));
  const out: string[] = [];
  for (const k of keymaps) {
    if (!k.modes.some((m) => m === 'n' || m === 'v')) continue;
    const keys = vimKeys(k.lhs);
    if (keys.length < 2) continue;
    const prefix = keys[0]!;
    if (mapped.has(prefix) || out.includes(prefix)) continue;
    out.push(prefix);
  }
  return out;
}

/** Clears every mapping this module may have set. */
export function clearKeymaps(api: VimApi): void {
  for (const ctx of CONTEXTS) api.mapclear(ctx);
}

/** Replaces every mapping in normal, insert and visual with this config's, in file order. */
export function applyKeymaps(api: VimApi, keymaps: VimKeymap[]): void {
  clearKeymaps(api);
  // Before mapping, not after: mapclear puts the engine's own bindings back.
  for (const prefix of prefixesToFree(keymaps)) api.unmap(prefix);
  for (const k of keymaps) {
    for (const mode of k.modes) {
      if (k.remap) api.map(k.lhs, k.rhs, CONTEXT_OF[mode]);
      else api.noremap(k.lhs, k.rhs, CONTEXT_OF[mode]);
    }
  }
}

/** Vim's own default: a tab stops every 8 columns, so `expandtab` with no `tabstop` inserts 8 spaces. */
const VIM_DEFAULT_TABSTOP = 8;

/** What one indent inserts: spaces under `expandtab`, otherwise a real tab. */
export function indentStringFor(o: VimOptions): string {
  return o.expandtab ? ' '.repeat(o.tabstop ?? VIM_DEFAULT_TABSTOP) : '\t';
}

/** `relativenumber`: the cursor's line keeps its own number, the rest count distance from it. */
function relativeNumber(lineNo: number, state: EditorState): string {
  const cursor = state.doc.lineAt(state.selection.main.head).number;
  return lineNo === cursor ? String(lineNo) : String(Math.abs(lineNo - cursor));
}

/** CodeMirror extensions for the options CodeMirror owns. */
export function optionExtensions(o: VimOptions): Extension[] {
  const out: Extension[] = [];
  if (o.number || o.relativenumber) out.push(lineNumbers(o.relativenumber ? { formatNumber: relativeNumber } : undefined));
  if (o.wrap) out.push(EditorView.lineWrapping);
  if (o.tabstop !== undefined) out.push(EditorState.tabSize.of(o.tabstop));
  if (o.expandtab !== undefined) out.push(indentUnit.of(indentStringFor(o)));
  return out;
}

/** Imports the vim package on first use, and hands back its extension and its global object. */
export async function loadVim(): Promise<{ extension: Extension; api: VimApi }> {
  const m = await import('@replit/codemirror-vim');
  return { extension: m.vim(), api: m.Vim as unknown as VimApi };
}
