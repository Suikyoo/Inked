/**
 * Runs in the frame, whose CSP allows inline styles. Takes Mermaid's SVG string apart so the page never has to
 * parse inline-styled markup: the page's CSP reports a violation for every <style> element and style="..."
 * attribute in any document it parses, even a detached one. The svg that comes back has no <style> and no style
 * attribute (each attribute is kept as data-inline-style for the page to apply through CSSOM); the css is the
 * text of the removed <style> blocks.
 */
export function liftStyles(raw: string): { svg: string; css: string } | null {
  const doc = new DOMParser().parseFromString(`<body>${raw}</body>`, 'text/html');
  const svg = doc.body.querySelector('svg');
  if (!svg) return null;
  let css = '';
  for (const style of Array.from(svg.querySelectorAll('style'))) {
    css += `${style.textContent ?? ''}\n`;
    style.remove();
  }
  for (const el of [svg, ...Array.from(svg.querySelectorAll('[style]'))]) {
    const value = el.getAttribute('style');
    if (value === null) continue;
    el.removeAttribute('style');
    el.setAttribute('data-inline-style', value);
  }
  return { svg: svg.outerHTML, css };
}
