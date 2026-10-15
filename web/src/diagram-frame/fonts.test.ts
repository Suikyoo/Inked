import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadFonts } from './fonts';

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});
afterEach(() => {
  vi.useRealTimers();
});

describe('loadFonts', () => {
  it('resolves when every face loads, and leaves no timer behind', async () => {
    const load = vi.fn().mockResolvedValue([]);
    await loadFonts({ load });
    expect(load).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves, not rejects, when one face fails to load', async () => {
    const load = vi.fn().mockResolvedValueOnce([]).mockRejectedValueOnce(new Error('404')).mockResolvedValueOnce([]);
    await expect(loadFonts({ load })).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('resolves after the timeout when a face never settles', async () => {
    const load = vi.fn(() => new Promise<unknown>(() => {}));
    let done = false;
    const p = loadFonts({ load }, 3000).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(2999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(done).toBe(true);
  });
});
