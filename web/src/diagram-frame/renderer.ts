import { MAX_TEXT_SIZE, type DiagramTheme, type RenderResult } from '../diagrams/protocol';
import { liftStyles } from './liftStyles';

export const MAX_EDGES = 200;

type MermaidApi = typeof import('mermaid').default;

export interface RendererDeps {
  theme: DiagramTheme;
  loadMermaid: () => Promise<MermaidApi>;
  loadFonts: () => Promise<void>;
}

const THEME_CSS = `
  .node rect, .node polygon { rx: 6px; ry: 6px; }
  .cluster rect { rx: 8px; ry: 8px; }
  .flowchart-link, .messageLine0, .messageLine1 { stroke-width: 1.5px; }
`;

function firstLine(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.split('\n')[0].trim().slice(0, 120);
}

/** Runs inside the sandboxed frame, where inline styles are allowed so Mermaid can measure text correctly. */
export function createRenderer(deps: RendererDeps) {
  let ready: Promise<MermaidApi> | null = null;

  function prepare(): Promise<MermaidApi> {
    if (!ready) {
      ready = (async () => {
        // Fonts first, so text is measured in the font the main page will show.
        const [mermaid] = await Promise.all([deps.loadMermaid(), deps.loadFonts()]);
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: deps.theme,
          themeCSS: THEME_CSS,
          maxTextSize: MAX_TEXT_SIZE,
          maxEdges: MAX_EDGES,
          htmlLabels: false,
          // Natural size, not shrink-to-fit: a wide diagram scrolls in its wrapper.
          flowchart: { htmlLabels: false, useMaxWidth: false },
          sequence: { useMaxWidth: false },
          class: { useMaxWidth: false },
          state: { useMaxWidth: false },
          er: { useMaxWidth: false },
          gantt: { useMaxWidth: false },
          journey: { useMaxWidth: false },
          pie: { useMaxWidth: false },
          requirement: { useMaxWidth: false },
          gitGraph: { useMaxWidth: false },
          mindmap: { useMaxWidth: false },
          timeline: { useMaxWidth: false },
          suppressErrorRendering: true,
          // Keys a note's %%{init}%% directive may not change: Mermaid's own list plus the look.
          secure: [
            'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering',
            'theme', 'themeCSS', 'themeVariables', 'fontFamily', 'htmlLabels',
          ],
        });
        return mermaid;
      })();
      // A failed load is not kept: the next render tries again.
      ready.catch(() => {
        ready = null;
      });
    }
    return ready;
  }

  return {
    async render(id: string, source: string): Promise<RenderResult> {
      const text = source.trim();
      if (text.length > MAX_TEXT_SIZE) return { type: 'result', id, ok: false, reason: 'oversized' };
      let mermaid: MermaidApi;
      try {
        mermaid = await prepare();
      } catch {
        return { type: 'result', id, ok: false, reason: 'load' };
      }
      try {
        const { svg } = await mermaid.render(id, text);
        const lifted = liftStyles(svg);
        if (!lifted) return { type: 'result', id, ok: false, reason: 'syntax' };
        return { type: 'result', id, ok: true, svg: lifted.svg, css: lifted.css };
      } catch (e) {
        const message = firstLine(e);
        return { type: 'result', id, ok: false, reason: /edge limit/i.test(message) ? 'oversized' : 'syntax', message };
      } finally {
        // Mermaid can leave its measuring node in <body> after an error.
        document.getElementById(`d${id}`)?.remove();
      }
    },
  };
}
