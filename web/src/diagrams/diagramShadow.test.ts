// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DIAGRAM_BASE_CSS, mountDiagramShadow } from './diagramShadow';

class FakeSheet {
  text = '';
  replaceSync(text: string) {
    this.text = text;
  }
}

beforeEach(() => vi.stubGlobal('CSSStyleSheet', FakeSheet));
afterEach(() => vi.unstubAllGlobals());

const svgEl = () => document.createElementNS('http://www.w3.org/2000/svg', 'svg');
const sheetsOf = (root: ShadowRoot) => root.adoptedStyleSheets as unknown as FakeSheet[];

describe('mountDiagramShadow', () => {
  it('puts the svg in an open shadow root and leaves the host light DOM empty', () => {
    const host = document.createElement('div');
    const svg = svgEl();
    mountDiagramShadow(host, svg, '#a .n{fill:red}');
    expect(host.shadowRoot).not.toBeNull();
    expect(host.shadowRoot!.querySelector('svg')).toBe(svg);
    expect(host.querySelector('svg')).toBeNull();
  });

  it('adopts one sheet on that root only: the diagram css, then the base css', () => {
    const host = document.createElement('div');
    mountDiagramShadow(host, svgEl(), '#a .n{fill:red}');
    const sheets = sheetsOf(host.shadowRoot!);
    expect(sheets).toHaveLength(1);
    expect(sheets[0].text).toBe(`#a .n{fill:red}\n${DIAGRAM_BASE_CSS}`);
    // The page's own sheets are untouched.
    expect((document as unknown as { adoptedStyleSheets?: unknown[] }).adoptedStyleSheets ?? []).toHaveLength(0);
  });

  it('gives each diagram its own root and its own sheet, even for identical css', () => {
    const h1 = document.createElement('div');
    const h2 = document.createElement('div');
    mountDiagramShadow(h1, svgEl(), '#a{fill:red}');
    mountDiagramShadow(h2, svgEl(), '#a{fill:red}');
    expect(h1.shadowRoot).not.toBe(h2.shadowRoot);
    expect(sheetsOf(h1.shadowRoot!)[0]).not.toBe(sheetsOf(h2.shadowRoot!)[0]);
  });

  it('the base css sizes the svg inside the root', () => {
    expect(DIAGRAM_BASE_CSS).toBe('svg { display: block; margin: 0 auto; height: auto; }');
  });
});
