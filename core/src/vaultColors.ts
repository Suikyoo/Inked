/** The vault colors the apps offer, in the order new vaults cycle through them. */
export const VAULT_COLORS = ['#45A89E', '#D19C3C', '#6F95D6', '#D9768F'] as const;

/** The least used vault color; a tie goes to the earliest in VAULT_COLORS. */
export function nextVaultColor(used: string[]): string {
  const counts = VAULT_COLORS.map((c) => used.filter((u) => u.toUpperCase() === c).length);
  const min = Math.min(...counts);
  return VAULT_COLORS[counts.indexOf(min)];
}
