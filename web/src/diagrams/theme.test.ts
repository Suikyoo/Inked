// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDiagramTheme } from './theme';

afterEach(() => vi.restoreAllMocks());

describe('readDiagramTheme', () => {
  it('reads colors from the CSS variables and trims them', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name: string) => (name === '--ink' ? ' #123456 ' : ''),
    } as unknown as CSSStyleDeclaration);
    const t = readDiagramTheme();
    expect(t.darkMode).toBe(true);
    expect(t.primaryBorderColor).toBe('#123456');
  });

  it('falls back to the dark token values when a variable is missing', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ getPropertyValue: () => '' } as unknown as CSSStyleDeclaration);
    const t = readDiagramTheme();
    expect(t.primaryColor).toBe('#24222c');
    expect(t.primaryTextColor).toBe('#e6e3ee');
    expect(t.fontSize).toBe('14px');
    expect(String(t.fontFamily)).toContain('Public Sans');
    // Mermaid does color maths on these, so none may be a var() reference.
    expect(Object.values(t).filter((v) => typeof v === 'string' && v.includes('var('))).toEqual([]);
  });
});
