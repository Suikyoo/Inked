import { describe, expect, it } from 'vitest';
import { nextVaultColor, VAULT_COLORS } from './index';

describe('nextVaultColor', () => {
  it('starts with the first color', () => {
    expect(nextVaultColor([])).toBe(VAULT_COLORS[0]);
  });

  it('picks the least used color, case-insensitively, earliest on a tie', () => {
    expect(nextVaultColor(['#45a89e'])).toBe('#D19C3C');
    expect(nextVaultColor([...VAULT_COLORS, '#45A89E'])).toBe('#D19C3C');
  });
});
