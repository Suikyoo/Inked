/** Applied inside the shadow root: the page's own css does not cross the shadow boundary. */
export const DIAGRAM_BASE_CSS = 'svg { display: block; margin: 0 auto; height: auto; }';

/**
 * Put a diagram's svg in a shadow root on `host` and give that root the diagram's css as a constructed stylesheet
 * (which the strict CSP allows; an inline <style> it does not). The css can only style what is inside the root, so
 * hostile note content cannot restyle the rest of the app. The sheet goes with the host; there is nothing to release.
 * `host` must be a valid shadow host such as a div (a figure is not one, and attachShadow throws on it).
 */
export function mountDiagramShadow(host: HTMLElement, svg: SVGElement, css: string): void {
  const root = host.attachShadow({ mode: 'open' });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`${css}\n${DIAGRAM_BASE_CSS}`);
  root.adoptedStyleSheets = [sheet];
  root.append(svg);
}
