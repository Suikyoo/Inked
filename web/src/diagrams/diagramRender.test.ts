// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameOutcome } from './frameClient';

const frame = { render: vi.fn<(id: string, source: string) => Promise<FrameOutcome>>(), reset: vi.fn() };
const createFrameClient = vi.fn((_connect: () => Promise<unknown>) => frame);
const connectFrame = vi.fn();
vi.mock('./frameClient', () => ({ createFrameClient: (c: () => Promise<unknown>) => createFrameClient(c) }));
vi.mock('./frameHost', () => ({ connectFrame: (t: unknown) => connectFrame(t) }));
vi.mock('./theme', () => ({ readDiagramTheme: () => ({ darkMode: true, tag: 'theme' }) }));

// What the frame sends after lifting: no <style>, no style attribute.
const OK_SVG =
  '<svg id="inked-dg-1" viewBox="0 0 1 1" xmlns="http://www.w3.org/2000/svg"><rect class="n" data-inline-style="opacity: 0.5"/></svg>';
const OK_CSS = '#inked-dg-1 .n{fill:red}';

async function load() {
  vi.resetModules();
  return import('./diagramRender');
}

beforeEach(() => {
  frame.render.mockReset();
  frame.reset.mockReset();
  createFrameClient.mockClear();
  connectFrame.mockReset();
});

describe('renderDiagram', () => {
  it('renders through the frame, sanitizes, and returns the css separately', async () => {
    const mod = await load();
    frame.render.mockResolvedValue({ ok: true, svg: OK_SVG, css: OK_CSS });
    const r = await mod.renderDiagram('  graph TD; A-->B\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.id).toMatch(/^inked-dg-\d+$/);
    expect(r.svg).not.toContain('<style');
    expect(r.svg).toContain('data-inline-style="opacity: 0.5"');
    expect(r.css).toContain('.n{fill:red}');
    expect(frame.render).toHaveBeenCalledWith(r.id, 'graph TD; A-->B');
  });

  it('connects the frame lazily, once, with the current theme', async () => {
    const mod = await load();
    expect(createFrameClient).not.toHaveBeenCalled();
    frame.render.mockResolvedValue({ ok: true, svg: OK_SVG, css: OK_CSS });
    await mod.renderDiagram('graph TD; A-->B');
    await mod.renderDiagram('graph TD; B-->C');
    expect(createFrameClient).toHaveBeenCalledTimes(1);
    createFrameClient.mock.calls[0][0]();
    expect(connectFrame).toHaveBeenCalledWith({ darkMode: true, tag: 'theme' });
  });

  it('refuses an oversized source without touching the frame', async () => {
    const mod = await load();
    const r = await mod.renderDiagram(`graph TD;\n${'A-->B;\n'.repeat(5000)}`);
    expect(r).toEqual({ ok: false, reason: 'oversized' });
    expect(frame.render).not.toHaveBeenCalled();
    expect(createFrameClient).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, reason: 'syntax', message: 'Parse error on line 2:' } as const],
    [{ ok: false, reason: 'oversized' } as const],
  ])('passes a frame failure through (%j)', async (outcome) => {
    const mod = await load();
    frame.render.mockResolvedValue(outcome);
    expect(await mod.renderDiagram('graph TD; A-->B')).toEqual(outcome);
  });

  it('treats svg that sanitizes to nothing as a syntax failure', async () => {
    const mod = await load();
    frame.render.mockResolvedValue({ ok: true, svg: '<div>not an svg</div>', css: '' });
    expect(await mod.renderDiagram('graph TD; A-->B')).toMatchObject({ ok: false, reason: 'syntax' });
  });

  it('caches by source: one render, same object, and peek sees it once settled', async () => {
    const mod = await load();
    frame.render.mockResolvedValue({ ok: true, svg: OK_SVG, css: OK_CSS });
    expect(mod.peekDiagram('graph TD; A-->B')).toBeUndefined();
    const p = mod.renderDiagram('graph TD; A-->B');
    expect(mod.peekDiagram('graph TD; A-->B')).toBeUndefined();
    const first = await p;
    const second = await mod.renderDiagram('  graph TD; A-->B\n');
    expect(frame.render).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(mod.peekDiagram('graph TD; A-->B')).toBe(first);
  });

  it.each(['load', 'timeout'] as const)('does not cache a %s failure, so the next view retries', async (reason) => {
    const mod = await load();
    frame.render.mockResolvedValueOnce({ ok: false, reason });
    expect(await mod.renderDiagram('graph TD; A-->B')).toEqual({ ok: false, reason });
    expect(mod.peekDiagram('graph TD; A-->B')).toBeUndefined();
    frame.render.mockResolvedValueOnce({ ok: true, svg: OK_SVG, css: OK_CSS });
    expect((await mod.renderDiagram('graph TD; A-->B')).ok).toBe(true);
    expect(frame.render).toHaveBeenCalledTimes(2);
  });

  it('keeps at most 50 results', async () => {
    const mod = await load();
    frame.render.mockResolvedValue({ ok: true, svg: OK_SVG, css: OK_CSS });
    for (let i = 0; i < 51; i++) await mod.renderDiagram(`graph TD; A${i}-->B`);
    expect(mod.peekDiagram('graph TD; A0-->B')).toBeUndefined();
    expect(mod.peekDiagram('graph TD; A50-->B')).toBeDefined();
  });

  it('clearDiagrams empties the cache and resets the frame', async () => {
    const mod = await load();
    frame.render.mockResolvedValue({ ok: true, svg: OK_SVG, css: OK_CSS });
    await mod.renderDiagram('graph TD; A-->B');
    mod.clearDiagrams();
    expect(frame.reset).toHaveBeenCalledTimes(1);
    expect(mod.peekDiagram('graph TD; A-->B')).toBeUndefined();
    await mod.renderDiagram('graph TD; A-->B');
    expect(frame.render).toHaveBeenCalledTimes(2);
  });

  it('clearDiagrams before any render is harmless', async () => {
    const mod = await load();
    expect(() => mod.clearDiagrams()).not.toThrow();
    expect(createFrameClient).not.toHaveBeenCalled();
  });
});
