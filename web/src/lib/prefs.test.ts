// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { prefs } from './prefs';

describe('prefs.spellcheck', () => {
  beforeEach(() => localStorage.clear());
  it('defaults to off (M7)', () => expect(prefs.spellcheck()).toBe(false));
  it('persists', () => {
    prefs.setSpellcheck(true);
    expect(prefs.spellcheck()).toBe(true);
  });
});

describe('prefs.semanticChoice', () => {
  beforeEach(() => localStorage.clear());
  it('is unset by default and persists on and off', () => {
    expect(prefs.semanticChoice()).toBeNull();
    prefs.setSemanticChoice('on');
    expect(prefs.semanticChoice()).toBe('on');
    prefs.setSemanticChoice('off');
    expect(prefs.semanticChoice()).toBe('off');
    prefs.setSemanticChoice(null);
    expect(prefs.semanticChoice()).toBeNull();
  });
  it('reads the round-4 values: 1 is on, 0 is unset', () => {
    localStorage.setItem('inked.semantic', '1');
    expect(prefs.semanticChoice()).toBe('on');
    localStorage.setItem('inked.semantic', '0');
    expect(prefs.semanticChoice()).toBeNull();
  });
});

describe('prefs.diagrams', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });
  it('is on by default', () => {
    expect(prefs.diagrams()).toBe(true);
  });
  it('round-trips off and on', () => {
    prefs.setDiagrams(false);
    expect(prefs.diagrams()).toBe(false);
    expect(localStorage.getItem('inked.diagrams')).toBe('off');
    prefs.setDiagrams(true);
    expect(prefs.diagrams()).toBe(true);
    expect(localStorage.getItem('inked.diagrams')).toBeNull();
  });
  it('is on when storage is unavailable, and setting it does not throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(prefs.diagrams()).toBe(true);
    expect(() => prefs.setDiagrams(false)).not.toThrow();
  });
});
