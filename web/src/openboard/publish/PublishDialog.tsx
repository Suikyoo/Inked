import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { ObFolder, ObPayload, PublishConflict } from 'inked-core';
import { ConfirmDialog, Dialog } from '../../components/Dialog';
import { FolderIcon } from '../../components/Icons';
import { prefs } from '../../lib/prefs';
import { ObApiError, errorText, listContent } from '../api';
import { collectUnit, targetName, type CollectStore, type PublishTarget, type PublishUnit } from './collect';
import { AccountChangedError, publishUnit, uploadImages } from './publishApi';

/** Where the unit lands: an openboard vault (by name) and the folder names below its root. */
interface Dest {
  vaultName: string;
  destPath: string[];
}

type Step =
  | { kind: 'notice' }
  | { kind: 'pick' }
  | { kind: 'conflict'; conflict: PublishConflict; dest: Dest }
  | { kind: 'done'; failedImages: number; skipped: number };

type Outcome = { kind: 'conflict'; conflict: PublishConflict } | { kind: 'done'; failedImages: number; skipped: number };

const NEW = 'new';
const plural = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;

function failureText(e: unknown): string {
  if (e instanceof AccountChangedError) return e.message;
  if (e instanceof ObApiError) {
    if (e.status === 413) return 'That’s too large to publish in one go. Publish a smaller folder.';
    return errorText(e);
  }
  if (e instanceof Error && e.message) return e.message;
  return 'That didn’t work. Try again.';
}

/** One destination row: a published vault's root or one of its folders. */
interface Row {
  value: string;
  label: string;
  depth: number;
  color?: string;
  dest: Dest;
}

function destinationRows(content: ObPayload): Row[] {
  const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  const rows: Row[] = [];
  for (const v of [...content.vaults].sort(byName)) {
    rows.push({
      value: `${v.id}/`,
      label: v.name,
      depth: 0,
      color: v.color,
      dest: { vaultName: v.name, destPath: [] },
    });
    const kids = new Map<string | null, ObFolder[]>();
    for (const f of content.folders) if (f.vaultId === v.id) kids.set(f.parentId, [...(kids.get(f.parentId) ?? []), f]);
    const seen = new Set<string>();
    const walk = (parent: string | null, path: string[], depth: number) => {
      for (const f of (kids.get(parent) ?? []).sort(byName)) {
        if (seen.has(f.id)) continue;
        seen.add(f.id);
        const p = [...path, f.name];
        rows.push({
          value: `${v.id}/${f.id}`,
          label: f.name,
          depth,
          dest: { vaultName: v.name, destPath: p },
        });
        walk(f.id, p, depth + 1);
      }
    };
    walk(null, [], 1);
  }
  return rows;
}

/**
 * "Publish to openboard": a notice, then (for a folder or note) the destination picker, then the publish
 * with an overwrite confirm on conflict, then the image uploads. The browser decrypts; the server stores
 * plaintext. Mounted while open; `onClose` unmounts it.
 */
export function PublishDialog({
  store,
  vaultId,
  target,
  onClose,
}: {
  store: CollectStore;
  vaultId: string;
  target: PublishTarget;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: 'notice' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [content, setContent] = useState<ObPayload | null>(null);
  const [contentError, setContentError] = useState<string | null>(null);
  const [choice, setChoice] = useState(NEW);
  const [newName, setNewName] = useState('');
  // Named from the first frame so the title does not change after Continue.
  const [name, setName] = useState<string | null>(() => targetName(store, vaultId, target));
  const live = useRef(true);
  const unitRef = useRef<Promise<PublishUnit> | null>(null);
  const finished = useRef(false);
  const groupId = useId();
  const newNameId = useId();

  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);

  const rows = useMemo(() => (content ? destinationRows(content) : []), [content]);

  /** Decrypts the subtree once; a failure is retried on the next attempt. */
  const unit = () => {
    if (!unitRef.current) {
      unitRef.current = collectUnit(store, vaultId, target);
      unitRef.current.catch(() => {
        unitRef.current = null;
      });
    }
    return unitRef.current;
  };

  const attempt = async (dest: Dest, overwrite: boolean): Promise<Outcome> => {
    const u = await unit();
    const out = await publishUnit(u, dest.destPath, dest.vaultName, overwrite);
    if (out.status === 'conflict') return { kind: 'conflict', conflict: out.conflict };
    const failedImages = await uploadImages(out.result, u.images);
    return { kind: 'done', failedImages, skipped: u.skipped };
  };

  const publish = async (dest: Dest) => {
    setBusy(true);
    setError(null);
    try {
      const out = await attempt(dest, false);
      if (!live.current) return;
      setStep(out.kind === 'conflict' ? { kind: 'conflict', conflict: out.conflict, dest } : out);
    } catch (e) {
      if (live.current) setError(failureText(e));
    } finally {
      if (live.current) setBusy(false);
    }
  };

  const loadContent = () => {
    setContentError(null);
    listContent().then(
      (c) => {
        if (!live.current) return;
        setContent(c);
        if (c.vaults.length === 0) setChoice(NEW);
      },
      (e: unknown) => live.current && setContentError(errorText(e)),
    );
  };

  const onContinue = () => {
    setName(targetName(store, vaultId, target));
    if (target.kind === 'vault') {
      void publish({
        vaultName: targetName(store, vaultId, { kind: 'vault' }) ?? 'Untitled',
        destPath: [],
      });
      return;
    }
    setNewName(targetName(store, vaultId, { kind: 'vault' }) ?? '');
    setStep({ kind: 'pick' });
    // Decrypt while the owner picks.
    unit().catch(() => undefined);
    loadContent();
  };

  const onPublishPicked = () => {
    if (choice === NEW) {
      const n = newName.trim();
      if (!n) {
        setError('Enter a name for the new vault.');
        return;
      }
      void publish({ vaultName: n, destPath: [] });
      return;
    }
    const row = rows.find((r) => r.value === choice);
    if (row) void publish(row.dest);
  };

  if (step.kind === 'conflict') {
    const { conflict, dest } = step;
    const parts = [plural(conflict.removes.notes, 'note')];
    if (conflict.removes.folders > 0) parts.push(plural(conflict.removes.folders, 'folder'));
    return (
      <ConfirmDialog
        open
        title={`Replace “${conflict.target.name}” on openboard?`}
        message={<p>This replaces {parts.join(' and ')} there. Your notes in Inked don’t change.</p>}
        confirmLabel="Overwrite"
        onClose={() => {
          if (!finished.current) onClose();
        }}
        onConfirm={async () => {
          let out: Outcome;
          try {
            out = await attempt(dest, true);
          } catch (e) {
            throw new Error(failureText(e));
          }
          if (out.kind === 'conflict') throw new Error('That didn’t work. Try again.');
          finished.current = true;
          if (live.current) setStep(out);
        }}
      />
    );
  }

  const title = name ? `Publish “${name}” to openboard` : 'Publish to openboard';

  return (
    <Dialog open title={title} onClose={() => !busy && onClose()}>
      {step.kind === 'notice' && (
        <>
          <div className="dialog-text">
            <p>Published content is stored readable by the server and anyone with a link.</p>
          </div>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={onContinue} disabled={busy} autoFocus>
              {busy ? 'Publishing…' : 'Continue'}
            </button>
          </div>
        </>
      )}

      {step.kind === 'pick' && (
        <>
          <div className="stack-8">
            <p className="field-label" id={groupId}>
              Where on openboard
            </p>
            <div className="pub-picker" role="radiogroup" aria-labelledby={groupId}>
              {!content && !contentError && <p className="pub-empty">Loading openboard…</p>}
              {rows.map((r) => (
                <label key={r.value} className="pub-opt" style={{ '--depth': r.depth } as CSSProperties}>
                  <input
                    type="radio"
                    name={groupId}
                    value={r.value}
                    checked={choice === r.value}
                    onChange={() => setChoice(r.value)}
                    disabled={busy}
                  />
                  {r.color ? (
                    <span className="pub-dot" style={{ background: r.color }} aria-hidden="true" />
                  ) : (
                    <FolderIcon size={12} className="pub-icon" />
                  )}
                  <span className="pub-name">{r.label}</span>
                </label>
              ))}
              <label className="pub-opt pub-new">
                <input type="radio" name={groupId} value={NEW} checked={choice === NEW} onChange={() => setChoice(NEW)} disabled={busy} />
                <span className="pub-name">+ New vault on openboard</span>
              </label>
              {choice === NEW && (
                <div className="pub-new-name">
                  <label className="sr-only" htmlFor={newNameId}>
                    New vault name
                  </label>
                  <input
                    id={newNameId}
                    type="text"
                    className="input input-sm"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    maxLength={200}
                    autoComplete="off"
                    spellCheck={prefs.spellcheck()}
                    disabled={busy}
                  />
                </div>
              )}
            </div>
          </div>
          {contentError && (
            <p className="form-error" role="alert">
              Couldn’t load what’s on openboard. {contentError}{' '}
              <button type="button" className="linkish" onClick={loadContent}>
                Try again
              </button>
            </p>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" onClick={onPublishPicked} disabled={busy}>
              {busy ? 'Publishing…' : 'Publish'}
            </button>
          </div>
        </>
      )}

      {step.kind === 'done' && (
        <>
          <div className="dialog-text" role="status">
            <p>{step.failedImages > 0 ? `Published, but ${plural(step.failedImages, 'image')} couldn’t be uploaded.` : 'Published.'}</p>
            {step.skipped > 0 && (
              <p>
                {plural(step.skipped, 'note')} couldn’t be read and {step.skipped === 1 ? 'was' : 'were'} left out.
              </p>
            )}
            <p>
              <a href="/openboard" target="_blank" rel="noopener">
                Open the openboard editor
              </a>{' '}
              to share it with a link.
            </p>
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn btn-primary" onClick={onClose} autoFocus>
              Close
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
