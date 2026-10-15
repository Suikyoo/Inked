// @vitest-environment jsdom
import { MessageChannel as NodeMessageChannel } from 'node:worker_threads';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectFrame } from './frameHost';

const theme = { darkMode: true };
const realMessageChannel = globalThis.MessageChannel;

let channel: InstanceType<typeof NodeMessageChannel>;
let channels: (typeof channel)[];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  channels = [];
  // A real channel (Node's), so the two ends can actually talk to each other.
  globalThis.MessageChannel = class {
    constructor() {
      channel = new NodeMessageChannel();
      channels.push(channel);
      return channel as unknown as MessageChannel;
    }
  } as unknown as typeof MessageChannel;
});
afterEach(() => {
  globalThis.MessageChannel = realMessageChannel;
  vi.useRealTimers();
  document.querySelectorAll('iframe').forEach((f) => f.remove());
  for (const c of channels) {
    c.port1.close();
    c.port2.close();
  }
});

const frameEl = () => document.querySelector('iframe')!;

/** Fire the iframe's load event and capture what the page posts to it. */
function loadFrame() {
  const iframe = frameEl();
  const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {});
  iframe.dispatchEvent(new Event('load'));
  return post;
}

describe('connectFrame', () => {
  it('appends a sandboxed, hidden, unfocusable iframe for the frame page', () => {
    void connectFrame(theme).catch(() => {});
    const iframe = frameEl();
    expect(iframe.parentElement).toBe(document.body);
    expect(iframe.getAttribute('sandbox')).toBe('allow-scripts');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(iframe.getAttribute('src')!.endsWith('/frame/frame.html')).toBe(true);
    expect(iframe.className).toBe('diagram-frame');
    expect(iframe.getAttribute('aria-hidden')).toBe('true');
    expect(iframe.getAttribute('tabindex')).toBe('-1');
  });

  it('posts nothing before load, then the connect message with the theme and one port, to any origin', () => {
    void connectFrame(theme).catch(() => {});
    const iframe = frameEl();
    const post = vi.spyOn(iframe.contentWindow!, 'postMessage').mockImplementation(() => {});
    expect(post).not.toHaveBeenCalled();
    iframe.dispatchEvent(new Event('load'));
    expect(post).toHaveBeenCalledTimes(1);
    const [message, origin, transfer] = post.mock.calls[0] as unknown as [unknown, string, unknown[]];
    expect(message).toEqual({ type: 'inked-diagram-connect', theme });
    expect(origin).toBe('*');
    expect(transfer).toHaveLength(1);
    expect(transfer[0]).toBe(channel.port2);
  });

  it('resolves with the port and a dispose when the frame says ready', async () => {
    const p = connectFrame(theme);
    loadFrame();
    channel.port2.postMessage({ type: 'ready' });
    const conn = await p;
    expect(conn.port).toBe(channel.port1);
    expect(typeof conn.dispose).toBe('function');
    expect(vi.getTimerCount()).toBe(0);
    conn.dispose();
  });

  it('ignores other messages while waiting for ready', async () => {
    const p = connectFrame(theme);
    loadFrame();
    channel.port2.postMessage({ type: 'nope' });
    let settled = false;
    void p.then(
      () => (settled = true),
      () => (settled = true),
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    channel.port2.postMessage({ type: 'ready' });
    await p;
  });

  it('rejects and removes the iframe when ready does not arrive within 15 seconds', async () => {
    const p = connectFrame(theme);
    const assertion = expect(p).rejects.toThrow('did not become ready');
    await vi.advanceTimersByTimeAsync(14_999);
    expect(document.querySelector('iframe')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('dispose removes the iframe and closes the port', async () => {
    const p = connectFrame(theme);
    loadFrame();
    channel.port2.postMessage({ type: 'ready' });
    const conn = await p;
    const close = vi.spyOn(conn.port, 'close');
    conn.dispose();
    expect(document.querySelector('iframe')).toBeNull();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
