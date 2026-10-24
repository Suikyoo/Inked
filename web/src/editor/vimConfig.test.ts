import { describe, expect, it } from 'vitest';
import { compileVimConfig } from './vimConfig';

/** Compiles and asserts the config was clean, returning it for the caller's own assertions. */
const ok = (t: string) => {
  const c = compileVimConfig(t);
  expect(c.errors).toEqual([]);
  return c;
};

describe('compileVimConfig: keymaps', () => {
  it('compiles a single-mode keymap, non-remapping by default', () => {
    expect(ok("vim.keymap.set('i', 'jk', '<Esc>')").keymaps).toEqual([{ modes: ['i'], lhs: 'jk', rhs: '<Esc>', remap: false }]);
  });

  it('compiles a mode list', () => {
    expect(ok("vim.keymap.set({'n', 'v'}, 'H', '^')").keymaps).toEqual([{ modes: ['n', 'v'], lhs: 'H', rhs: '^', remap: false }]);
  });

  it('accepts double quotes, an opts table and unknown opts keys', () => {
    expect(ok(`vim.keymap.set("n", "<Space>w", ":w<CR>", { desc = "save", silent = true })`).keymaps[0].lhs).toBe('<Space>w');
  });

  it('reads remap from the opts table', () => {
    expect(ok("vim.keymap.set('n', 'x', 'y', { remap = true })").keymaps[0].remap).toBe(true);
    expect(ok("vim.keymap.set('n', 'x', 'y', { noremap = true })").keymaps[0].remap).toBe(false);
  });

  it('ignores comments and blank lines', () => {
    expect(ok("-- a comment\n\nvim.keymap.set('n', 'x', 'y')\n").keymaps).toHaveLength(1);
  });

  it('keeps a later duplicate lhs, in file order, without an error', () => {
    const c = ok("vim.keymap.set('n', 'x', 'a')\nvim.keymap.set('n', 'x', 'b')");
    expect(c.keymaps.map((k) => k.rhs)).toEqual(['a', 'b']);
  });

  it('reads escapes in strings', () => {
    expect(ok(`vim.keymap.set('n', 'x', '\\\\')`).keymaps[0].rhs).toBe('\\');
  });

  it('reports an unknown mode with its line', () => {
    expect(compileVimConfig("\nvim.keymap.set('q', 'x', 'y')").errors).toEqual([
      { line: 2, message: expect.stringContaining('unknown mode') },
    ]);
  });

  it('reports a function right-hand side', () => {
    const e = compileVimConfig("vim.keymap.set('n', 'x', function() end)").errors[0];
    expect(e.line).toBe(1);
    expect(e.message).toContain('needs real Lua');
  });

  it('drops every keymap when any line fails', () => {
    const c = compileVimConfig("vim.keymap.set('n', 'x', 'y')\nvim.keymap.set('q', 'a', 'b')");
    expect(c.keymaps).toEqual([]);
    expect(c.errors).toHaveLength(1);
  });

  it('rejects an empty lhs', () => {
    expect(compileVimConfig("vim.keymap.set('n', '', 'y')").errors[0].message).toContain('empty');
  });
});
