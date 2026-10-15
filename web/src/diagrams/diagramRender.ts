import { createFrameClient, type FrameClient } from './frameClient';
import { connectFrame } from './frameHost';
import { MAX_TEXT_SIZE } from './protocol';
import { prepareDiagramSvg } from './svgSanitize';
import { readDiagramTheme } from './theme';

const MAX_CACHED = 50;

export type DiagramResult =
  | { ok: true; id: string; svg: string; css: string }
  | { ok: false; reason: 'oversized' | 'syntax' | 'load' | 'timeout'; message?: string };

interface Entry {
  promise: Promise<DiagramResult>;
  value?: DiagramResult;
}

let client: FrameClient | null = null;
let counter = 0;
const cache = new Map<string, Entry>();

function frameClient(): FrameClient {
  client ??= createFrameClient(() => connectFrame(readDiagramTheme()));
  return client;
}

async function draw(text: string): Promise<DiagramResult> {
  // A fresh id per source: Mermaid scopes its css to it, and cached results must never collide on a page.
  const id = `inked-dg-${++counter}`;
  const out = await frameClient().render(id, text);
  if (!out.ok) return { ok: false, reason: out.reason, message: out.message };
  // The frame is another window: its svg is untrusted.
  const prepared = prepareDiagramSvg(out.svg, out.css);
  if (!prepared) return { ok: false, reason: 'syntax' };
  return { ok: true, id, ...prepared };
}

export function peekDiagram(source: string): DiagramResult | undefined {
  return cache.get(source.trim())?.value;
}

export function renderDiagram(source: string): Promise<DiagramResult> {
  const text = source.trim();
  if (text.length > MAX_TEXT_SIZE) return Promise.resolve({ ok: false, reason: 'oversized' });
  const hit = cache.get(text);
  if (hit) return hit.promise;
  const entry: Entry = { promise: draw(text) };
  cache.set(text, entry);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  void entry.promise.then((r) => {
    // A load failure or a timeout may be transient: the next view tries again.
    if (!r.ok && (r.reason === 'load' || r.reason === 'timeout')) cache.delete(text);
    else entry.value = r;
  });
  return entry.promise;
}

/** Drop every rendered diagram and the frame. Called when the keys are dropped (lock, sign-out). */
export function clearDiagrams(): void {
  cache.clear();
  client?.reset();
}
