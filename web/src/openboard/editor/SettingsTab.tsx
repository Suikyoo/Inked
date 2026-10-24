import { useState, type FormEvent } from 'react';
import type { ObPayload, ObVault } from 'inked-core';
import { ColorPicker } from '../../components/ColorPicker';
import { ObApiError, errorText, updateOwnerVault } from '../api';

/** The server's cap on a vault name (server/src/openboard/write.ts). */
const OB_TITLE_MAX = 200;

export interface SettingsTabProps {
  /** Everything published, which is where the native vaults are found. */
  content: ObPayload;
  /** Refetches content after a rename or recolour. */
  onChanged: () => Promise<void>;
  onAuthLost: () => void;
}

/**
 * Settings for the vaults authored in openboard: their name and their colour.
 *
 * Only native vaults appear. A published vault's name and colour belong to the private vault it came from —
 * the server refuses to change them here (400 `not_native`) — so listing them would offer something that
 * cannot work. The page says as much rather than leaving their absence a mystery.
 */
export function SettingsTab({ content, onChanged, onAuthLost }: SettingsTabProps) {
  const native = content.vaults.filter((v) => v.origin === 'native');
  const published = content.vaults.filter((v) => v.origin !== 'native');

  return (
    <div className="obe-settings">
      <header className="obe-settings-head">
        <h2 className="obe-side-title">Openboard vaults</h2>
        <p className="obe-lead">
          Vaults you wrote here, rather than published from Inked. Their notes are stored unencrypted and exist nowhere
          else.
        </p>
      </header>

      {native.length === 0 ? (
        <p className="ob-rail-empty">
          You haven’t made any Openboard vaults yet. Use “New Openboard vault” on the Published content tab.
        </p>
      ) : (
        <ul className="obe-vault-list">
          {native.map((v) => (
            <li key={v.id}>
              <VaultSettings vault={v} onChanged={onChanged} onAuthLost={onAuthLost} />
            </li>
          ))}
        </ul>
      )}

      {published.length > 0 && (
        <p className="field-hint">
          {published.length === 1 ? 'One other vault is' : `${published.length} other vaults are`} published from Inked. Their
          names and colours come from your notes, so change them there and publish again.
        </p>
      )}
    </div>
  );
}

/** One native vault's name and colour. Only what changed is sent. */
function VaultSettings({ vault, onChanged, onAuthLost }: { vault: ObVault; onChanged: () => Promise<void>; onAuthLost: () => void }) {
  const [name, setName] = useState(vault.name);
  const [color, setColor] = useState(vault.color);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const nameChanged = name.trim() !== vault.name;
  const colorChanged = color.toLowerCase() !== vault.color.toLowerCase();
  const ready = name.trim().length > 0 && (nameChanged || colorChanged);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await updateOwnerVault(vault.id, { ...(nameChanged ? { name: name.trim() } : {}), ...(colorChanged ? { color } : {}) });
      setStatus('Saved');
      await onChanged();
    } catch (err) {
      if (err instanceof ObApiError && err.status === 401) onAuthLost();
      // The typed name stays, so the owner can edit it rather than retype it.
      setError(err instanceof ObApiError && err.code === 'name_taken' ? `You already have a vault called “${name.trim()}”.` : errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card obe-vault-settings" onSubmit={submit} noValidate aria-label={`Settings for “${vault.name}”`}>
      <label className="field-label" htmlFor={`obe-vault-name-${vault.id}`}>
        Name
      </label>
      <input
        id={`obe-vault-name-${vault.id}`}
        type="text"
        className="input input-sm"
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={OB_TITLE_MAX}
        spellCheck={false}
        autoComplete="off"
        disabled={busy}
      />
      <ColorPicker value={color} onChange={setColor} label={`Colour for “${vault.name}”`} />
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="row-actions">
        <button type="submit" className="btn btn-sm" disabled={!ready || busy}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        {status && <span className="field-hint">{status}</span>}
      </div>
    </form>
  );
}
