import createDOMPurify, { type DOMPurify } from 'dompurify';

export interface PreparedDiagram {
  /** Sanitized SVG. Style attributes, if the frame lifted them, are data-inline-style. */
  svg: string;
  /** Sanitized css text for the constructed stylesheet. */
  css: string;
}

let purifier: DOMPurify | null = null;

function getPurifier(): DOMPurify {
  if (purifier) return purifier;
  const p = createDOMPurify(window);
  p.addHook('afterSanitizeAttributes', (node) => {
    for (const name of ['href', 'xlink:href']) {
      const value = node.getAttribute?.(name);
      // Only a same-document fragment may remain (markers, gradients, <use>).
      if (value != null && !value.trim().startsWith('#')) node.removeAttribute(name);
    }
  });
  purifier = p;
  return p;
}

/** Drop @import and any url() that is not a same-document fragment. */
export function sanitizeCss(css: string): string {
  return css.replace(/@import[^;]*;?/gi, '').replace(/url\(\s*(?!['"]?#)[^)]*\)/gi, 'none');
}

/**
 * The frame is another window, so what it sends is untrusted: sanitize the svg and the css before they touch the
 * page. The frame has already lifted <style> and style="..." out of the svg (the page's CSP reports each one as a
 * violation when parsed); a hostile frame that sends them anyway has them stripped here.
 */
export function prepareDiagramSvg(svg: string, css: string): PreparedDiagram | null {
  const clean = getPurifier().sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['use'],
    FORBID_TAGS: ['style', 'script', 'foreignObject'],
    FORBID_ATTR: ['style'],
  });
  if (!clean.includes('<svg')) return null;
  return { svg: clean, css: sanitizeCss(css) };
}
