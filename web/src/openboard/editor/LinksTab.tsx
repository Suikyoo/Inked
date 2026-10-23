import { useEffect, useMemo, useRef, useState } from 'react';
import type { ObLink, ObVault } from 'inked-core';
import { ConfirmDialog } from '../../components/Dialog';
import { CheckIcon, CopyIcon } from '../../components/Icons';
import { ObApiError, deleteLink, errorText } from '../api';
import { EditLinkDialog, NewLinkDialog } from './NewLinkDialog';

/** The address a link's visitors open. */
export const linkUrl = (token: string) => `${location.origin}/ob/${encodeURIComponent(token)}`;

const views = (n: number) => `${n} ${n === 1 ? 'view' : 'views'}`;

export interface LinksTabProps {
  links: ObLink[];
  vaults: ObVault[];
  onLinksChange: (links: ObLink[]) => void;
  onAuthLost: () => void;
}

/** Every secret link: its address, label, vaults, permission and views, with Copy / Edit / Delete. */
export function LinksTab({ links, vaults, onLinksChange, onAuthLost }: LinksTabProps) {
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ObLink | null>(null);
  const [deleting, setDeleting] = useState<ObLink | null>(null);
  // The confirm dialog keeps its text while it fades out.
  const lastDeleting = useRef<ObLink | null>(null);
  if (deleting) lastDeleting.current = deleting;
  const shownDeleting = deleting ?? lastDeleting.current;

  return (
    <div className="obe-page">
      <div className="obe-head">
        <div className="obe-head-text">
          <h1 className="obe-title">Links</h1>
          <p className="obe-lead">Anyone with a link can read the vaults on it. A Write link also lets them edit and add notes there. Delete a link to stop sharing it.</p>
        </div>
        <button type="button" className="btn btn-primary btn-sm" onClick={() => setCreating(true)}>
          + New link
        </button>
      </div>

      {links.length === 0 ? (
        <div className="obe-empty">
          <p>No links yet. Make one to share published vaults with people who don’t use Inked.</p>
        </div>
      ) : (
        <ul className="obe-links">
          {links.map((l) => (
            <LinkRow key={l.id} link={l} vaults={vaults} onEdit={() => setEditing(l)} onDelete={() => setDeleting(l)} />
          ))}
        </ul>
      )}

      <NewLinkDialog open={creating} vaults={vaults} onClose={() => setCreating(false)} onCreated={(link) => onLinksChange([...links, link])} onAuthLost={onAuthLost} />
      <EditLinkDialog
        link={editing}
        vaults={vaults}
        onClose={() => setEditing(null)}
        onSaved={(link) => onLinksChange(links.map((l) => (l.id === link.id ? link : l)))}
        onAuthLost={onAuthLost}
      />
      <ConfirmDialog
        open={deleting !== null}
        title="Delete link?"
        message={
          <p>
            “{shownDeleting?.label}” stops working for everyone who has it. Your published notes stay published. This can’t be undone.
          </p>
        }
        confirmLabel="Delete"
        onClose={() => setDeleting(null)}
        onConfirm={async () => {
          const link = deleting;
          if (!link) return;
          try {
            await deleteLink(link.id);
          } catch (e) {
            if (e instanceof ObApiError && e.status === 401) onAuthLost();
            throw new Error(errorText(e));
          }
          onLinksChange(links.filter((l) => l.id !== link.id));
        }}
      />
    </div>
  );
}

type CopyState = 'idle' | 'copied' | 'manual';

function LinkRow({ link, vaults, onEdit, onDelete }: { link: ObLink; vaults: ObVault[]; onEdit: () => void; onDelete: () => void }) {
  const url = linkUrl(link.token);
  const byId = useMemo(() => new Map(vaults.map((v) => [v.id, v])), [vaults]);
  const chips = link.vaultIds.map((id) => byId.get(id)).filter((v): v is ObVault => !!v);
  const [copy, setCopy] = useState<CopyState>('idle');
  const input = useRef<HTMLInputElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const show = (s: CopyState) => {
    setCopy(s);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopy('idle'), s === 'copied' ? 1600 : 4000);
  };
  const onCopy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('no clipboard');
      await navigator.clipboard.writeText(url);
      show('copied');
    } catch {
      // No clipboard access (insecure origin, permission): select the address so it can be copied by hand.
      input.current?.focus();
      input.current?.select();
      show('manual');
    }
  };

  const status = copy === 'copied' ? 'Copied' : copy === 'manual' ? 'Press Ctrl+C (⌘C) to copy' : '';

  return (
    <li className="obe-link">
      <div className="obe-link-main">
        <p className="obe-link-label">{link.label}</p>
        <input ref={input} className="obe-url" readOnly value={url} aria-label={`Address of “${link.label}”`} onFocus={(e) => e.currentTarget.select()} spellCheck={false} />
        <div className="obe-meta">
          {chips.length > 0 ? (
            <ul className="obe-chips" aria-label="Vaults">
              {chips.map((v) => (
                <li key={v.id} className="obe-chip">
                  <span className="obe-dot" style={{ background: v.color }} aria-hidden="true" />
                  {v.name}
                </li>
              ))}
            </ul>
          ) : (
            <span className="obe-chips is-none">No vaults</span>
          )}
          <span className={`obe-perm-badge${link.permission === 'write' ? ' is-write' : ''}`}>{link.permission === 'write' ? 'Can edit' : 'Read only'}</span>
          <span className="obe-views">{views(link.views)}</span>
        </div>
      </div>
      <div className="obe-actions">
        <button type="button" className="btn btn-sm" onClick={() => void onCopy()}>
          {copy === 'copied' ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
          {copy === 'copied' ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="btn btn-sm" onClick={onEdit}>
          Edit
        </button>
        <button type="button" className="btn btn-sm btn-danger-quiet" onClick={onDelete}>
          Delete
        </button>
        <span className="obe-copy-status" role="status" aria-live="polite">
          {copy === 'manual' ? status : copy === 'copied' ? <span className="sr-only">{status}</span> : null}
        </span>
      </div>
    </li>
  );
}
