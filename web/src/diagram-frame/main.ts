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
        void renderer.render(m.data.id, m.data.source).then((result) => port.postMessage(result));
      };
      port.postMessage({ type: 'ready' });
    },
  }),
);
