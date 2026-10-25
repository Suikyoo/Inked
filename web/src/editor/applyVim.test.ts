import { describe, expect, it } from 'vitest';
import { applyKeymaps, clearKeymaps, indentStringFor, optionExtensions, type VimApi } from './applyVim';

/** Records every call made to the vim engine, in order, so the tests assert on sequence as well as content. */
function spy(): VimApi & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    map: (lhs, rhs, ctx) => calls.push(['map', lhs, rhs, ctx]),
    noremap: (lhs, rhs, ctx) => calls.push(['noremap', lhs, rhs, ctx]),
    mapclear: (ctx) => calls.push(['mapclear', ctx ?? '']),
    unmap: (lhs, ctx) => calls.push(['unmap', lhs, ctx ?? '']),
  };
}

describe('applyKeymaps', () => {
  it('clears each context before applying, and maps in order', () => {
    const api = spy();
    applyKeymaps(api, [
      { modes: ['n', 'v'], lhs: 'H', rhs: '^', remap: false },
      { modes: ['i'], lhs: 'jk', rhs: '<Esc>', remap: true },
    ]);
    expect(api.calls).toEqual([
      ['mapclear', 'normal'],
      ['mapclear', 'insert'],
      ['mapclear', 'visual'],
      ['noremap', 'H', '^', 'normal'],
      ['noremap', 'H', '^', 'visual'],
      ['map', 'jk', '<Esc>', 'insert'],
    ]);
  });

  it('replaces rather than appends when reapplied', () => {
    const api = spy();
    applyKeymaps(api, [{ modes: ['n'], lhs: 'a', rhs: 'b', remap: false }]);
    api.calls.length = 0;
    applyKeymaps(api, [{ modes: ['n'], lhs: 'c', rhs: 'd', remap: false }]);
    expect(api.calls.filter((c) => c[0] === 'mapclear')).toHaveLength(3);
    expect(api.calls).toContainEqual(['noremap', 'c', 'd', 'normal']);
  });
});

describe('clearKeymaps', () => {
  it('clears all three contexts and maps nothing', () => {
    const api = spy();
    clearKeymaps(api);
    expect(api.calls).toEqual([
      ['mapclear', 'normal'],
      ['mapclear', 'insert'],
      ['mapclear', 'visual'],
    ]);
  });
});

describe('optionExtensions', () => {
  it('builds no extensions for an empty option set', () => {
    expect(optionExtensions({})).toEqual([]);
  });

  it('builds extensions for the options it is given', () => {
    expect(optionExtensions({ number: true, wrap: true })).toHaveLength(2);
  });
});


describe('indentStringFor', () => {
  it('indents with vim’s own default tabstop of 8 when none is given', () => {
    expect(indentStringFor({ expandtab: true })).toBe(' '.repeat(8));
  });

  it('indents with the configured tabstop', () => {
    expect(indentStringFor({ expandtab: true, tabstop: 4 })).toBe('    ');
  });

  it('indents with a tab when expandtab is off', () => {
    expect(indentStringFor({ expandtab: false, tabstop: 4 })).toBe('\t');
  });
});


describe('applyKeymaps freeing a prefix', () => {
  /**
   * The engine binds `<Space>` (to `l`) and `,` (repeat char search) as complete commands, and its matcher
   * takes a full match immediately rather than waiting for a longer sequence. So a `<leader>x` mapping never
   * fires while the bare leader is still bound — which is both common leaders. Vim users unmap it by hand;
   * here it has to happen or mapleader does nothing.
   */
  function spyWithUnmap() {
    const base = spy();
    const unmapped: string[] = [];
    return { ...base, unmapped, unmap: (lhs: string, ctx?: string) => unmapped.push(`${lhs}:${ctx ?? '*'}`) };
  }

  it('unmaps the leading key of a multi-key mapping, in every context', () => {
    const api = spyWithUnmap();
    applyKeymaps(api, [{ modes: ['n'], lhs: '<Space>w', rhs: ':w<CR>', remap: false }]);
    // Contextless, because the engine's own bindings carry no context and unmap matches on it.
    expect(api.unmapped).toEqual(['<Space>:*']);
  });

  it('splits vim key notation, not characters', () => {
    const api = spyWithUnmap();
    applyKeymaps(api, [{ modes: ['n'], lhs: '<C-w>v', rhs: 'x', remap: false }]);
    expect(api.unmapped).toEqual(['<C-w>:*']);
  });

  it('frees each distinct prefix once', () => {
    const api = spyWithUnmap();
    applyKeymaps(api, [
      { modes: ['n'], lhs: ',a', rhs: 'x', remap: false },
      { modes: ['n'], lhs: ',b', rhs: 'y', remap: false },
      { modes: ['v'], lhs: ',c', rhs: 'z', remap: false },
    ]);
    expect(api.unmapped).toEqual([',:*']);
  });

  it('leaves a single-key mapping alone: there is no prefix to free', () => {
    const api = spyWithUnmap();
    applyKeymaps(api, [{ modes: ['n'], lhs: 'Q', rhs: '$', remap: false }]);
    expect(api.unmapped).toEqual([]);
  });

  it('does not free a prefix the config maps itself', () => {
    const api = spyWithUnmap();
    applyKeymaps(api, [
      { modes: ['n'], lhs: ',', rhs: '$', remap: false },
      { modes: ['n'], lhs: ',a', rhs: 'x', remap: false },
    ]);
    expect(api.unmapped).toEqual([]);
  });

  it('frees prefixes before mapping, so the mappings survive', () => {
    const api = spyWithUnmap();
    applyKeymaps(api, [{ modes: ['n'], lhs: '<Space>w', rhs: 'x', remap: false }]);
    expect(api.calls.map((c) => c[0])).toEqual(['mapclear', 'mapclear', 'mapclear', 'noremap']);
  });
});

describe('applyKeymaps and insert mode', () => {
  it('never frees a prefix for an insert-mode mapping, so `jk` cannot cost the `j` motion', () => {
    const api = spy();
    applyKeymaps(api, [{ modes: ['i'], lhs: 'jk', rhs: '<Esc>', remap: false }]);
    expect(api.calls.filter((c) => c[0] === 'unmap')).toEqual([]);
  });

  it('frees the prefix when the same keys are mapped in normal mode', () => {
    const api = spy();
    applyKeymaps(api, [{ modes: ['n'], lhs: ',a', rhs: '$', remap: false }]);
    expect(api.calls.filter((c) => c[0] === 'unmap')).toEqual([['unmap', ',', '']]);
  });
});
