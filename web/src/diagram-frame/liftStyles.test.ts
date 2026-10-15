// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { liftStyles } from './liftStyles';

const svg = (inner: string, attrs = '') =>
  `<svg id="d1" viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`;

describe('liftStyles', () => {
  it('lifts <style> blocks out of the svg and returns their text', () => {
    const r = liftStyles(svg('<style>#d1 .node{fill:red}</style><rect class="node"/>'))!;
    expect(r.svg).not.toContain('<style');
    expect(r.css).toContain('#d1 .node{fill:red}');
    expect(r.svg).toContain('class="node"');
  });

  it('moves style attributes, root included, to data-inline-style', () => {
    const r = liftStyles(svg('<rect style="fill:#f9f;stroke:#333"/>', 'style="max-width: 300px;"'))!;
    expect(r.svg).not.toMatch(/\sstyle=/);
    expect(r.svg).toContain('data-inline-style="fill:#f9f;stroke:#333"');
    expect(r.svg).toContain('data-inline-style="max-width: 300px;"');
  });

  it('keeps the structure Mermaid needs', () => {
    const r = liftStyles(svg('<defs><marker id="m"><path d="M0 0"/></marker></defs><g class="node"><rect/><text>hi</text></g>'))!;
    expect(r.svg).toContain('<marker');
    expect(r.svg).toContain('<text>hi</text>');
    expect(r.svg).toContain('viewBox="0 0 10 10"');
    expect(r.css).toBe('');
  });

  it('joins several <style> blocks', () => {
    const r = liftStyles(svg('<style>.a{fill:red}</style><style>.b{fill:blue}</style>'))!;
    expect(r.css).toContain('.a{fill:red}');
    expect(r.css).toContain('.b{fill:blue}');
  });

  it('returns null when there is no svg', () => {
    expect(liftStyles('<div>no</div>')).toBeNull();
    expect(liftStyles('')).toBeNull();
  });
});
