import { IMAGE_MIME, MAX_IMAGE_BYTES, sniffImageType } from 'inked-core';

/** A file that cannot be added; `message` is safe to show the user. */
export class ImageRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageRejectedError';
  }
}

/** The bytes of a Blob; falls back to FileReader where Blob.arrayBuffer is missing (jsdom). */
export async function blobBytes(file: Blob): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') return new Uint8Array(await file.arrayBuffer());
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(new Uint8Array(r.result as ArrayBuffer));
    r.onerror = () => reject(r.error);
    r.readAsArrayBuffer(file);
  });
}

export function validateImage(bytes: Uint8Array): void {
  if (bytes.length > MAX_IMAGE_BYTES) throw new ImageRejectedError('That image is larger than 10 MB.');
  if (!sniffImageType(bytes)) throw new ImageRejectedError('Only PNG, JPEG, GIF and WebP images can be added.');
}

export type ImageResult = { ok: true; url: string } | { ok: false };

export interface ImageBackend {
  /** The stored ciphertext blob. */
  download(vaultId: string, imageId: string): Promise<Uint8Array>;
  decrypt(vaultId: string, imageId: string, blob: Uint8Array): Promise<Uint8Array>;
}

interface UrlOps {
  makeUrl: (b: Blob) => string;
  revoke: (url: string) => void;
}

const key = (vaultId: string, imageId: string) => `${vaultId}/${imageId}`;

/** Decrypted images as blob: urls, in memory only. `clear` (lock, sign-out) revokes them all. */
export class ImageStore {
  private urls = new Map<string, string>();
  private inflight = new Map<string, Promise<ImageResult>>();
  private epoch = 0;

  constructor(
    private readonly backend: ImageBackend,
    private readonly ops: UrlOps = { makeUrl: (b) => URL.createObjectURL(b), revoke: (u) => URL.revokeObjectURL(u) },
  ) {}

  peek(vaultId: string, imageId: string): string | null {
    return this.urls.get(key(vaultId, imageId)) ?? null;
  }

  get(vaultId: string, imageId: string): Promise<ImageResult> {
    const k = key(vaultId, imageId);
    const hit = this.urls.get(k);
    if (hit) return Promise.resolve({ ok: true, url: hit });
    const running = this.inflight.get(k);
    if (running) return running;
    const epoch = this.epoch;
    let p!: Promise<ImageResult>;
    p = (async (): Promise<ImageResult> => {
      try {
        const blob = await this.backend.download(vaultId, imageId);
        const bytes = await this.backend.decrypt(vaultId, imageId, blob);
        const url = this.make(bytes);
        if (!url) return { ok: false };
        if (epoch !== this.epoch) {
          this.ops.revoke(url);
          return { ok: false };
        }
        this.urls.set(k, url);
        return { ok: true, url };
      } catch {
        return { ok: false };
      } finally {
        if (this.inflight.get(k) === p) this.inflight.delete(k);
      }
    })();
    this.inflight.set(k, p);
    return p;
  }

  /** Makes freshly encrypted bytes viewable at once, without a download. */
  put(vaultId: string, imageId: string, bytes: Uint8Array): void {
    const url = this.make(bytes);
    if (!url) return;
    const k = key(vaultId, imageId);
    const old = this.urls.get(k);
    if (old) this.ops.revoke(old);
    this.urls.set(k, url);
  }

  forget(vaultId: string, imageId: string): void {
    const k = key(vaultId, imageId);
    const old = this.urls.get(k);
    if (old) this.ops.revoke(old);
    this.urls.delete(k);
  }

  clear(): void {
    this.epoch++;
    for (const url of this.urls.values()) this.ops.revoke(url);
    this.urls.clear();
    this.inflight.clear();
  }

  private make(bytes: Uint8Array): string | null {
    const type = sniffImageType(bytes);
    return type ? this.ops.makeUrl(new Blob([bytes as BlobPart], { type: IMAGE_MIME[type] })) : null;
  }
}
