// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFrameClient, type FrameConnection } from './frameClient';
import { MAX_SVG_SIZE } from './protocol';

const tick = () => new Promise<void>((r) => setImmediate(r));
async function until(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}

interface Fake {
  conn: FrameConnection;
  frame: MessagePort;
  seen: Array<{ type: string; id: string; source: string }>;
  dispose: ReturnType<typeof vi.fn>;
}

function fakeFrame(): Fake {
  const ch = new MessageChannel();
  const seen: Fake['seen'] = [];
  ch.port2.onmessage = (e) => seen.push(e.data);
  const dispose = vi.fn(() => {
    ch.port1.close();
    ch.port2.close();
  });
  return { conn: { port: ch.port1, dispose }, frame: ch.port2, seen, dispose };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => vi.useRealTimers());

describe('createFrameClient', () => {
  it('sends a render request and resolves with the svg', async () => {
    const f = fakeFrame();
    const client = createFrameClient(async () => f.conn);
    const p = client.render('inked-dg-1', 'graph TD; A-->B');
    await until(() => f.seen.length === 1);
    expect(f.seen[0]).toEqual({ type: 'render', id: 'inked-dg-1', source: 'graph TD; A-->B' });
    f.frame.postMessage({ type: 'result', id: 'inked-dg-1', ok: true, svg: '<svg/>' });
    expect(await p).toEqual({ ok: true, svg: '<svg/>' });
    client.reset();
  });

  it('maps a failure result', async () => {
    const f = fakeFrame();
    const client = createFrameClient(async () => f.conn);
    const p = client.render('a', 'x');
    await until(() => f.seen.length === 1);
    f.frame.postMessage({ type: 'result', id: 'a', ok: false, reason: 'syntax', message: 'Parse error on line 2:' });
    expect(await p).toEqual({ ok: false, reason: 'syntax', message: 'Parse error on line 2:' });
    client.reset();
  });

  it('ignores malformed messages and results for unknown ids', async () => {
    const f = fakeFrame();
    const client = createFrameClient(async () => f.conn);
    const p = client.render('a', 'x');
    await until(() => f.seen.length === 1);
    f.frame.postMessage('garbage');
    f.frame.postMessage({ type: 'result', id: 'zzz', ok: true, svg: '<svg/>' });
    f.frame.postMessage({ type: 'result', id: 'a', ok: true, svg: 5 });
    f.frame.postMessage({ type: 'result', id: 'a', ok: true, svg: '<svg id="real"/>' });
    expect(await p).toEqual({ ok: true, svg: '<svg id="real"/>' });
    client.reset();
  });

  it('turns an svg over the size cap into oversized', async () => {
    const f = fakeFrame();
    const client = createFrameClient(async () => f.conn);
    const p = client.render('a', 'x');
    await until(() => f.seen.length === 1);
    f.frame.postMessage({ type: 'result', id: 'a', ok: true, svg: 'x'.repeat(MAX_SVG_SIZE + 1) });
    expect(await p).toEqual({ ok: false, reason: 'oversized' });
    client.reset();
  });

  it('shares one connection between concurrent renders', async () => {
    const f = fakeFrame();
    const connect = vi.fn(async () => f.conn);
    const client = createFrameClient(connect);
    const p1 = client.render('a', 'x');
    const p2 = client.render('b', 'y');
    await until(() => f.seen.length === 2);
    expect(connect).toHaveBeenCalledTimes(1);
    f.frame.postMessage({ type: 'result', id: 'b', ok: true, svg: '<svg id="b"/>' });
    f.frame.postMessage({ type: 'result', id: 'a', ok: true, svg: '<svg id="a"/>' });
    expect(await p1).toEqual({ ok: true, svg: '<svg id="a"/>' });
    expect(await p2).toEqual({ ok: true, svg: '<svg id="b"/>' });
    client.reset();
  });

  it('reports a failed connect as load and tries again on the next render', async () => {
    const f = fakeFrame();
    const connect = vi.fn<() => Promise<FrameConnection>>().mockRejectedValueOnce(new Error('no ready')).mockResolvedValue(f.conn);
    const client = createFrameClient(connect);
    expect(await client.render('a', 'x')).toEqual({ ok: false, reason: 'load' });
    const p = client.render('b', 'x');
    await until(() => f.seen.length === 1);
    f.frame.postMessage({ type: 'result', id: 'b', ok: true, svg: '<svg/>' });
    expect((await p).ok).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
    client.reset();
  });

  it('times out, removes the frame, fails every pending request and reconnects next time', async () => {
    const first = fakeFrame();
    const second = fakeFrame();
    const connect = vi.fn<() => Promise<FrameConnection>>().mockResolvedValueOnce(first.conn).mockResolvedValue(second.conn);
    const client = createFrameClient(connect, { renderTimeoutMs: 1000 });
    const p1 = client.render('a', 'x');
    const p2 = client.render('b', 'y');
    await until(() => first.seen.length === 2);
    vi.advanceTimersByTime(1000);
    expect(await p1).toEqual({ ok: false, reason: 'timeout' });
    expect(await p2).toEqual({ ok: false, reason: 'timeout' });
    expect(first.dispose).toHaveBeenCalledTimes(1);
    const p3 = client.render('c', 'z');
    await until(() => second.seen.length === 1);
    expect(connect).toHaveBeenCalledTimes(2);
    second.frame.postMessage({ type: 'result', id: 'c', ok: true, svg: '<svg/>' });
    expect((await p3).ok).toBe(true);
    client.reset();
  });

  it('does not time out a request that was answered', async () => {
    const f = fakeFrame();
    const client = createFrameClient(async () => f.conn, { renderTimeoutMs: 1000 });
    const p = client.render('a', 'x');
    await until(() => f.seen.length === 1);
    f.frame.postMessage({ type: 'result', id: 'a', ok: true, svg: '<svg/>' });
    await p;
    vi.advanceTimersByTime(5000);
    expect(f.dispose).not.toHaveBeenCalled();
    client.reset();
  });

  it('reset removes the frame, fails pending requests as load and reconnects next time', async () => {
    const first = fakeFrame();
    const second = fakeFrame();
    const connect = vi.fn<() => Promise<FrameConnection>>().mockResolvedValueOnce(first.conn).mockResolvedValue(second.conn);
    const client = createFrameClient(connect);
    const p = client.render('a', 'x');
    await until(() => first.seen.length === 1);
    client.reset();
    expect(await p).toEqual({ ok: false, reason: 'load' });
    expect(first.dispose).toHaveBeenCalledTimes(1);
    const p2 = client.render('b', 'x');
    await until(() => second.seen.length === 1);
    expect(connect).toHaveBeenCalledTimes(2);
    second.frame.postMessage({ type: 'result', id: 'b', ok: true, svg: '<svg/>' });
    expect((await p2).ok).toBe(true);
    client.reset();
  });
});
