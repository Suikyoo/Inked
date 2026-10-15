import createDOMPurify, { type DOMPurify } from 'dompurify';

export interface PreparedDiagram {
  /** Sanitized SVG. Style attributes, if the frame lifted them, are data-inline-style. */
  svg: string;
  /** Sanitized css text for the constructed stylesheet. */
  css: string;
}

/**
 * Fail-closed screen for css text. Mermaid's own generated css contains none of these (no escapes, no :host or
 * ::slotted, no image-set()/image()/src() fetchers), so rejecting is cheap. A backslash is rejected outright because
 * css escapes (\75rl, @\69mport) defeat any token matching.
 */
export function isSafeCss(css: string): boolean {
  if (css.includes('\\')) return false;
  return !/:host|::slotted|image-set\(|image\(|src\(|expression\(|javascript:/i.test(css);
}

/** True when every url() in the value points at a same-document fragment. */
function onlyFragmentUrls(value: string): boolean {
  for (const m of value.matchAll(/url\(\s*['"]?\s*(.?)/gi)) {
    if (m[1] !== '#') return false;
  }
  return true;
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
    if (!node.attributes) return;
    for (const attr of Array.from(node.attributes)) {
      if (attr.name === 'data-inline-style') {
        if (isSafeCss(attr.value)) node.setAttribute(attr.name, sanitizeCss(attr.value));
        else node.removeAttribute(attr.name);
      } else if (attr.value.includes('\\') || !onlyFragmentUrls(attr.value)) {
        // Browsers decode CSS escapes in presentation attributes, so \75rl( would slip past the url( check.
        node.removeAttribute(attr.name);
      }
    }
  });
  purifier = p;
  return p;
}

/** Drop @import and any url() that is not a same-document fragment. */
export function sanitizeCss(css: string): string {
  return css.replace(/@import(?![\w-])[^;{}\n]*;?/gi, '').replace(/url\(\s*(?!['"]?#)[^)]*\)/gi, 'none');
}

/**
 * The frame is another window, so what it sends is untrusted: sanitize the svg and the css before they touch the
 * page. The frame has already lifted <style> and style="..." out of the svg (the page's CSP reports each one as a
 * violation when parsed); a hostile frame that sends them anyway has them stripped here. Unsafe css refuses the
 * whole diagram.
 */
export function prepareDiagramSvg(svg: string, css: string): PreparedDiagram | null {
  if (!isSafeCss(css)) return null;
  const clean = getPurifier().sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    ADD_TAGS: ['use'],
    FORBID_TAGS: ['style', 'script', 'foreignObject'],
    FORBID_ATTR: ['style'],
  });
  if (!clean.includes('<svg')) return null;
  return { svg: clean, css: sanitizeCss(css) };
}
