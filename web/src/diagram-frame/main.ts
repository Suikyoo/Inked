import '@fontsource/public-sans/400.css';
import '@fontsource/public-sans/500.css';
import '@fontsource/public-sans/600.css';
import { isConnectMessage, isRenderRequest } from '../diagrams/protocol';
import { createRenderer } from './renderer';

async function loadFonts(): Promise<void> {
  const faces = ['400 14px "Public Sans"', '500 14px "Public Sans"', '600 14px "Public Sans"'];
  // Best effort: a font that is slow or missing must not block drawing.
  await Promise.race([Promise.all(faces.map((f) => document.fonts.load(f))), new Promise((r) => setTimeout(r, 3000))]);
}

let connected = false;
window.addEventListener('message', (e: MessageEvent) => {
  // Only the embedding page may connect, once, and it must hand over exactly one port.
  if (connected || e.source !== window.parent || !isConnectMessage(e.data) || e.ports.length !== 1) return;
  connected = true;
  const port = e.ports[0];
  const renderer = createRenderer({
    theme: e.data.theme,
    loadMermaid: () => import('mermaid').then((m) => m.default),
    loadFonts,
  });
  port.onmessage = (m: MessageEvent) => {
    if (!isRenderRequest(m.data)) return;
    void renderer.render(m.data.id, m.data.source).then((result) => port.postMessage(result));
  };
  port.postMessage({ type: 'ready' });
});
