import { describe, expect, it } from 'vitest';
import { generateLinkToken, LINK_TOKEN_RE } from '../src/openboard/token.js';
import { ADJECTIVES, ANIMALS, SCENES } from '../src/openboard/words.js';

describe('openboard link token', () => {
  it('matches the token format', () => {
    expect(generateLinkToken()).toMatch(LINK_TOKEN_RE);
  });
  it('has enough word entropy', () => {
    expect(ADJECTIVES.length).toBeGreaterThanOrEqual(256);
    expect(ANIMALS.length).toBeGreaterThanOrEqual(256);
    expect(SCENES.length).toBeGreaterThanOrEqual(64);
  });
  it('words are lowercase a-z and unique', () => {
    for (const list of [ADJECTIVES, ANIMALS]) {
      for (const w of list) expect(w).toMatch(/^[a-z]+$/);
      expect(new Set(list).size).toBe(list.length);
    }
    for (const w of SCENES) expect(w).toMatch(/^[a-z]+(-[a-z]+)*$/);
    expect(new Set(SCENES).size).toBe(SCENES.length);
  });
  it('does not repeat across 2000 calls', () => {
    expect(new Set(Array.from({ length: 2000 }, generateLinkToken)).size).toBe(2000);
  });
  it('ends with a 12-char suffix', () => {
    expect(generateLinkToken().split('-').pop()).toHaveLength(12);
  });
});
