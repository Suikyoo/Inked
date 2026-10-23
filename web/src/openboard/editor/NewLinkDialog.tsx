import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import type { ObLink, ObPermission, ObVault } from 'inked-core';
import { Dialog } from '../../components/Dialog';
import { prefs } from '../../lib/prefs';
import { ObApiError, createLink, errorText, updateLink } from '../api';

export const LABEL_MAX = 80;

/** Checkboxes for the published vaults; `checked` holds vault ids. */
export function VaultChecklist({ vaults, checked, onChange, disabled }: { vaults: ObVault[]; checked: ReadonlySet<string>; onChange: (next: Set<string>) => void; disabled?: boolean }) {
  return (
    <fieldset className="obe-checklist" disabled={disabled}>
      <legend className="field-label">Vaults on this link</legend>
      {vaults.map((v) => (
        <label key={v.id} className="check obe-check">
          <input
            type="checkbox"
            checked={checked.has(v.id)}
            onChange={(e) => {
              const next = new Set(checked);
              if (e.target.checked) next.add(v.id);
              else next.delete(v.id);
              onChange(next);
            }}
          />
          <span className="obe-dot" style={{ background: v.color }} aria-hidden="true" />
          <span className="obe-check-name">{v.name}</span>
        </label>
      ))}
    </fieldset>
  );
}

const PERMISSIONS: { value: ObPermission; label: string; hint: string }[] = [
  { value: 'read', label: 'Read', hint: 'Visitors can read the notes.' },
  { value: 'write', label: 'Write', hint: 'Visitors can also edit notes and add new ones. Republishing replaces their changes.' },
];

/** Read or Write: what the link's visitors may do. */
export function PermissionChoice({ value, onChange, disabled }: { value: ObPermission; onChange: (next: ObPermission) => void; disabled?: boolean }) {
  const name = useId();
  return (
    <fieldset className="obe-checklist obe-perm" disabled={disabled}>
      <legend className="field-label">Visitors can</legend>
      {PERMISSIONS.map((p) => (
        <label key={p.value} className="check obe-check obe-perm-option">
          <input type="radio" name={name} value={p.value} checked={value === p.value} onChange={() => onChange(p.value)} />
          <span className="obe-perm-text">
            <span className="obe-check-name">{p.label}</span>
            <span className="field-hint">{p.hint}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** Ids in `checked`, in the vault list's order. */
const orderedIds = (vaults: ObVault[], checked: ReadonlySet<string>) => vaults.filter((v) => checked.has(v.id)).map((v) => v.id);

/** Reports a failure: a lost session goes to the sign-in screen, anything else is shown inline. */
function failure(e: unknown, onAuthLost: () => void): string {
  if (e instanceof ObApiError && e.status === 401) onAuthLost();
  return errorText(e);
}

/** "+ New link": a label, the vaults it shows and its permission (Read unless changed). Create stays disabled until a label and a vault are given. */
export function NewLinkDialog({
  open,
  vaults,
  onClose,
  onCreated,
  onAuthLost,
}: {
  open: boolean;
  vaults: ObVault[];
  onClose: () => void;
  onCreated: (link: ObLink) => void;
  onAuthLost: () => void;
}) {
  const [label, setLabel] = useState('');
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [permission, setPermission] = useState<ObPermission>('read');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const labelId = useId();
  const hintId = useId();

  useEffect(() => {
    if (!open) return;
    setLabel('');
    // With a single vault there is nothing to choose.
    setChecked(new Set(vaults.length === 1 ? [vaults[0]!.id] : []));
    setPermission('read');
    setBusy(false);
    setError(null);
  }, [open, vaults]);

  const ready = label.trim().length > 0 && checked.size > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const link = await createLink(label.trim(), orderedIds(vaults, checked), permission);
      onCreated(link);
      onClose();
    } catch (err) {
      setError(failure(err, onAuthLost));
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} title="New link" onClose={() => !busy && onClose()}>
      {vaults.length === 0 ? (
        <div className="stack-8">
          <p className="dialog-text">
            Nothing is published yet. In the notes app, open a vault’s menu and choose “Publish to openboard”, then come back to make a link.
          </p>
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose} autoFocus>
              Close
            </button>
          </div>
        </div>
      ) : (
        <form className="stack-8 obe-form" onSubmit={submit}>
          <label className="field-label" htmlFor={labelId}>
            Label
          </label>
          <input
            id={labelId}
            type="text"
            className="input"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={LABEL_MAX}
            autoComplete="off"
            spellCheck={prefs.spellcheck()}
            autoFocus
            disabled={busy}
            aria-describedby={hintId}
          />
          <p id={hintId} className="field-hint">
            Shown to visitors at the top of the board. Up to {LABEL_MAX} characters.
          </p>
          <VaultChecklist vaults={vaults} checked={checked} onChange={setChecked} disabled={busy} />
          <PermissionChoice value={permission} onChange={setPermission} disabled={busy} />
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={!ready || busy}>
              {busy ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** Changes which published vaults a link shows and what its visitors may do. */
export function EditLinkDialog({
  link,
  vaults,
  onClose,
  onSaved,
  onAuthLost,
}: {
  link: ObLink | null;
  vaults: ObVault[];
  onClose: () => void;
  onSaved: (link: ObLink) => void;
  onAuthLost: () => void;
}) {
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [permission, setPermission] = useState<ObPermission>('read');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!link) return;
    setChecked(new Set(link.vaultIds));
    setPermission(link.permission);
    setBusy(false);
    setError(null);
  }, [link]);

  const ids = orderedIds(vaults, checked);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!link || ids.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      onSaved(await updateLink(link.id, { vaultIds: ids, permission }));
      onClose();
    } catch (err) {
      setError(failure(err, onAuthLost));
      setBusy(false);
    }
  };

  // The title keeps the last link's label while the dialog fades out.
  const last = useRef(link);
  if (link) last.current = link;
  const shown = link ?? last.current;

  return (
    <Dialog open={link !== null} title={shown ? `Edit “${shown.label}”` : 'Edit link'} onClose={() => !busy && onClose()}>
      <form className="stack-8 obe-form" onSubmit={submit}>
        <VaultChecklist vaults={vaults} checked={checked} onChange={setChecked} disabled={busy} />
        {ids.length === 0 && <p className="field-hint">Choose at least one vault. To stop sharing, delete the link instead.</p>}
        <PermissionChoice value={permission} onChange={setPermission} disabled={busy} />
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={ids.length === 0 || busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
