import { describe, expect, it } from 'vitest';
import { compileVimConfig, VIM_CONFIG_MAX } from './vimConfig';

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

describe('compileVimConfig: options and rejections', () => {
  it('reads vim.o and vim.opt options', () => {
    expect(ok('vim.o.relativenumber = true\nvim.opt.scrolloff = 4\nvim.o.wrap = false').options).toEqual({
      relativenumber: true,
      scrolloff: 4,
      wrap: false,
    });
  });

  it('rejects an unknown option and lists the supported ones', () => {
    const e = compileVimConfig('vim.o.swapfile = false').errors[0];
    expect(e.message).toContain('swapfile');
    expect(e.message).toContain('relativenumber');
  });

  it('rejects a value of the wrong type', () => {
    expect(compileVimConfig('vim.o.scrolloff = true').errors[0].message).toContain('number');
    expect(compileVimConfig('vim.o.wrap = 3').errors[0].message).toContain('true or false');
  });

  it('rejects require and control flow by name', () => {
    expect(compileVimConfig("require('lazy')").errors[0].message).toContain('require');
    expect(compileVimConfig('if true then end').errors[0].message).toContain('control flow');
    expect(compileVimConfig('for i = 1, 3 do end').errors[0].message).toContain('control flow');
  });

  it('rejects an unreadable line with its number', () => {
    expect(compileVimConfig("vim.keymap.set('n','x','y')\nwat?").errors).toEqual([{ line: 2, message: expect.any(String) }]);
  });

  it('refuses a config past the size cap without parsing it', () => {
    const c = compileVimConfig('-- x\n'.repeat(VIM_CONFIG_MAX));
    expect(c.errors).toEqual([{ line: 1, message: expect.stringContaining('too long') }]);
  });
});
