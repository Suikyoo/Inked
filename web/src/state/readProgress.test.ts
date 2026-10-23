import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReadProgressQueue, type ReadProgressItem } from './readProgress';

const item = (noteId: string, pct: number, size = 100): ReadProgressItem => ({ noteId, pct, size });

describe('ReadProgressQueue', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('batches entries and sends once after 10 s', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const q = new ReadProgressQueue(send);
    q.enqueue(item('a', 25));
    q.enqueue(item('b', 50));
    expect(send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith([item('a', 25), item('b', 50)], { keepalive: false });
    expect(q.size).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('keeps the higher pct for the same size and the newest size otherwise', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const q = new ReadProgressQueue(send);
    q.enqueue(item('a', 50, 100));
    q.enqueue(item('a', 25, 100));
    q.enqueue(item('b', 25, 100));
    q.enqueue(item('b', 25, 200));
    q.enqueue(item('c', 25, 100));
    q.enqueue(item('c', 75, 100));
    q.enqueue(item('d', 100, 100));
    q.enqueue(item('d', 25, 300));
    expect(q.size).toBe(4);
    await q.flush();
    expect(send.mock.calls[0][0]).toEqual([item('a', 50, 100), item('b', 25, 200), item('c', 75, 100), item('d', 25, 300)]);
  });

  it('re-queues on failure and retries on the next tick', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
    const q = new ReadProgressQueue(send);
    q.enqueue(item('a', 25));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(q.size).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toEqual([item('a', 25)]);
    expect(q.size).toBe(0);
  });

  it('a newer entry enqueued during a failed flush wins over the re-queued one', async () => {
    let fail!: (e: Error) => void;
    const send = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((_, rej) => (fail = rej)))
      .mockResolvedValue(undefined);
    const q = new ReadProgressQueue(send);
    q.enqueue(item('a', 25));
    q.enqueue(item('b', 25));
    const done = q.flush();
    q.enqueue(item('a', 50));
    fail(new Error('offline'));
    await expect(done).resolves.toBeUndefined();
    expect(q.size).toBe(2);
    await q.flush();
    expect(send.mock.calls[1][0]).toEqual([item('a', 50), item('b', 25)]);
  });

  it('a failed higher pct survives a newer lower pct of the same size', async () => {
    let fail!: (e: Error) => void;
    const send = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((_, rej) => (fail = rej)))
      .mockResolvedValue(undefined);
    const q = new ReadProgressQueue(send);
    q.enqueue(item('a', 100));
    const done = q.flush();
    q.enqueue(item('a', 50));
    fail(new Error('offline'));
    await done;
    await q.flush();
    expect(send.mock.calls[1][0]).toEqual([item('a', 100)]);
  });

  it('clear during a failing flush does not resurrect the old items', async () => {
    let fail!: (e: Error) => void;
    const send = vi
      .fn()
      .mockImplementationOnce(() => new Promise<void>((_, rej) => (fail = rej)))
      .mockResolvedValue(undefined);
    const q = new ReadProgressQueue(send);
    q.enqueue(item('old', 25));
    const done = q.flush();
    q.clear();
    fail(new Error('offline'));
    await done;
    expect(q.size).toBe(0);
    q.enqueue(item('new', 50));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toEqual([item('new', 50)]);
  });

  it('splits more than 200 entries into several requests', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const q = new ReadProgressQueue(send);
    for (let i = 0; i < 450; i++) q.enqueue(item(`n${i}`, 25));
    await q.flush();
    expect(send.mock.calls.map((c) => c[0].length)).toEqual([200, 200, 50]);
    expect(q.size).toBe(0);
  });

  it('flush({keepalive:true}) passes keepalive to send', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const q = new ReadProgressQueue(send);
    q.enqueue(item('a', 25));
    await q.flush({ keepalive: true });
    expect(send).toHaveBeenCalledWith([item('a', 25)], { keepalive: true });
  });

  it('clear stops the timer and drops entries', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const q = new ReadProgressQueue(send);
    q.enqueue(item('a', 25));
    q.clear();
    expect(q.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).not.toHaveBeenCalled();
    await q.flush();
    expect(send).not.toHaveBeenCalled();
  });
});
