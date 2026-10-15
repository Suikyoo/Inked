import { describe, expect, it } from 'vitest';
import { buildEntry, searchBodies } from './search';

const ID = '3f2b8c1e-5d4a-4e7b-9a6c-1d2e3f4a5b6c';
const entry = buildEntry('n1', 'v1', 'Vault', [], 'Title', '2026-01-01T00:00:00.000Z');
const bodies = { n1: `intro ![diagram of flow](inked://${ID}) outro` };

describe('searchBodies and image references', () => {
  it('does not match the inked:// target or the id', () => {
    expect(searchBodies('inked', [entry], bodies, new Set())).toEqual([]);
    expect(searchBodies('3f2b8c1e', [entry], bodies, new Set())).toEqual([]);
  });
  it('still matches the alt text and builds the snippet from the stripped text', () => {
    const hits = searchBodies('diagram', [entry], bodies, new Set());
    expect(hits).toHaveLength(1);
    expect(hits[0].snippet).toEqual({ before: 'intro ', hit: 'diagram', after: ' of flow outro' });
  });
});
