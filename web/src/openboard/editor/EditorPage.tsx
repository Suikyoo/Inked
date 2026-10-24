import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { ObLink, ObPayload } from 'inked-core';
import { ObApiError, checkSession, errorText, listContent, listLinks } from '../api';
import { ContentTab } from './ContentTab';
import { LinksTab } from './LinksTab';
import { SettingsTab } from './SettingsTab';

type Phase = { kind: 'loading' } | { kind: 'signedOut' } | { kind: 'failed'; message: string } | { kind: 'ready' };
type Tab = 'links' | 'content' | 'settings';

const TABS: { id: Tab; label: string }[] = [
  { id: 'links', label: 'Links' },
  { id: 'content', label: 'Published content' },
  { id: 'settings', label: 'Settings' },
];

/**
 * The openboard editor at `/openboard`: the owner's secret links and published content, with a preview of
 * what each link shows. It holds no vault keys and never publishes (that happens in the notes app).
 */
export function EditorPage() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [links, setLinks] = useState<ObLink[]>([]);
  const [content, setContent] = useState<ObPayload>({ vaults: [], folders: [], notes: [] });
  const [tab, setTab] = useState<Tab>('links');
  const [error, setError] = useState<string | null>(null);
  const tabRefs = useRef(new Map<Tab, HTMLButtonElement>());

  const onAuthLost = useCallback(() => setPhase({ kind: 'signedOut' }), []);

  const load = useCallback(async () => {
    setPhase({ kind: 'loading' });
    try {
      if (!(await checkSession())) return setPhase({ kind: 'signedOut' });
      const [l, c] = await Promise.all([listLinks(), listContent()]);
      setLinks(l);
      setContent(c);
      setPhase({ kind: 'ready' });
    } catch (e) {
      setPhase(e instanceof ObApiError && e.status === 401 ? { kind: 'signedOut' } : { kind: 'failed', message: errorText(e) });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    document.title = 'Openboard · Inked';
  }, []);

  /** After an unpublish: links lose vaults with it, so both are read again. */
  const refresh = useCallback(async () => {
    setError(null);
    try {
      const [l, c] = await Promise.all([listLinks(), listContent()]);
      setLinks(l);
      setContent(c);
    } catch (e) {
      if (e instanceof ObApiError && e.status === 401) onAuthLost();
      else setError(`Couldn’t refresh the list. ${errorText(e)}`);
    }
  }, [onAuthLost]);

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft' && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault();
    const i = TABS.findIndex((t) => t.id === tab);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    const id = TABS[next]!.id;
    setTab(id);
    tabRefs.current.get(id)?.focus();
  };

  if (phase.kind === 'signedOut')
    return (
      <main className="ob-gone">
        <p className="wordmark">Inked</p>
        <p className="ob-gone-text">Sign in to manage your openboard links and published notes.</p>
        <p>
          <a className="btn btn-primary" href="/login">
            Sign in to Inked
          </a>
        </p>
      </main>
    );
  if (phase.kind === 'loading')
    return (
      <main className="ob-gone" aria-busy="true">
        <p className="ob-gone-text">Loading…</p>
      </main>
    );
  if (phase.kind === 'failed')
    return (
      <main className="ob-gone">
        <p className="wordmark">Inked</p>
        <p className="ob-gone-text" role="alert">
          {phase.message}
        </p>
        <p>
          <button type="button" className="btn btn-primary" onClick={() => void load()}>
            Try again
          </button>
        </p>
      </main>
    );

  return (
    <div className="ob obe">
      <header className="ob-top obe-top">
        <div className="ob-top-side">
          <a className="obe-brand" href="/" title="Back to your notes">
            <span className="wordmark">Inked</span>
            <span className="obe-brand-sub">Openboard</span>
          </a>
        </div>
        <div className="obe-tabs" role="tablist" aria-label="Openboard" onKeyDown={onTabKey}>
          {TABS.map((t) => (
            <button
              key={t.id}
              ref={(el) => {
                if (el) tabRefs.current.set(t.id, el);
                else tabRefs.current.delete(t.id);
              }}
              type="button"
              role="tab"
              id={`obe-tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`obe-panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className="obe-tab"
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="ob-top-side is-end">
          <a className="btn btn-sm" href="/">
            Back to notes
          </a>
        </div>
      </header>
      {error && (
        <p className="form-error obe-error obe-banner" role="alert">
          {error}
        </p>
      )}
      <div className="obe-panel" role="tabpanel" id={`obe-panel-${tab}`} aria-labelledby={`obe-tab-${tab}`}>
        {tab === 'links' && <LinksTab links={links} vaults={content.vaults} onLinksChange={setLinks} onAuthLost={onAuthLost} />}
        {tab === 'content' && <ContentTab content={content} links={links} onChanged={refresh} onAuthLost={onAuthLost} />}
        {tab === 'settings' && <SettingsTab content={content} onChanged={refresh} onAuthLost={onAuthLost} />}
      </div>
    </div>
  );
}
