// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiagramResult } from './diagramRender';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const renderDiagram = vi.fn<(s: string) => Promise<DiagramResult>>();
const peekDiagram = vi.fn<(s: string) => DiagramResult | undefined>();
const mountShadow = vi.fn<(host: HTMLElement, svg: SVGElement, css: string) => void>();
vi.mock('./diagramRender', () => ({
  renderDiagram: (s: string) => renderDiagram(s),
  peekDiagram: (s: string) => peekDiagram(s),
}));
vi.mock('./diagramShadow', () => ({
  mountDiagramShadow: (h: HTMLElement, s: SVGElement, c: string) => mountShadow(h, s, c),
}));

const { useDiagrams } = await import('./useDiagrams');

const SVG =
  '<svg id="inked-dg-1" viewBox="0 0 10 10" data-inline-style="max-width: 300px;"><title>Flow</title><rect data-inline-style="opacity: 0.5"/></svg>';
const ok = (id = 'inked-dg-1'): Extract<DiagramResult, { ok: true }> => ({ ok: true, id, svg: SVG, css: '#inked-dg-1 .n{fill:red}' });
const block = (src: string) => `<pre><code class="language-mermaid">${src}</code></pre>`;

function Host({ markup }: { markup: string }) {
  const ref = useRef<HTMLElement>(null);
  useDiagrams(ref, markup);
  return <article ref={ref} dangerouslySetInnerHTML={{ __html: markup }} />;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(markup: string) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Host markup={markup} />));
  return host;
}

beforeEach(() => {
  renderDiagram.mockReset();
  peekDiagram.mockReset().mockReturnValue(undefined);
  // jsdom has no constructable stylesheets: the stand-in keeps the svg reachable from the figure.
  mountShadow.mockReset().mockImplementation((figure, svg) => figure.append(svg));
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  localStorage.clear();
});

describe('useDiagrams', () => {
  it('replaces a mermaid block with a figure, the svg mounted with its css and inline styles applied', async () => {
    renderDiagram.mockResolvedValue(ok());
    const el = await mount(block('graph TD; A-->B'));
    expect(renderDiagram).toHaveBeenCalledWith('graph TD; A-->B');
    expect(el.querySelector('pre')).toBeNull();
    const figure = el.querySelector('div.diagram')!;
    expect(figure.getAttribute('role')).toBe('img');
    expect(figure.getAttribute('aria-label')).toBe('Flow');
    expect(mountShadow).toHaveBeenCalledTimes(1);
    expect(mountShadow.mock.calls[0][0]).toBe(figure);
    expect(mountShadow.mock.calls[0][2]).toBe('#inked-dg-1 .n{fill:red}');
    const svg = figure.querySelector('svg')!;
    expect(svg.style.maxWidth).toBe('300px');
    expect((figure.querySelector('rect') as SVGElement).style.opacity).toBe('0.5');
    expect(figure.querySelector('[data-inline-style]')).toBeNull();
  });

  it('uses a cached result at once, without waiting', async () => {
    peekDiagram.mockReturnValue(ok());
    const el = await mount(block('graph TD; A-->B'));
    expect(renderDiagram).not.toHaveBeenCalled();
    expect(el.querySelector('div.diagram')).not.toBeNull();
  });

  it('labels the figure "Diagram" when the svg has no title', async () => {
    renderDiagram.mockResolvedValue({ ...ok(), svg: '<svg id="inked-dg-1" viewBox="0 0 1 1"><rect/></svg>' });
    const el = await mount(block('graph TD; A-->B'));
    expect(el.querySelector('div.diagram')!.getAttribute('aria-label')).toBe('Diagram');
  });

  it.each([
    [{ ok: false, reason: 'syntax', message: 'Parse error on line 2:' } as const, 'Diagram error: Parse error on line 2:'],
    [{ ok: false, reason: 'syntax' } as const, 'Diagram error'],
    [{ ok: false, reason: 'oversized' } as const, 'Diagram too large to draw.'],
    [{ ok: false, reason: 'load' } as const, 'Could not load the diagram renderer.'],
    [{ ok: false, reason: 'timeout' } as const, 'Diagram took too long to draw.'],
  ])('keeps the code block and adds a note for a failure (%j)', async (result, text) => {
    renderDiagram.mockResolvedValue(result);
    const el = await mount(block('graph TD; A-->B'));
    expect(el.querySelector('pre')).not.toBeNull();
    expect(el.querySelector('div.diagram')).toBeNull();
    const note = el.querySelector('.diagram-note')!;
    expect(note.textContent).toBe(text);
    expect(note.getAttribute('role')).toBe('note');
    expect(mountShadow).not.toHaveBeenCalled();
  });

  it('leaves other code blocks and empty mermaid blocks alone', async () => {
    const el = await mount(
      `<pre><code class="language-js">x</code></pre>${block('')}${block('   \n ')}<pre><code>plain</code></pre>`,
    );
    expect(renderDiagram).not.toHaveBeenCalled();
    expect(el.querySelectorAll('pre')).toHaveLength(4);
    expect(el.querySelector('.diagram-note')).toBeNull();
  });

  it('draws two identical diagrams, each in its own figure with its own shadow mount', async () => {
    renderDiagram.mockResolvedValue(ok());
    const el = await mount(block('graph TD; A-->B') + block('graph TD; A-->B'));
    const figures = el.querySelectorAll('div.diagram');
    expect(figures).toHaveLength(2);
    expect(mountShadow).toHaveBeenCalledTimes(2);
    expect(mountShadow.mock.calls[0][0]).not.toBe(mountShadow.mock.calls[1][0]);
  });

  it('does not touch the DOM or mount when unmounted before the render resolves', async () => {
    let resolve!: (r: DiagramResult) => void;
    renderDiagram.mockReturnValue(new Promise((r) => (resolve = r)));
    const el = await mount(block('graph TD; A-->B'));
    const pre = el.querySelector('pre')!;
    act(() => root!.unmount());
    root = null;
    await act(async () => resolve(ok()));
    expect(mountShadow).not.toHaveBeenCalled();
    expect(pre.isConnected).toBe(false);
    expect(document.querySelector('div.diagram')).toBeNull();
  });

  it('draws again when the html changes', async () => {
    renderDiagram.mockResolvedValue(ok());
    const el = await mount(block('graph TD; A-->B'));
    expect(mountShadow).toHaveBeenCalledTimes(1);
    await act(async () => root!.render(<Host markup={block('graph TD; B-->C')} />));
    expect(renderDiagram).toHaveBeenLastCalledWith('graph TD; B-->C');
    expect(mountShadow).toHaveBeenCalledTimes(2);
    expect(el.querySelectorAll('div.diagram')).toHaveLength(1);
  });

  it('with diagrams switched off in Settings: no render, no peek, code block kept, note shown', async () => {
    localStorage.setItem('inked.diagrams', 'off');
    const el = await mount(block('graph TD; A-->B') + block('graph TD; B-->C'));
    expect(renderDiagram).not.toHaveBeenCalled();
    expect(peekDiagram).not.toHaveBeenCalled();
    expect(mountShadow).not.toHaveBeenCalled();
    expect(el.querySelectorAll('pre')).toHaveLength(2);
    expect(el.querySelector('div.diagram')).toBeNull();
    const notes = el.querySelectorAll('.diagram-note');
    expect(notes).toHaveLength(2);
    expect(notes[0].textContent).toBe('Diagrams are off. Turn them on in Settings.');
  });

  it('with diagrams switched off, an empty mermaid block gets no note', async () => {
    localStorage.setItem('inked.diagrams', 'off');
    const el = await mount(block(''));
    expect(el.querySelector('.diagram-note')).toBeNull();
  });
});
