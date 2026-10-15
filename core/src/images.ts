import { aad } from './crypto/aad';
import { IV_BYTES } from './crypto/cipher';
import { concatBytes, randomBytes, utf8, type Bytes } from './crypto/encoding';
import { CryptoError } from './crypto/errors';

/** Largest plaintext image the browser, the MCP and the server accept. */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
/** iv[12] + GCM tag[16]: what an encrypted image adds to its plaintext. */
export const IMAGE_BLOB_OVERHEAD = 28;

export type ImageType = 'png' | 'jpeg' | 'gif' | 'webp';
export const IMAGE_MIME: Readonly<Record<ImageType, string>> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

const at = (b: Uint8Array, sig: readonly number[], from = 0) =>
  b.length >= from + sig.length && sig.every((v, i) => b[from + i] === v);

/** The type from the first bytes, or null. SVG and HTML are never accepted. */
export function sniffImageType(b: Uint8Array): ImageType | null {
  if (at(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (at(b, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (at(b, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || at(b, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'gif';
  if (at(b, [0x52, 0x49, 0x46, 0x46]) && at(b, [0x57, 0x45, 0x42, 0x50], 8)) return 'webp';
  return null;
}

const subtle = () => globalThis.crypto.subtle;

/** `iv[12] || ciphertext||tag`, bound to the vault and image by AAD. */
export async function encryptImage(key: CryptoKey, vaultId: string, imageId: string, bytes: Uint8Array): Promise<Bytes> {
  const iv = randomBytes(IV_BYTES);
  const ct = await subtle().encrypt(
    { name: 'AES-GCM', iv, additionalData: utf8(aad.image(vaultId, imageId)) },
    key,
    bytes as Bytes,
  );
  return concatBytes(iv, new Uint8Array(ct));
}

export async function decryptImage(key: CryptoKey, vaultId: string, imageId: string, blob: Uint8Array): Promise<Bytes> {
  if (blob.length < IMAGE_BLOB_OVERHEAD + 1) throw new CryptoError('format', 'Image blob too short');
  const iv = blob.slice(0, IV_BYTES) as Bytes;
  const ct = blob.slice(IV_BYTES) as Bytes;
  try {
    const pt = await subtle().decrypt({ name: 'AES-GCM', iv, additionalData: utf8(aad.image(vaultId, imageId)) }, key, ct);
    return new Uint8Array(pt);
  } catch {
    throw new CryptoError('decrypt', 'Could not decrypt');
  }
}

const ID = '[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const URI_RE = new RegExp(`^inked://(${ID})$`);
const REF_RE = new RegExp(`!\\[([^\\]\\n]*)\\]\\(inked://${ID}\\)`, 'g');

/** The image id in an `inked://<id>` uri, or null. */
export function parseImageUri(uri: string): string | null {
  return URI_RE.exec(uri)?.[1] ?? null;
}

/** `![alt](inked://id)`. Brackets, parentheses, backslashes and line breaks in `alt` become spaces. */
export function imageToken(id: string, alt = ''): string {
  const clean = alt.replace(/[[\]()\\\r\n]/g, ' ').replace(/\s+/g, ' ').trim();
  return `![${clean}](inked://${id})`;
}

/** Replaces each `![alt](inked://id)` with `alt`, so search and embeddings never see the uri. */
export function stripImageRefs(body: string): string {
  return body.replace(REF_RE, '$1');
}
