import { useEffect, type RefObject } from 'react';
import { useStore } from '../state/StoreContext';

function unavailable(alt: string): HTMLElement {
  const box = document.createElement('span');
  box.className = 'img-unavailable';
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', alt ? `Image unavailable: ${alt}` : 'Image unavailable');
  box.textContent = 'Image unavailable';
  return box;
}

/**
 * Fills the `img[data-inked-image]` placeholders in `ref` after each render: a cached image at once,
 * otherwise fetched and decrypted; a failure becomes an inline "Image unavailable" box.
 * `html` is a dependency because React rebuilds the placeholders whenever it changes.
 */
export function useInkedImages(ref: RefObject<HTMLElement | null>, vaultId: string, html: string): void {
  const store = useStore();
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let live = true;
    for (const img of Array.from(root.querySelectorAll<HTMLImageElement>('img[data-inked-image]'))) {
      const id = img.dataset.inkedImage!;
      const cached = store.images.peek(vaultId, id);
      // A blob that decrypts but does not decode would show the browser's broken icon.
      img.onerror = () => {
        if (img.isConnected) img.replaceWith(unavailable(img.alt));
      };
      if (cached) {
        img.src = cached;
        continue;
      }
      void store.images.get(vaultId, id).then((r) => {
        if (!live || !img.isConnected) return;
        if (r.ok) img.src = r.url;
        else img.replaceWith(unavailable(img.alt));
      });
    }
    return () => {
      live = false;
    };
  }, [ref, store, vaultId, html]);
}
