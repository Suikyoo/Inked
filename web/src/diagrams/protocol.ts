/** Messages between the note view and the sandboxed diagram frame. Both sides validate everything they receive. */

export const CONNECT = 'inked-diagram-connect';
export const MAX_TEXT_SIZE = 20_000;
export const MAX_SVG_SIZE = 2_000_000;

/** Mermaid theme variables: literal colors, a font family and size, never var(). */
export type DiagramTheme = Record<string, string | boolean>;

export type FailReason = 'oversized' | 'syntax' | 'load';

export interface ConnectMessage {
  type: typeof CONNECT;
  theme: DiagramTheme;
}
export interface ReadyMessage {
  type: 'ready';
}
export interface RenderRequest {
  type: 'render';
  id: string;
  source: string;
}
export type RenderResult =
  | { type: 'result'; id: string; ok: true; svg: string }
  | { type: 'result'; id: string; ok: false; reason: FailReason; message?: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function isConnectMessage(v: unknown): v is ConnectMessage {
  return isObject(v) && v.type === CONNECT && isObject(v.theme);
}

export function isReadyMessage(v: unknown): v is ReadyMessage {
  return isObject(v) && v.type === 'ready';
}

export function isRenderRequest(v: unknown): v is RenderRequest {
  return isObject(v) && v.type === 'render' && typeof v.id === 'string' && typeof v.source === 'string';
}

export function isRenderResult(v: unknown): v is RenderResult {
  if (!isObject(v) || v.type !== 'result' || typeof v.id !== 'string') return false;
  if (v.ok === true) return typeof v.svg === 'string';
  return (
    v.ok === false &&
    (v.reason === 'oversized' || v.reason === 'syntax' || v.reason === 'load') &&
    (v.message === undefined || typeof v.message === 'string')
  );
}
