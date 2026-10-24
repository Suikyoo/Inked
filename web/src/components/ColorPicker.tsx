import { VAULT_COLORS } from 'inked-core/vaultColors';

/**
 * The vault colour swatches, plus a custom colour well.
 *
 * Imports straight from `inked-core/vaultColors` rather than the barrel, so the openboard pages can use it
 * without dragging the crypto tree into their bundles (see `docs/architecture.md`).
 */
export function ColorPicker({ value, onChange, label }: { value: string; onChange: (c: string) => void; label: string }) {
  const custom = !VAULT_COLORS.some((c) => c.toLowerCase() === value.toLowerCase());
  return (
    <div className="swatches" role="radiogroup" aria-label={label}>
      {VAULT_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={c.toLowerCase() === value.toLowerCase()}
          aria-label={c}
          className="swatch"
          style={{ background: c }}
          onClick={() => onChange(c)}
        />
      ))}
      <label className={custom ? 'swatch swatch-custom is-on' : 'swatch swatch-custom'} title="Custom colour">
        <span className="sr-only">Custom colour</span>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} spellCheck={false} />
      </label>
    </div>
  );
}
