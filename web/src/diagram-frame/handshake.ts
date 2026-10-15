import { isConnectMessage, type DiagramTheme } from '../diagrams/protocol';

export interface HandshakeDeps {
  parent: Window;
  onConnected: (port: MessagePort, theme: DiagramTheme) => void;
}

/** The frame's `message` listener: only the embedding page may connect, once, and it must hand over exactly one port. */
export function createConnectListener(deps: HandshakeDeps): (e: MessageEvent) => void {
  let connected = false;
  return (e) => {
    if (connected || e.source !== deps.parent || !isConnectMessage(e.data) || e.ports.length !== 1) return;
    connected = true;
    deps.onConnected(e.ports[0], e.data.theme);
  };
}
