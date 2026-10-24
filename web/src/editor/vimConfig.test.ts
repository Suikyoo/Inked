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
    expect(ok('vim.o.relativenumber = true\nvim.opt.tabstop = 4\nvim.o.wrap = false').options).toEqual({
      relativenumber: true,
      tabstop: 4,
      wrap: false,
    });
  });

  it('rejects options the engine cannot honour, rather than accepting them silently', () => {
    for (const name of ['ignorecase', 'smartcase', 'scrolloff']) {
      const e = compileVimConfig(`vim.o.${name} = true`).errors[0];
      expect(e.message).toContain(name);
      expect(e.message).toContain('supported');
    }
  });

  it('rejects an unknown option and lists the supported ones', () => {
    const e = compileVimConfig('vim.o.swapfile = false').errors[0];
    expect(e.message).toContain('swapfile');
    expect(e.message).toContain('relativenumber');
  });

  it('rejects a value of the wrong type', () => {
    expect(compileVimConfig('vim.o.tabstop = true').errors[0].message).toContain('number');
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

describe('compileVimConfig: vim.g and the leader', () => {
  const lhsOf = (t: string) => ok(t).keymaps[0]!.lhs;

  it('reads mapleader and maplocalleader', () => {
    expect(ok("vim.g.mapleader = ' '\nvim.g.maplocalleader = ','").globals).toEqual({ mapleader: ' ', maplocalleader: ',' });
  });

  it('expands a space leader into the engine’s key notation', () => {
    expect(lhsOf("vim.g.mapleader = ' '\nvim.keymap.set('n', '<leader>w', ':w<CR>')")).toBe('<Space>w');
  });

  it('accepts the <Leader> spelling real configs use', () => {
    expect(lhsOf("vim.g.mapleader = ' '\nvim.keymap.set('n', '<Leader>w', 'x')")).toBe('<Space>w');
    expect(lhsOf("vim.g.mapleader = ' '\nvim.keymap.set('n', '<LEADER>w', 'x')")).toBe('<Space>w');
  });

  it('uses backslash when no leader is set, as vim does', () => {
    expect(lhsOf("vim.keymap.set('n', '<leader>w', 'x')")).toBe('\\w');
  });

  it('expands a comma leader literally', () => {
    expect(lhsOf("vim.g.mapleader = ','\nvim.keymap.set('n', '<leader>f', 'x')")).toBe(',f');
  });

  it('escapes a leader the engine would read as notation', () => {
    expect(lhsOf("vim.g.mapleader = '<'\nvim.keymap.set('n', '<leader>w', 'x')")).toBe('<lt>w');
  });

  it('expands in the right-hand side too, as vim does at definition time', () => {
    expect(ok("vim.g.mapleader = ' '\nvim.keymap.set('n', 'x', '<leader>w')").keymaps[0]!.rhs).toBe('<Space>w');
  });

  it('expands localleader from its own global', () => {
    expect(lhsOf("vim.g.maplocalleader = ';'\nvim.keymap.set('n', '<localleader>t', 'x')")).toBe(';t');
  });

  it('refuses a second leader mid-file rather than quietly using two', () => {
    const c = compileVimConfig(
      "vim.g.mapleader = ','\nvim.keymap.set('n', '<leader>a', 'x')\nvim.g.mapleader = ';'\nvim.keymap.set('n', '<leader>b', 'y')",
    );
    expect(c.errors).toHaveLength(1);
    expect(c.errors[0]!.line).toBe(3);
  });

  it('lets maplocalleader be set late when only <leader> was used', () => {
    const c = ok("vim.keymap.set('n', '<leader>a', 'x')\nvim.g.maplocalleader = ';'");
    expect(c.globals).toEqual({ maplocalleader: ';' });
    expect(c.keymaps[0]!.lhs).toBe('\\a');
  });

  it('refuses a leader set after a <leader> mapping, naming both lines', () => {
    const e = compileVimConfig("vim.keymap.set('n', '<leader>w', 'x')\nvim.g.mapleader = ' '").errors[0]!;
    expect(e.line).toBe(2);
    expect(e.message).toContain('line 1');
    expect(e.message).toMatch(/above/i);
  });

  it('is happy when the leader is set first', () => {
    expect(compileVimConfig("vim.g.mapleader = ' '\nvim.keymap.set('n', '<leader>w', 'x')").errors).toEqual([]);
  });

  it('rejects an unknown vim.g name with the supported list', () => {
    const e = compileVimConfig('vim.g.loaded_netrw = 1').errors[0]!;
    expect(e.message).toContain('loaded_netrw');
    expect(e.message).toContain('mapleader');
  });

  it('rejects a leader that is not a non-empty string', () => {
    expect(compileVimConfig('vim.g.mapleader = true').errors[0]!.message).toContain('string');
    expect(compileVimConfig("vim.g.mapleader = ''").errors[0]!.message).toMatch(/empty/i);
  });
});
