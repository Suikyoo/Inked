import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { imageToken } from 'inked-core';
import { describeError } from '../lib/util';
import { ImageRejectedError } from '../state/imageStore';
import type { AppStore } from '../state/store';
import type { EditorHandle } from '../editor/CodeEditor';

const isImage = (f: File) => f.type.startsWith('image/');

/** Image files on the clipboard. None when the clipboard also has text (a spreadsheet copy): that text pastes as usual. */
export function imageFilesToPaste(dt: DataTransfer | null): File[] {
  if (!dt || dt.getData('text/plain') !== '') return [];
  return Array.from(dt.files).filter(isImage);
}

export function imageFilesToDrop(dt: DataTransfer | null): File[] {
  return dt ? Array.from(dt.files).filter(isImage) : [];
}

/** `text` in place of [start, end), both clamped to the current body; `caret` is just after it. */
export function insertAt(body: string, start: number, end: number, text: string): { body: string; caret: number } {
  const s = Math.min(Math.max(start, 0), body.length);
  const e = Math.min(Math.max(end, s), body.length);
  return { body: body.slice(0, s) + text + body.slice(e), caret: s + text.length };
}

export interface ImageInsertOptions {
  store: AppStore;
  vaultId: string;
  handle: RefObject<EditorHandle | null>;
  /** The note body as last rendered. */
  body: string;
  setBody: (body: string) => void;
  /** True while the vault is locking: no new work starts. */
  disabled: boolean;
}

/** Where an insert goes: the editor's selection, or the end of the body when there is no editor yet. */
export function caretOf(handle: EditorHandle | null, body: string): { start: number; end: number } {
  const at = handle?.selection();
  return at ?? { start: body.length, end: body.length };
}

/** Paste and drop of image files into the note editor: token first, upload in the background. */
export function useImageInsert(o: ImageInsertOptions) {
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef(o.body);
  bodyRef.current = o.body;
  const opts = useRef(o);
  opts.current = o;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const insert = useCallback(async (files: File[], at: { start: number; end: number }) => {
    const { store, vaultId, handle, setBody } = opts.current;
    setError(null);
    let { start, end } = at;
    for (const file of files) {
      try {
        const image = await store.prepareImage(vaultId, file);
        if (!mounted.current) return;
        const token = imageToken(image.id);
        const next = insertAt(bodyRef.current, start, end, token);
        bodyRef.current = next.body;
        setBody(next.body);
        start = end = next.caret;
        window.requestAnimationFrame(() => handle.current?.setSelection(next.caret, next.caret));
        void store.uploadImage(vaultId, image).catch((e) => {
          if (!mounted.current) return;
          if (bodyRef.current.includes(token)) {
            const cleaned = bodyRef.current.replace(token, '');
            bodyRef.current = cleaned;
            setBody(cleaned);
          }
          setError(`Could not upload the image. ${describeError(e)}`);
        });
      } catch (e) {
        if (!mounted.current) return;
        setError(e instanceof ImageRejectedError ? e.message : describeError(e));
      }
    }
  }, []);

  const caret = () => caretOf(opts.current.handle.current, bodyRef.current);

  const onPaste = (e: ClipboardEvent) => {
    if (opts.current.disabled) return;
    const files = imageFilesToPaste(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    void insert(files, caret());
  };
  const onDrop = (e: DragEvent) => {
    if (opts.current.disabled) return;
    const files = imageFilesToDrop(e.dataTransfer);
    if (!files.length) return;
    e.preventDefault();
    void insert(files, caret());
  };
  const onDragOver = (e: DragEvent) => {
    if (Array.from(e.dataTransfer?.types ?? []).includes('Files')) e.preventDefault();
  };
  return { error, onPaste, onDrop, onDragOver };
}
