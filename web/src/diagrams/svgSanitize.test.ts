// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { isSafeCss, prepareDiagramSvg, sanitizeCss } from './svgSanitize';

const svg = (inner: string, attrs = '') =>
  `<svg id="d1" viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`;

describe('prepareDiagramSvg', () => {
  it('returns the sanitized svg and the sanitized css', () => {
    const r = prepareDiagramSvg(svg('<rect class="node"/>'), '#d1 .node{fill:red}')!;
    expect(r.svg).toContain('class="node"');
    expect(r.css).toBe('#d1 .node{fill:red}');
  });

  it('keeps data-inline-style attributes for the mount step, root included', () => {
    const r = prepareDiagramSvg(svg('<rect data-inline-style="fill:#f9f;stroke:#333"/>', 'data-inline-style="max-width: 300px;"'), '')!;
    expect(r.svg).toContain('data-inline-style="fill:#f9f;stroke:#333"');
    expect(r.svg).toContain('data-inline-style="max-width: 300px;"');
  });

  it('removes script, foreignObject, event attributes and external hrefs', () => {
    const r = prepareDiagramSvg(
      svg(
        '<script>alert(1)</script><foreignObject><div>x</div></foreignObject><rect onclick="a()"/>' +
          '<a href="https://evil.test"><text>t</text></a><use xlink:href="https://evil.test/x.svg#a"/><use href="#ok"/>',
      ),
      '',
    )!;
    expect(r.svg).not.toMatch(/<script|foreignObject|onclick|evil\.test/i);
    expect(r.svg).toContain('href="#ok"');
  });

  it('keeps the structure Mermaid needs', () => {
    const r = prepareDiagramSvg(
      svg('<defs><marker id="m"><path d="M0 0"/></marker></defs><g class="node"><rect/><text>hi</text></g>'),
      '',
    )!;
    expect(r.svg).toContain('<marker');
    expect(r.svg).toContain('<text>hi</text>');
    expect(r.svg).toContain('viewBox="0 0 10 10"');
  });

  it('strips a style element and a style attribute even if the frame sends them', () => {
    const r = prepareDiagramSvg(svg('<style>.a{fill:red}</style><rect style="fill:red"/>'), '')!;
    expect(r.svg).not.toMatch(/<style|\sstyle=/);
  });

  it('returns null when there is no svg', () => {
    expect(prepareDiagramSvg('<div>no</div>', '')).toBeNull();
    expect(prepareDiagramSvg('', '')).toBeNull();
  });

  it('sanitizes the css', () => {
    const r = prepareDiagramSvg(svg('<rect/>'), '@import url(https://evil.test/a.css); .a{background:url(https://evil.test/x.png)}')!;
    expect(r.css).not.toContain('evil.test');
  });
});

describe('sanitizeCss', () => {
  it('drops @import', () => {
    expect(sanitizeCss('@import url("https://evil.test/a.css");\n.a{color:red}')).toBe('\n.a{color:red}');
  });
  it('neutralizes a url() that is not a same-document fragment', () => {
    expect(sanitizeCss('.a{background:url(https://evil.test/x.png)}')).toBe('.a{background:none}');
    expect(sanitizeCss(".a{background:url('data:image/png;base64,AAAA')}")).toBe('.a{background:none}');
  });
  it('keeps url(#fragment) for markers and gradients', () => {
    expect(sanitizeCss('.a{marker-end:url(#arrow)}')).toBe('.a{marker-end:url(#arrow)}');
    expect(sanitizeCss('.a{fill:url("#grad")}')).toBe('.a{fill:url("#grad")}');
  });
});

describe('sanitizeCss @import statements', () => {
  it('removes only the statement', () => {
    expect(sanitizeCss('@import "x";\n.a{color:red}')).toBe('\n.a{color:red}');
    expect(sanitizeCss('@import url(a)\n.b{color:blue}')).toContain('.b{color:blue}');
  });
});

describe('isSafeCss', () => {
  it('accepts typical Mermaid css', () => {
    expect(isSafeCss('#d1 .node rect{fill:#24222c;stroke:#7452e0}')).toBe(true);
    expect(isSafeCss('@keyframes dash{to{stroke-dashoffset:0}}')).toBe(true);
    expect(isSafeCss('.a{marker-end:url(#arrow)}')).toBe(true);
  });
  it.each([
    '\\75rl(https://x)',
    '@\\69mport "x"',
    '.a{background:image-set("https://x/a.png" 1x)}',
    '.a{background:image("https://x")}',
    ':host{position:fixed}',
    ':HOST(.x){color:red}',
    '::slotted(a){color:red}',
    '.a{width:expression(1)}',
    '.a{background:src("https://x")}',
  ])('rejects %s', (css) => {
    expect(isSafeCss(css)).toBe(false);
  });
});

describe('prepareDiagramSvg hardening', () => {
  it('refuses unsafe css', () => {
    expect(prepareDiagramSvg(svg('<rect/>'), ':host{position:fixed}')).toBeNull();
  });
  it('sanitizes data-inline-style values', () => {
    const r = prepareDiagramSvg(
      svg('<rect data-inline-style="background:url(https://evil.test/x)"/><circle data-inline-style="fill:#f9f"/>'),
      '',
    )!;
    expect(r.svg).not.toContain('evil.test');
    expect(r.svg).toContain('data-inline-style="fill:#f9f"');
  });
  it('removes external url() in presentation attributes, keeps fragments', () => {
    const r = prepareDiagramSvg(
      svg(
        '<rect fill="url(https://evil.test/x)"/><rect filter="url(https://evil.test/f.svg#a)"/>' +
          '<path marker-end="url(data:image/svg+xml,x)"/><path marker-end="url(#arrow)"/><rect fill="url(#grad)"/>',
      ),
      '',
    )!;
    expect(r.svg).not.toMatch(/evil\.test|data:image/);
    expect(r.svg).toContain('marker-end="url(#arrow)"');
    expect(r.svg).toContain('fill="url(#grad)"');
  });
  it('removes javascript: and whitespace-prefixed external hrefs', () => {
    const r = prepareDiagramSvg(
      svg('<a href="javascript:alert(1)"><text>a</text></a><a href=" https://evil.test"><text>b</text></a>'),
      '',
    )!;
    expect(r.svg).not.toMatch(/javascript|evil\.test|href/i);
  });
});
