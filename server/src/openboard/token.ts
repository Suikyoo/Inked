import { randomBytes, randomInt } from 'node:crypto';
import { ADJECTIVES, ANIMALS, SCENES } from './words.js';

export const LINK_TOKEN_RE = /^[a-z]+(?:-[a-z]+)*-[a-z2-7]{12}$/;

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const SUFFIX_LEN = 12;

const pick = (list: readonly string[]): string => list[randomInt(list.length)]!;

/** `<adjective>-<animal>-<scene>-<12 base32 chars>`, e.g. `jolly-otter-in-the-sun-k3x9...`. */
export function generateLinkToken(): string {
  // 8 bytes = 64 bits; use 5 bits at a time for 12 chars (60 bits).
  const bytes = randomBytes(8);
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  let suffix = '';
  for (let i = 0; i < SUFFIX_LEN; i++) {
    suffix += BASE32[Number((bits >> BigInt(i * 5)) & 31n)];
  }
  return `${pick(ADJECTIVES)}-${pick(ANIMALS)}-${pick(SCENES)}-${suffix}`;
}
