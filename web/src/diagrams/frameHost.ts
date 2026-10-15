import type { FrameConnection } from './frameClient';
import { CONNECT, isReadyMessage, type DiagramTheme } from './protocol';

const FRAME_URL = '/frame/frame.html';
const READY_TIMEOUT_MS = 15_000;

/**
 * Create the sandboxed diagram iframe, hand it one end of a MessageChannel with the theme, and resolve once it
 * says `ready`. The iframe has no `allow-same-origin`, so it cannot reach this page. It is hidden by the
 * `.diagram-frame` class (not display:none: Mermaid measures text and needs real layout).
 */
export function connectFrame(theme: DiagramTheme): Promise<FrameConnection> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.className = 'diagram-frame';
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('title', 'Diagram renderer');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    const channel = new MessageChannel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const dispose = () => {
      clearTimeout(timer);
      channel.port1.close();
      iframe.remove();
    };
    timer = setTimeout(() => {
      dispose();
      reject(new Error('The diagram frame did not become ready'));
    }, READY_TIMEOUT_MS);
    channel.port1.onmessage = (e: MessageEvent) => {
      if (!isReadyMessage(e.data)) return;
      clearTimeout(timer);
      resolve({ port: channel.port1, dispose });
    };
    iframe.addEventListener(
      'load',
      () => {
        // The frame's origin is opaque, so the target origin has to be '*'.
        iframe.contentWindow?.postMessage({ type: CONNECT, theme }, '*', [channel.port2]);
      },
      { once: true },
    );
    iframe.src = FRAME_URL;
    document.body.append(iframe);
  });
}
