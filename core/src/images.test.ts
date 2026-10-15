import { describe, expect, it } from 'vitest';
import { aad } from './crypto/aad';
import {
  decryptImage,
  encryptImage,
  IMAGE_BLOB_OVERHEAD,
  imageToken,
  parseImageUri,
  sniffImageType,
  stripImageRefs,
} from './images';

const makeKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const VAULT = '7c1d9a52-3b6e-4f08-8a21-5d4c6e7f8091';
const ID = '3f2b8c1e-5d4a-4e7b-9a6c-1d2e3f4a5b6c';

describe('aad.image', () => {
  it('binds the vault and the image', () => {
    expect(aad.image(VAULT, ID)).toBe(`inked/image/${VAULT}/${ID}`);
  });
});

describe('encryptImage / decryptImage', () => {
  it('round-trips and adds exactly iv + tag', async () => {
    const key = await makeKey();
    const blob = await encryptImage(key, VAULT, ID, PNG);
    expect(blob.length).toBe(PNG.length + IMAGE_BLOB_OVERHEAD);
    expect(await decryptImage(key, VAULT, ID, blob)).toEqual(PNG);
  });
  it('does not contain the plaintext', async () => {
    const key = await makeKey();
    const plain = new Uint8Array(64).fill(0x41);
    const blob = await encryptImage(key, VAULT, ID, plain);
    expect(Buffer.from(blob).includes(Buffer.from(plain.slice(0, 16)))).toBe(false);
  });
  it('uses a fresh IV each time', async () => {
    const key = await makeKey();
    const a = await encryptImage(key, VAULT, ID, PNG);
    const b = await encryptImage(key, VAULT, ID, PNG);
    expect(a.slice(0, 12)).not.toEqual(b.slice(0, 12));
  });
  it('fails for another vault id, another image id, another key, or a flipped byte', async () => {
    const key = await makeKey();
    const blob = await encryptImage(key, VAULT, ID, PNG);
    await expect(decryptImage(key, 'other-vault', ID, blob)).rejects.toMatchObject({ name: 'CryptoError' });
    await expect(decryptImage(key, VAULT, 'other-image', blob)).rejects.toMatchObject({ name: 'CryptoError' });
    await expect(decryptImage(await makeKey(), VAULT, ID, blob)).rejects.toMatchObject({ name: 'CryptoError' });
    const bad = blob.slice();
    bad[20] ^= 1;
    await expect(decryptImage(key, VAULT, ID, bad)).rejects.toMatchObject({ name: 'CryptoError' });
  });
  it('rejects a blob shorter than iv + tag + 1', async () => {
    const key = await makeKey();
    await expect(decryptImage(key, VAULT, ID, new Uint8Array(28))).rejects.toMatchObject({ name: 'CryptoError' });
  });
});

describe('sniffImageType', () => {
  const ascii = (s: string) => new TextEncoder().encode(s);
  it('recognises png, jpeg, gif and webp', () => {
    expect(sniffImageType(PNG)).toBe('png');
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe('jpeg');
    expect(sniffImageType(ascii('GIF87a....'))).toBe('gif');
    expect(sniffImageType(ascii('GIF89a....'))).toBe('gif');
    expect(sniffImageType(ascii('RIFF\x10\x00\x00\x00WEBPVP8 '))).toBe('webp');
  });
  it('refuses SVG, HTML, other RIFF files, and empty input', () => {
    expect(sniffImageType(ascii('<svg xmlns="http://www.w3.org/2000/svg"></svg>'))).toBeNull();
    expect(sniffImageType(ascii('<!doctype html><script>alert(1)</script>'))).toBeNull();
    expect(sniffImageType(ascii('RIFF\x10\x00\x00\x00WAVEfmt '))).toBeNull();
    expect(sniffImageType(new Uint8Array(0))).toBeNull();
  });
});

describe('image references', () => {
  it('makes a well-formed token', () => {
    expect(imageToken(ID, 'a chart')).toBe(`![a chart](inked://${ID})`);
    expect(imageToken(ID)).toBe(`![](inked://${ID})`);
  });
  it('keeps hostile alt text from breaking out of the token', () => {
    const t = imageToken(ID, 'x](javascript:alert(1))\n[y');
    expect(t).toBe(`![x javascript:alert 1 y](inked://${ID})`);
    expect(t.split('\n')).toHaveLength(1);
    expect(stripImageRefs(t)).toBe('x javascript:alert 1 y');
  });
  it('parses only a lowercase v4 id in an inked:// uri', () => {
    expect(parseImageUri(`inked://${ID}`)).toBe(ID);
    expect(parseImageUri(`inked://${ID}/x`)).toBeNull();
    expect(parseImageUri(`https://${ID}`)).toBeNull();
    expect(parseImageUri('inked://not-a-uuid')).toBeNull();
    expect(parseImageUri(`inked://${ID.toUpperCase()}`)).toBeNull();
  });
  it('strips targets and keeps the alt text', () => {
    expect(stripImageRefs(`see ![the shot](inked://${ID}) now`)).toBe('see the shot now');
    expect(stripImageRefs(`a ![](inked://${ID}) b`)).toBe('a  b');
    expect(stripImageRefs('![x](https://example.com/a.png)')).toBe('![x](https://example.com/a.png)');
  });
});
