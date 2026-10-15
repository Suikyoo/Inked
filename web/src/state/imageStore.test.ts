import { describe, expect, it, vi } from 'vitest';
import { blobBytes, ImageRejectedError, ImageStore, validateImage, type ImageBackend } from './imageStore';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const TEXT = new TextEncoder().encode('<svg></svg>');

function make(overrides: Partial<ImageBackend> = {}) {
  const backend: ImageBackend = {
    download: vi.fn(async () => new Uint8Array([9, 9, 9])),
    decrypt: vi.fn(async () => PNG),
    ...overrides,
  };
  let n = 0;
  const makeUrl = vi.fn(() => `blob:test/${++n}`);
  const revoke = vi.fn();
  return { backend, makeUrl, revoke, store: new ImageStore(backend, { makeUrl, revoke }) };
}

describe('ImageStore', () => {
  it('downloads and decrypts once for concurrent gets, then serves the cache', async () => {
    const { store, backend } = make();
    const [a, b] = await Promise.all([store.get('v', 'i'), store.get('v', 'i')]);
    expect(a).toEqual({ ok: true, url: 'blob:test/1' });
    expect(b).toEqual(a);
    expect(backend.download).toHaveBeenCalledTimes(1);
    expect(store.peek('v', 'i')).toBe('blob:test/1');
    await store.get('v', 'i');
    expect(backend.download).toHaveBeenCalledTimes(1);
  });
  it('reports a failed download or decrypt as unavailable and retries next time', async () => {
    const download = vi.fn().mockRejectedValueOnce(new Error('404')).mockResolvedValue(new Uint8Array([1]));
    const { store } = make({ download });
    expect(await store.get('v', 'i')).toEqual({ ok: false });
    expect(store.peek('v', 'i')).toBeNull();
    expect(await store.get('v', 'i')).toMatchObject({ ok: true });
  });
  it('treats decrypted bytes that are not an allowed image as unavailable', async () => {
    const { store, makeUrl } = make({ decrypt: vi.fn(async () => TEXT) });
    expect(await store.get('v', 'i')).toEqual({ ok: false });
    expect(makeUrl).not.toHaveBeenCalled();
  });
  it('put makes the image available without a download', async () => {
    const { store, backend } = make();
    store.put('v', 'i', PNG);
    expect(await store.get('v', 'i')).toMatchObject({ ok: true });
    expect(backend.download).not.toHaveBeenCalled();
  });
  it('forget revokes one url', () => {
    const { store, revoke } = make();
    store.put('v', 'i', PNG);
    store.forget('v', 'i');
    expect(revoke).toHaveBeenCalledWith('blob:test/1');
    expect(store.peek('v', 'i')).toBeNull();
  });
  it('clear revokes every url and the next get downloads again', async () => {
    const { store, backend, revoke } = make();
    await store.get('v', 'a');
    await store.get('v', 'b');
    store.clear();
    expect(revoke).toHaveBeenCalledTimes(2);
    expect(store.peek('v', 'a')).toBeNull();
    await store.get('v', 'a');
    expect(backend.download).toHaveBeenCalledTimes(3);
  });
  it('discards a result that finishes after clear: no url is kept or returned', async () => {
    let release!: (b: Uint8Array) => void;
    const download = vi.fn(() => new Promise<Uint8Array>((r) => (release = r)));
    const { store, revoke } = make({ download });
    const pending = store.get('v', 'i');
    store.clear();
    release(new Uint8Array([1]));
    expect(await pending).toEqual({ ok: false });
    expect(store.peek('v', 'i')).toBeNull();
    expect(revoke).toHaveBeenCalledTimes(1); // the url that was made is revoked at once
  });
});

describe('validateImage', () => {
  it('accepts png and refuses SVG', () => {
    expect(() => validateImage(PNG)).not.toThrow();
    expect(() => validateImage(TEXT)).toThrow(ImageRejectedError);
  });
  it('refuses more than 10 MiB', () => {
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set(PNG);
    expect(() => validateImage(big)).toThrow(/10 MB/);
    const ok = new Uint8Array(10 * 1024 * 1024);
    ok.set(PNG);
    expect(() => validateImage(ok)).not.toThrow();
  });
});

describe('blobBytes', () => {
  it('reads a Blob', async () => {
    expect(Array.from(await blobBytes(new Blob([PNG])))).toEqual(Array.from(PNG));
  });
});
