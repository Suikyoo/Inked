import '@fontsource/public-sans/400.css';
import '@fontsource/public-sans/500.css';
import '@fontsource/public-sans/600.css';
import { isRenderRequest } from '../diagrams/protocol';
import { loadFonts } from './fonts';
import { createConnectListener } from './handshake';
import { createRenderer } from './renderer';

window.addEventListener(
  'message',
  createConnectListener({
    parent: window.parent,
    onConnected: (port, theme) => {
      const renderer = createRenderer({
        theme,
        loadMermaid: () => import('mermaid').then((m) => m.default),
        loadFonts: () => loadFonts(document.fonts),
      });
      port.onmessage = (m: MessageEvent) => {
        if (!isRenderRequest(m.data)) return;
        const { id, source } = m.data;
        void renderer
          .render(id, source)
          .then((result) => port.postMessage(result))
          // An unexpected rejection still answers, instead of leaving the page to time out.
          .catch(() => port.postMessage({ type: 'result', id, ok: false, reason: 'syntax' }));
      };
      port.postMessage({ type: 'ready' });
    },
  }),
);
