import { describe, expect, it } from 'vitest';
import { EMBED_DEVICE } from './device';

describe('EMBED_DEVICE', () => {
  it('is WASM, so every browser writes vectors in the same space', () => {
    expect(EMBED_DEVICE).toBe('wasm');
  });
});
