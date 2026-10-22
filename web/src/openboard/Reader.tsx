import { useEffect, useMemo, useRef, type MouseEvent } from 'react';
import { INDEX_TITLE, indexNoteOf } from 'inked-core/indexNote';
import type { ObNote, ObPayload } from 'inked-core';
import { useDiagrams } from '../diagrams/useDiagrams';
import { renderMarkdown } from '../markdown/render';

/**
 * Reads one published note: its title, where it lives, and its body rendered through the app's Markdown and
 * DOMPurify pipeline.
 *
 * - `note`: the note to show; its `vaultId` scopes `[[links]]` and images.
 * - `payload`: every published vault, folder and note this reader may link to.
 * - `resolveImage(vaultId, imageId)`: the URL an `inked://<id>` image loads from (the visitor page passes
 *   `publicImageUrl(token, …)`; the editor passes its own resolver).
 * - `onOpenNote(vaultId, noteId)`: a `[[Title]]` link to a note in `payload` is a button that calls this.
 *   A link to any other title is plain text.
 *
 * Mermaid blocks draw through the sandboxed diagram frame, as in the notes app.
 */
export interface ReaderProps {
  note: ObNote;
  payload: ObPayload;
  resolveImage: (vaultId: string, imageId: string) => string;
  onOpenNote: (vaultId: string, noteId: string) => void;
}

/** A path only our own resolver emits, so DOMPurify keeps the wiki-link marker on it. */
const WL_PREFIX = '/__ob-note/';

function unavailable(alt: string): HTMLElement {
  const box = document.createElement('span');
  box.className = 'img-unavailable';
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', alt ? `Image unavailable: ${alt}` : 'Image unavailable');
  box.textContent = 'Image unavailable';
  return box;
}

/** Lower-cased title -> note id within one vault (most recently edited wins on duplicates), as in the app. */
function titlesOf(payload: ObPayload, vaultId: string): Map<string, string> {
  const map = new Map<string, string>();
  const notes = payload.notes.filter((n) => n.vaultId === vaultId).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const n of notes) map.set(n.title.trim().toLowerCase(), n.id);
  return map;
}

/** Sanitized HTML for a body, with wiki links as open buttons, missing links as text and images resolved. */
export function renderPublished(note: ObNote, payload: ObPayload, resolveImage: ReaderProps['resolveImage']): string {
  const titles = titlesOf(payload, note.vaultId);
  const ids = new Set(titles.values());
  const safe = renderMarkdown(note.body, {
    resolveWikiLink: (t) => {
      const id = titles.get(t.trim().toLowerCase());
      return id ? WL_PREFIX + encodeURIComponent(id) : null;
    },
  });
  const doc = new DOMParser().parseFromString(`<body>${safe}</body>`, 'text/html');
  for (const a of Array.from(doc.body.querySelectorAll('a[data-wikilink]'))) {
    const href = a.getAttribute('href') ?? '';
    const id = href.startsWith(WL_PREFIX) ? decodeURIComponent(href.slice(WL_PREFIX.length)) : '';
    if (!ids.has(id)) {
      a.replaceWith(doc.createTextNode(a.textContent ?? ''));
      continue;
    }
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'wl';
    btn.dataset.obNote = id;
    btn.textContent = a.textContent ?? '';
    a.replaceWith(btn);
  }
  for (const span of Array.from(doc.body.querySelectorAll('span.wl-missing'))) span.replaceWith(doc.createTextNode(span.textContent ?? ''));
  for (const img of Array.from(doc.body.querySelectorAll<HTMLImageElement>('img[data-inked-image]'))) {
    img.setAttribute('src', resolveImage(note.vaultId, img.dataset.inkedImage!));
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
  }
  return doc.body.innerHTML;
}

/** Vault › folder path of a note, root first. */
function crumbsOf(note: ObNote, payload: ObPayload): string[] {
  const vault = payload.vaults.find((v) => v.id === note.vaultId);
  const folders = new Map(payload.folders.filter((f) => f.vaultId === note.vaultId).map((f) => [f.id, f]));
  const path: string[] = [];
  const seen = new Set<string>();
  for (let id = note.folderId; id && !seen.has(id); id = folders.get(id)?.parentId ?? null) {
    seen.add(id);
    const f = folders.get(id);
    if (!f) break;
    path.unshift(f.name);
  }
  return vault ? [vault.name, ...path] : path;
}

export function Reader({ note, payload, resolveImage, onOpenNote }: ReaderProps) {
  const ref = useRef<HTMLElement>(null);
  const html = useMemo(() => renderPublished(note, payload, resolveImage), [note, payload, resolveImage]);
  const crumbs = useMemo(() => crumbsOf(note, payload), [note, payload]);
  // A folder's Index reads as the folder itself.
  const isIndex = useMemo(() => {
    if (note.title !== INDEX_TITLE) return false;
    const notes = Object.fromEntries(payload.notes.filter((n) => n.vaultId === note.vaultId).map((n) => [n.id, n]));
    return indexNoteOf({ notes }, note.folderId)?.id === note.id;
  }, [note, payload]);
  const title = isIndex ? (crumbs[crumbs.length - 1] ?? note.title) : note.title;
  const path = isIndex ? crumbs.slice(0, -1) : crumbs;

  useDiagrams(ref, html);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('img[data-inked-image]'))) {
      img.onerror = () => {
        if (img.isConnected) img.replaceWith(unavailable(img.alt));
      };
    }
  }, [html]);

  const onClick = (e: MouseEvent<HTMLElement>) => {
    const btn = e.target instanceof Element ? e.target.closest<HTMLElement>('button[data-ob-note]') : null;
    if (!btn) return;
    e.preventDefault();
    onOpenNote(note.vaultId, btn.dataset.obNote!);
  };

  return (
    <div className="ob-reader">
      <header className="ob-reader-head">
        {path.length > 0 && (
          <p className="ob-crumbs">
            {path.map((c, i) => (
              <span key={i} className={i === 0 ? 'ob-crumb is-vault' : 'ob-crumb'}>
                {c}
              </span>
            ))}
          </p>
        )}
        <h1 className="ob-reader-title">{title}</h1>
      </header>
      {note.body.trim() === '' ? (
        <p className="ob-reader-empty">This note is empty.</p>
      ) : (
        // Sanitised by DOMPurify in renderMarkdown; the only nodes added afterwards are built with DOM APIs.
        <article ref={ref} key={note.id} className="md ob-md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>
  );
}
