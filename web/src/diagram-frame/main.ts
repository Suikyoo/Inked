import '@fontsource/public-sans/400.css';
import '@fontsource/public-sans/500.css';
import '@fontsource/public-sans/600.css';
import { isConnectMessage, isRenderRequest } from '../diagrams/protocol';
import { loadFonts } from './fonts';
import { createRenderer } from './renderer';

let connected = false;
window.addEventListener('message', (e: MessageEvent) => {
  // Only the embedding page may connect, once, and it must hand over exactly one port.
  if (connected || e.source !== window.parent || !isConnectMessage(e.data) || e.ports.length !== 1) return;
  connected = true;
  const port = e.ports[0];
  const renderer = createRenderer({
    theme: e.data.theme,
    loadMermaid: () => import('mermaid').then((m) => m.default),
    loadFonts: () => loadFonts(document.fonts),
  });
  port.onmessage = (m: MessageEvent) => {
    if (!isRenderRequest(m.data)) return;
    void renderer.render(m.data.id, m.data.source).then((result) => port.postMessage(result));
  };
  port.postMessage({ type: 'ready' });
});
