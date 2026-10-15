import { useEffect, type RefObject } from 'react';
import { prefs } from '../lib/prefs';
import { peekDiagram, renderDiagram, type DiagramResult } from './diagramRender';
import { mountDiagramShadow } from './diagramShadow';

type Drawn = Extract<DiagramResult, { ok: true }>;
type Failed = Extract<DiagramResult, { ok: false }>;

function failureText(r: Failed): string {
  if (r.reason === 'oversized') return 'Diagram too large to draw.';
  if (r.reason === 'load') return 'Could not load the diagram renderer.';
  if (r.reason === 'timeout') return 'Diagram took too long to draw.';
  return r.message ? `Diagram error: ${r.message}` : 'Diagram error';
}

function addNote(pre: HTMLElement, text: string): void {
  const note = document.createElement('p');
  note.className = 'diagram-note';
  note.setAttribute('role', 'note');
  note.textContent = text;
  pre.after(note);
}

function figureFor(r: Drawn): HTMLElement {
  const parsed = new DOMParser().parseFromString(`<body>${r.svg}</body>`, 'text/html');
  const svg = document.importNode(parsed.body.firstElementChild!, true) as SVGElement;
  // The CSP bans style="..." strings but allows CSSOM writes, so each style attribute is applied this way.
  for (const el of [svg, ...Array.from(svg.querySelectorAll<SVGElement>('[data-inline-style]'))]) {
    const css = el.getAttribute('data-inline-style');
    if (css === null) continue;
    el.style.cssText = css;
    el.removeAttribute('data-inline-style');
  }
  const figure = document.createElement('div');
  figure.className = 'diagram';
  figure.setAttribute('role', 'img');
  figure.setAttribute('aria-label', svg.querySelector('title')?.textContent?.trim() || 'Diagram');
  // The diagram's css lives in a shadow root on the figure, so it cannot restyle anything else on the page.
  mountDiagramShadow(figure, svg, r.css);
  return figure;
}

/**
 * Replaces each `pre > code.language-mermaid` in `ref` with a drawn diagram after every render. A diagram that
 * cannot be drawn stays a code block with a one-line note. `html` is a dependency because React rebuilds the
 * blocks whenever it changes. Not used for untrusted (Ask) output.
 */
export function useDiagrams(ref: RefObject<HTMLElement | null>, html: string): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let live = true;
    const enabled = prefs.diagrams();
    for (const code of Array.from(root.querySelectorAll<HTMLElement>('pre > code.language-mermaid'))) {
      const pre = code.parentElement as HTMLElement;
      const source = code.textContent ?? '';
      if (!source.trim()) continue;
      if (!enabled) {
        // Off in Settings: nothing is loaded and no frame is created.
        addNote(pre, 'Diagrams are off. Turn them on in Settings.');
        continue;
      }
      const show = (r: DiagramResult) => {
        if (!live || !pre.isConnected) return;
        if (r.ok) pre.replaceWith(figureFor(r));
        else addNote(pre, failureText(r));
      };
      const cached = peekDiagram(source);
      if (cached) show(cached);
      else void renderDiagram(source).then(show);
    }
    return () => {
      live = false;
    };
  }, [ref, html]);
}
