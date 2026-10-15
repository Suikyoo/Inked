# Mermaid diagrams in notes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A ```` ```mermaid ```` fence in a note is drawn as a themed SVG diagram in view mode, in the browser, with no change to the server or the CSP.

**Architecture:** `markdown-it` is untouched, so a mermaid fence stays a readable `pre > code.language-mermaid` block. A view hook (`useDiagrams`, mirroring `useInkedImages`) finds those blocks after render, lazy-loads Mermaid, renders to an SVG string, sanitizes it with DOMPurify, lifts Mermaid's `<style>` text into a constructed stylesheet and its `style=""` attributes into CSSOM writes (both CSP-safe), and swaps the block for a `<figure>`. Any failure leaves the code block and adds a one-line note.

**Tech Stack:** TypeScript, React 18, `mermaid` 11 (self-hosted lazy chunk), DOMPurify, vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-10-15-mermaid-diagrams-design.md`

## Global Constraints

Copied from the spec. Every task's requirements include these.

- Mermaid runs in the browser only, on view, from the decrypted note text. The server and the MCP are not changed.
- Mermaid is self-hosted as a lazy chunk (`import('mermaid')`). No CDN. `script-src`, `connect-src` and `style-src` stay exactly as in `server/src/app.ts` (`style-src 'self'`: no inline `<style>`, no `style="..."` attribute strings; CSSOM writes are fine).
- `markdown-it` gets no mermaid rule. The fence renders as an ordinary `pre > code.language-mermaid`. `renderUntrustedMarkdown` output (Ask answers) is never hydrated.
- Mermaid config: `startOnLoad: false`, `securityLevel: 'strict'`, `theme: 'base'`, `themeVariables` read from the CSS variables when Mermaid first loads, `maxTextSize` 20 000, `maxEdges` 200, HTML labels off (`htmlLabels: false` and `flowchart.htmlLabels: false`). `secure` adds `theme`, `themeCSS`, `themeVariables` and `fontFamily` to Mermaid's defaults, so a note's `%%{init}%%` directive cannot override them.
- SVG sanitizer: removes `script`, `foreignObject`, event attributes and any `href` / `xlink:href` that is not a same-document fragment (`#...`). The note sanitizer `sanitizeHtml` is unchanged.
- Failure modes keep the code block and add a one-line note: oversized, syntax error (with Mermaid's first error line), renderer failed to load. A load failure is not cached, so the next view retries.
- Results are cached in memory only (keyed by source), never persisted. A late render must not write into a replaced DOM.
- The wrapper is a `<figure class="diagram" role="img">` with an `aria-label` ("Diagram", or the SVG `<title>` when present). On phones the SVG scales with `max-width: 100%` and a wide diagram scrolls inside the wrapper.
- Out of scope: export to PNG or SVG, zoom and pan, editor live preview, clickable nodes, ASCII auto-detection, a light theme, and the `inked-notes` skill in the sibling plugin repo.
- Commits: conventional commit subject, and end every commit message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Branch: `feat/mermaid-diagrams` (already created; the spec is committed there).

## Review Focus

Failure modes the spec implies that no single feature task would otherwise pin. Each has a test in the task that owns the code.

1. **Two identical diagrams in one note.** They share one cached result, one id and one stylesheet. Releasing one must not strip the other's styles. Task 3 (refcount) and Task 5.
2. **Switching view and edit, or editing the note, while a render is in flight.** The late result must not touch a replaced DOM or leak a stylesheet. Task 5.
3. **A note carrying `%%{init: {"themeCSS": "..."}}%%` or `themeVariables`.** It must not change the look or inject CSS. Task 4 pins the `secure` list; Task 7 checks it in the browser.
4. **An empty or whitespace-only mermaid fence.** Left alone as a code block, no error label. Task 5.
5. **The Mermaid chunk failing to load (offline, deploy mid-session).** Code block plus a note now, and a retry on the next view. Task 4 (not cached) and Task 5 (note shown).

---

## File Structure

| File | Responsibility |
|---|---|
| `web/src/diagrams/svgSanitize.ts` (create) | Pure DOM functions: turn Mermaid's SVG string into `{ svg, css }` that is safe and CSP-clean. |
| `web/src/diagrams/diagramSheets.ts` (create) | Ref-counted constructed stylesheets in `document.adoptedStyleSheets`. |
| `web/src/diagrams/mermaidRender.ts` (create) | Lazy-load and configure Mermaid, theme variables, limits, error mapping, result cache. |
| `web/src/diagrams/useDiagrams.ts` (create) | View hook: find mermaid blocks, render, mount figure, show failure notes. |
| `web/src/pages/NotePane.tsx`, `web/src/pages/NodePreview.tsx` (modify) | Call `useDiagrams` next to `useInkedImages`. |
| `web/src/styles/note.css` (modify) | `.md .diagram` and `.md .diagram-note`. |
| `docs/architecture.md`, `docs/mcp.md` (modify) | Document the feature. |

---

### Task 1: CSP probe (throwaway) and dependency

This is the gate for the whole plan. The probe code is deleted at the end of the task. Only the dependency and the recorded result are committed.

**Files:**
- Modify: `web/package.json`, `package-lock.json` (add `mermaid`)
- Create then delete: `web/vite.probe.config.ts`, `web/probe/index.html`, `web/probe/probe.ts`, `web/dist-probe/`
- Modify: `docs/superpowers/specs/2026-10-15-mermaid-diagrams-design.md` (append the result)

**Interfaces:**
- Produces: the `mermaid` package in `web/package.json`; a recorded pass/fail on three CSP assumptions that every later task relies on.

- [ ] **Step 1: Add the dependency**

Run: `npm install -w web mermaid@^11`
Expected: `mermaid` appears under `dependencies` in `web/package.json`. Note the resolved version (`npm ls -w web mermaid`).

- [ ] **Step 2: Create the probe page**

`web/vite.probe.config.ts`:

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'probe',
  base: './',
  build: { outDir: '../dist-probe', emptyOutDir: true, assetsInlineLimit: 0 },
});
```

`web/probe/index.html`:

```html
<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>mermaid csp probe</title></head>
  <body>
    <div id="cssom-target"></div>
    <pre id="out"></pre>
    <script type="module" src="./probe.ts"></script>
  </body>
</html>
```

`web/probe/probe.ts`:

```ts
import mermaid from 'mermaid';

const violations: { at: number; text: string }[] = [];
document.addEventListener('securitypolicyviolation', (e) => {
  violations.push({ at: performance.now(), text: `${e.violatedDirective}: ${e.blockedURI || e.sample}` });
});

const FLOW = `graph TD
  A[Browser decrypts the note] --> B{Has mermaid fence?}
  B -- yes --> C[Lazy-load the renderer]
  B -- no --> D[Plain Markdown]
  subgraph Server
    E[(Ciphertext only)]
  end
  C --> E
  style A fill:#ff00ff,stroke:#333`;

const SEQ = `sequenceDiagram
  participant W as Web app
  participant S as Server
  W->>S: GET note ciphertext
  S-->>W: ciphertext
  W->>W: decrypt and draw`;

const results: Record<string, unknown> = {};

// 1. Constructed stylesheet and CSSOM style writes, with no Mermaid involved.
{
  const target = document.getElementById('cssom-target')!;
  target.id = 'probe-x';
  const sheet = new CSSStyleSheet();
  sheet.replaceSync('#probe-x { color: rgb(1, 2, 3); }');
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  results.constructedSheet = getComputedStyle(target).color === 'rgb(1, 2, 3)';
  target.style.cssText = 'background-color: rgb(4, 5, 6)';
  results.cssomStyle = getComputedStyle(target).backgroundColor === 'rgb(4, 5, 6)';
}

async function renderOne(name: string, source: string, fontFamily: string, fontSize: string) {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: 'base',
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    themeVariables: {
      darkMode: true,
      fontFamily,
      fontSize,
      background: '#1b1a21',
      primaryColor: '#24222c',
      primaryTextColor: '#e6e3ee',
      primaryBorderColor: '#7452e0',
      lineColor: '#8d7bc4',
    },
  });
  const { svg } = await mermaid.render(`p-${name}`, source);
  const startedAt = performance.now();
  const doc = new DOMParser().parseFromString(`<body>${svg}</body>`, 'text/html');
  const el = doc.body.firstElementChild as SVGElement;
  let css = '';
  for (const s of Array.from(el.querySelectorAll('style'))) {
    css += `${s.textContent}\n`;
    s.remove();
  }
  for (const n of [el, ...Array.from(el.querySelectorAll<SVGElement>('[style]'))]) {
    const v = n.getAttribute('style');
    n.removeAttribute('style');
    if (v) n.setAttribute('data-inline-style', v);
  }
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
  const live = document.importNode(el, true) as SVGElement;
  for (const n of [live, ...Array.from(live.querySelectorAll<SVGElement>('[data-inline-style]'))]) {
    const v = n.getAttribute('data-inline-style');
    if (v) n.style.cssText = v;
    n.removeAttribute('data-inline-style');
  }
  const host = document.createElement('section');
  host.append(live);
  document.body.append(host);
  await new Promise((r) => setTimeout(r, 100));

  const overflow: string[] = [];
  for (const g of Array.from(live.querySelectorAll('g.node'))) {
    const shape = g.querySelector('rect, polygon, path') as SVGGraphicsElement | null;
    const label = g.querySelector('g.label') as SVGGraphicsElement | null;
    if (shape && label && label.getBBox().width > shape.getBBox().width + 1) overflow.push(g.id);
  }
  const plain = live.querySelector('g.node[id^="flowchart-D-"] rect') as Element | null;
  const styled = live.querySelector('g.node[id^="flowchart-A-"] rect') as Element | null;
  results[name] = {
    cssBytes: css.length,
    sheetRules: sheet.cssRules.length,
    themeFillApplied: plain ? getComputedStyle(plain).fill === 'rgb(36, 34, 44)' : null,
    inlineStyleApplied: styled ? getComputedStyle(styled).fill === 'rgb(255, 0, 255)' : null,
    overflow,
    ownViolations: violations.filter((v) => v.at >= startedAt).map((v) => v.text),
  };
}

await renderOne('flow', FLOW, 'system-ui, sans-serif', '14px');
await renderOne('flowBig', FLOW, 'monospace', '22px');
await renderOne('seq', SEQ, 'system-ui, sans-serif', '14px');
results.allViolations = violations.map((v) => v.text);

(window as unknown as { __probe: unknown }).__probe = results;
document.getElementById('out')!.textContent = JSON.stringify(results, null, 2);
```

- [ ] **Step 3: Build the probe and serve it with the real server and CSP**

Run, from the repo root:

```bash
npm run build -w server
(cd web && npx vite build -c vite.probe.config.ts)
```

Then start the server on a scratch data dir (replace `<scratch>` with a new empty folder in your scratchpad directory, and `<repo>` with the absolute repo path):

```bash
WEB_DIST=<repo>/web/dist-probe DATA_DIR=<scratch>/probe-data PORT=8099 npm start -w server
```

Run it in the background. Confirm the CSP header reaches the page: `curl -sI http://localhost:8099/ | grep -i content-security-policy` must show `style-src 'self'`.

- [ ] **Step 4: Run the probe in a real browser**

Open `http://localhost:8099/` in the Browser pane (or Playwright). Wait 2 seconds. Read `window.__probe` (or the `#out` text). Take a screenshot and look at the three diagrams.

- [ ] **Step 5: Judge the result**

All of these must hold:

- `constructedSheet` is `true` and `cssomStyle` is `true`.
- For `flow` and `flowBig`: `themeFillApplied` is `true`, `inlineStyleApplied` is `true`, `overflow` is `[]`, `ownViolations` is `[]`.
- For `seq`: `overflow` is `[]` and `ownViolations` is `[]`.
- In the screenshot, `flowBig` labels (22px monospace) sit inside their boxes.

`allViolations` may list blocked inline styles from Mermaid's own measuring container. That is expected and fine only if `flowBig` still has no overflow. If the 22px labels spill out of their boxes, the measuring pass ignored the font settings, and that is a failure.

If every condition holds, go on. **If any fails, STOP.** Delete the probe files (Step 6), record the failing values in the spec, commit that, and report to the user. The design then needs another round (the options are the `data:` SVG image fallback and a sandboxed renderer page with its own CSP). Do not start Task 2.

- [ ] **Step 6: Stop the server and delete the probe**

Stop the background server. Run:

```bash
rm -rf web/probe web/dist-probe web/vite.probe.config.ts
git status --short
```

Expected: only `web/package.json`, `package-lock.json` and (after Step 7) the spec are modified.

- [ ] **Step 7: Record the result in the spec and commit**

Append to the end of `docs/superpowers/specs/2026-10-15-mermaid-diagrams-design.md`:

```markdown
## Probe result (Task 1)

Date and mermaid version: <fill from the run>. A throwaway page under the real CSP (`style-src 'self'`) showed: constructed stylesheets apply, CSSOM `style.cssText` applies, theme and per-node inline styles survive, and labels stay inside their boxes even at 22px monospace (so Mermaid's measuring pass honors the font settings). No CSP violation came from our own insertion. The approach in "CSP" above is confirmed.
```

Replace `<fill from the run>` with the real date and `npm ls` version before committing.

```bash
git add web/package.json package-lock.json docs/superpowers/specs/2026-10-15-mermaid-diagrams-design.md
git commit -m "build(web): add mermaid; record CSP probe result

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: SVG sanitizer

**Files:**
- Create: `web/src/diagrams/svgSanitize.ts`
- Test: `web/src/diagrams/svgSanitize.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `prepareDiagramSvg(raw: string): { svg: string; css: string } | null`. `svg` has no `<style>` and no `style` attributes (each became `data-inline-style="<css text>"`); `css` is the sanitized text of the removed `<style>` blocks. Returns `null` when `raw` holds no `<svg>`.
  - `sanitizeCss(css: string): string`.

- [ ] **Step 1: Write the failing tests**

`web/src/diagrams/svgSanitize.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { prepareDiagramSvg, sanitizeCss } from './svgSanitize';

const svg = (inner: string, attrs = '') =>
  `<svg id="d1" viewBox="0 0 10 10" xmlns="http://www.w3.org/2000/svg" ${attrs}>${inner}</svg>`;

describe('prepareDiagramSvg', () => {
  it('lifts <style> blocks out of the svg and returns their text', () => {
    const r = prepareDiagramSvg(svg('<style>#d1 .node{fill:red}</style><rect class="node"/>'))!;
    expect(r.svg).not.toContain('<style');
    expect(r.css).toContain('#d1 .node{fill:red}');
    expect(r.svg).toContain('class="node"');
  });

  it('moves style attributes, root included, to data-inline-style', () => {
    const r = prepareDiagramSvg(svg('<rect style="fill:#f9f;stroke:#333"/>', 'style="max-width: 300px;"'))!;
    expect(r.svg).not.toMatch(/\sstyle=/);
    expect(r.svg).toContain('data-inline-style="fill:#f9f;stroke:#333"');
    expect(r.svg).toContain('data-inline-style="max-width: 300px;"');
  });

  it('removes script, foreignObject, event attributes and external hrefs', () => {
    const r = prepareDiagramSvg(
      svg(
        '<script>alert(1)</script><foreignObject><div>x</div></foreignObject><rect onclick="a()"/>' +
          '<a href="https://evil.test"><text>t</text></a><use xlink:href="https://evil.test/x.svg#a"/><use href="#ok"/>',
      ),
    )!;
    expect(r.svg).not.toMatch(/<script|foreignObject|onclick|evil\.test/i);
    expect(r.svg).toContain('href="#ok"');
  });

  it('keeps the structure Mermaid needs', () => {
    const r = prepareDiagramSvg(
      svg('<defs><marker id="m"><path d="M0 0"/></marker></defs><g class="node"><rect/><text>hi</text></g>'),
    )!;
    expect(r.svg).toContain('<marker');
    expect(r.svg).toContain('<text>hi</text>');
    expect(r.svg).toContain('viewBox="0 0 10 10"');
  });

  it('returns null when there is no svg', () => {
    expect(prepareDiagramSvg('<div>no</div>')).toBeNull();
    expect(prepareDiagramSvg('')).toBeNull();
  });

  it('sanitizes the lifted css', () => {
    const r = prepareDiagramSvg(svg('<style>@import url(https://evil.test/a.css); .a{background:url(https://evil.test/x.png)}</style>'))!;
    expect(r.css).not.toContain('evil.test');
  });
});

describe('sanitizeCss', () => {
  it('drops @import', () => {
    expect(sanitizeCss('@import url("https://evil.test/a.css");\n.a{color:red}')).toBe('\n.a{color:red}');
  });
  it('neutralizes a url() that is not a same-document fragment', () => {
    expect(sanitizeCss('.a{background:url(https://evil.test/x.png)}')).toBe('.a{background:none}');
    expect(sanitizeCss(".a{background:url('data:image/png;base64,AAAA')}")).toBe('.a{background:none}');
  });
  it('keeps url(#fragment) for markers and gradients', () => {
    expect(sanitizeCss('.a{marker-end:url(#arrow)}')).toBe('.a{marker-end:url(#arrow)}');
    expect(sanitizeCss('.a{fill:url("#grad")}')).toBe('.a{fill:url("#grad")}');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w web -- src/diagrams/svgSanitize.test.ts`
Expected: FAIL (cannot resolve `./svgSanitize`).

- [ ] **Step 3: Implement**

`web/src/diagrams/svgSanitize.ts`:

```ts
import createDOMPurify, { type DOMPurify } from 'dompurify';

export interface PreparedDiagram {
  /** Sanitized SVG with no <style> and no style="" (each became data-inline-style). */
  svg: string;
  /** Sanitized text of the <style> blocks that were lifted out. */
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
 * Turn Mermaid's SVG string into something the strict CSP allows. The CSP bans inline <style> and style="..."
 * strings, so both are taken out here: the css goes to a constructed stylesheet, and each style attribute is kept
 * as data-inline-style for the mount step to apply through CSSOM.
 */
export function prepareDiagramSvg(raw: string): PreparedDiagram | null {
  // A detached document: nothing is applied or fetched while we edit it.
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
  const clean = getPurifier().sanitize(svg.outerHTML, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ['style', 'script', 'foreignObject'],
  });
  if (!clean.includes('<svg')) return null;
  return { svg: clean, css: sanitizeCss(css) };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w web -- src/diagrams/svgSanitize.test.ts`
Expected: PASS. If a case fails because DOMPurify drops or renames something (for example `data-inline-style` or `viewBox`), fix the config (`ADD_ATTR`, `ALLOW_DATA_ATTR`), not the test.

- [ ] **Step 5: Commit**

```bash
git add web/src/diagrams/svgSanitize.ts web/src/diagrams/svgSanitize.test.ts
git commit -m "feat(web): sanitize and CSP-prepare Mermaid SVG

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Ref-counted constructed stylesheets

**Files:**
- Create: `web/src/diagrams/diagramSheets.ts`
- Test: `web/src/diagrams/diagramSheets.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `adoptDiagramCss(key: string, css: string): () => void`. Adds one constructed stylesheet per `key` to `document.adoptedStyleSheets` (shared by every caller with the same key) and returns a release function. The sheet is removed when the last holder releases. Releasing twice is harmless.

- [ ] **Step 1: Write the failing tests**

`web/src/diagrams/diagramSheets.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adoptDiagramCss } from './diagramSheets';

class FakeSheet {
  text = '';
  replaceSync(text: string) {
    this.text = text;
  }
}

beforeEach(() => {
  vi.stubGlobal('CSSStyleSheet', FakeSheet);
  Object.defineProperty(document, 'adoptedStyleSheets', { value: [], writable: true, configurable: true });
});
afterEach(() => vi.unstubAllGlobals());

const sheets = () => document.adoptedStyleSheets as unknown as FakeSheet[];

describe('adoptDiagramCss', () => {
  it('adds a sheet holding the css', () => {
    const release = adoptDiagramCss('k-add', '#a{fill:red}');
    expect(sheets()).toHaveLength(1);
    expect(sheets()[0].text).toBe('#a{fill:red}');
    release();
  });

  it('shares one sheet between callers with the same key', () => {
    const r1 = adoptDiagramCss('k-share', '#b{fill:red}');
    const r2 = adoptDiagramCss('k-share', '#b{fill:red}');
    expect(sheets()).toHaveLength(1);
    r1();
    expect(sheets()).toHaveLength(1);
    r2();
    expect(sheets()).toHaveLength(0);
  });

  it('keeps different keys apart', () => {
    const r1 = adoptDiagramCss('k-one', '#c{fill:red}');
    const r2 = adoptDiagramCss('k-two', '#d{fill:red}');
    expect(sheets()).toHaveLength(2);
    r1();
    expect(sheets()).toHaveLength(1);
    expect(sheets()[0].text).toBe('#d{fill:red}');
    r2();
  });

  it('ignores a second release from the same holder', () => {
    const r1 = adoptDiagramCss('k-twice', '#e{fill:red}');
    const r2 = adoptDiagramCss('k-twice', '#e{fill:red}');
    r1();
    r1();
    expect(sheets()).toHaveLength(1);
    r2();
    expect(sheets()).toHaveLength(0);
  });

  it('adopts afresh after the last holder released', () => {
    adoptDiagramCss('k-again', '#f{fill:red}')();
    const r = adoptDiagramCss('k-again', '#f{fill:blue}');
    expect(sheets()).toHaveLength(1);
    expect(sheets()[0].text).toBe('#f{fill:blue}');
    r();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w web -- src/diagrams/diagramSheets.test.ts`
Expected: FAIL (cannot resolve `./diagramSheets`).

- [ ] **Step 3: Implement**

`web/src/diagrams/diagramSheets.ts`:

```ts
interface Held {
  sheet: CSSStyleSheet;
  holders: number;
}

const held = new Map<string, Held>();

/**
 * Apply diagram css through a constructed stylesheet, which the strict CSP allows (an inline <style> it does not).
 * Callers with the same key share one sheet; it is removed when the last of them releases.
 */
export function adoptDiagramCss(key: string, css: string): () => void {
  let entry = held.get(key);
  if (!entry) {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    entry = { sheet, holders: 0 };
    held.set(key, entry);
  }
  entry.holders += 1;
  const mine = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    mine.holders -= 1;
    if (mine.holders === 0) {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== mine.sheet);
      held.delete(key);
    }
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w web -- src/diagrams/diagramSheets.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/diagrams/diagramSheets.ts web/src/diagrams/diagramSheets.test.ts
git commit -m "feat(web): ref-counted constructed stylesheets for diagrams

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Mermaid loader and renderer

**Files:**
- Create: `web/src/diagrams/mermaidRender.ts`
- Test: `web/src/diagrams/mermaidRender.test.ts`

**Interfaces:**
- Consumes: `prepareDiagramSvg` from `./svgSanitize` (Task 2).
- Produces:
  - `type DiagramResult = { ok: true; id: string; svg: string; css: string } | { ok: false; reason: 'oversized' | 'syntax' | 'load'; message?: string }`
  - `renderDiagram(source: string): Promise<DiagramResult>`: trims the source, lazy-loads Mermaid, renders, sanitizes. Results are cached by trimmed source (a `load` failure is not cached). Same source gives the same `id`.
  - `peekDiagram(source: string): DiagramResult | undefined`: the settled result for that source, if any.
  - `MAX_TEXT_SIZE = 20_000`, `MAX_EDGES = 200`.

- [ ] **Step 1: Write the failing tests**

`web/src/diagrams/mermaidRender.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('mermaid', () => ({ default: { initialize: vi.fn(), render: vi.fn() } }));

const OK_SVG =
  '<svg id="inked-dg-1" viewBox="0 0 1 1" xmlns="http://www.w3.org/2000/svg"><style>#inked-dg-1 .n{fill:red}</style><rect class="n"/></svg>';

async function load() {
  vi.resetModules();
  const mod = await import('./mermaidRender');
  const { default: mermaid } = await import('mermaid');
  return { mod, mermaid: mermaid as unknown as { initialize: ReturnType<typeof vi.fn>; render: ReturnType<typeof vi.fn> } };
}

beforeEach(() => {
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    getPropertyValue: (name: string) => (name === '--ink' ? ' #123456 ' : ''),
  } as unknown as CSSStyleDeclaration);
});
afterEach(() => vi.restoreAllMocks());

describe('renderDiagram', () => {
  it('renders, sanitizes and returns the css separately', async () => {
    const { mod, mermaid } = await load();
    mermaid.render.mockResolvedValue({ svg: OK_SVG });
    const r = await mod.renderDiagram('graph TD; A-->B');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.id).toMatch(/^inked-dg-\d+$/);
    expect(r.svg).not.toContain('<style');
    expect(r.css).toContain('.n{fill:red}');
    expect(mermaid.render).toHaveBeenCalledWith(r.id, 'graph TD; A-->B');
  });

  it('initializes Mermaid once, strict, with our limits and a locked theme', async () => {
    const { mod, mermaid } = await load();
    mermaid.render.mockResolvedValue({ svg: OK_SVG });
    await mod.renderDiagram('graph TD; A-->B');
    await mod.renderDiagram('graph TD; B-->C');
    expect(mermaid.initialize).toHaveBeenCalledTimes(1);
    const cfg = mermaid.initialize.mock.calls[0][0];
    expect(cfg).toMatchObject({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      htmlLabels: false,
      maxTextSize: 20000,
      maxEdges: 200,
      flowchart: { htmlLabels: false },
    });
    // A note's %%{init}%% directive may not change the theme or inject css.
    expect(cfg.secure).toEqual(
      expect.arrayContaining(['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'theme', 'themeCSS', 'themeVariables', 'fontFamily']),
    );
  });

  it('reads theme colors from the CSS variables', async () => {
    const { mod, mermaid } = await load();
    mermaid.render.mockResolvedValue({ svg: OK_SVG });
    await mod.renderDiagram('graph TD; A-->B');
    const vars = mermaid.initialize.mock.calls[0][0].themeVariables;
    expect(vars.darkMode).toBe(true);
    expect(vars.primaryBorderColor).toBe('#123456');
    expect(typeof vars.primaryColor).toBe('string');
  });

  it('refuses an oversized source without loading Mermaid', async () => {
    const { mod, mermaid } = await load();
    const r = await mod.renderDiagram(`graph TD;\n${'A-->B;\n'.repeat(5000)}`);
    expect(r).toEqual({ ok: false, reason: 'oversized' });
    expect(mermaid.render).not.toHaveBeenCalled();
    expect(mermaid.initialize).not.toHaveBeenCalled();
  });

  it('maps a Mermaid parse error to syntax with the first line only', async () => {
    const { mod, mermaid } = await load();
    mermaid.render.mockRejectedValue(new Error('Parse error on line 2:\n...A--\n-----^\nExpecting X'));
    const r = await mod.renderDiagram('graph TD\nA--');
    expect(r).toEqual({ ok: false, reason: 'syntax', message: 'Parse error on line 2:' });
  });

  it('maps an edge-limit error to oversized', async () => {
    const { mod, mermaid } = await load();
    mermaid.render.mockRejectedValue(new Error('Edge limit exceeded. 201 edges found, but the limit is 200.'));
    const r = await mod.renderDiagram('graph TD; A-->B');
    expect(r).toMatchObject({ ok: false, reason: 'oversized' });
  });

  it('treats svg that sanitizes to nothing as a syntax failure', async () => {
    const { mod, mermaid } = await load();
    mermaid.render.mockResolvedValue({ svg: '<div>not an svg</div>' });
    const r = await mod.renderDiagram('graph TD; A-->B');
    expect(r).toMatchObject({ ok: false, reason: 'syntax' });
  });

  it('caches by source: one render, one id, and peek sees it once settled', async () => {
    const { mod, mermaid } = await load();
    mermaid.render.mockResolvedValue({ svg: OK_SVG });
    expect(mod.peekDiagram('graph TD; A-->B')).toBeUndefined();
    const p = mod.renderDiagram('graph TD; A-->B');
    expect(mod.peekDiagram('graph TD; A-->B')).toBeUndefined();
    const first = await p;
    const second = await mod.renderDiagram('  graph TD; A-->B\n');
    expect(mermaid.render).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(mod.peekDiagram('graph TD; A-->B')).toBe(first);
  });

  it('reports a load failure and retries on the next call instead of caching it', async () => {
    const { mod, mermaid } = await load();
    mermaid.initialize.mockImplementationOnce(() => {
      throw new Error('chunk failed');
    });
    mermaid.render.mockResolvedValue({ svg: OK_SVG });
    expect(await mod.renderDiagram('graph TD; A-->B')).toEqual({ ok: false, reason: 'load' });
    expect(mod.peekDiagram('graph TD; A-->B')).toBeUndefined();
    const again = await mod.renderDiagram('graph TD; A-->B');
    expect(again.ok).toBe(true);
  });

  it('removes the temporary node Mermaid leaves behind on an error', async () => {
    const { mod, mermaid } = await load();
    mermaid.render.mockImplementation(async (id: string) => {
      const leftover = document.createElement('div');
      leftover.id = `d${id}`;
      document.body.append(leftover);
      throw new Error('boom');
    });
    await mod.renderDiagram('graph TD; A-->B');
    expect(document.querySelector('[id^="dinked-dg-"]')).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w web -- src/diagrams/mermaidRender.test.ts`
Expected: FAIL (cannot resolve `./mermaidRender`).

- [ ] **Step 3: Implement**

`web/src/diagrams/mermaidRender.ts`:

```ts
import { prepareDiagramSvg } from './svgSanitize';

export const MAX_TEXT_SIZE = 20_000;
export const MAX_EDGES = 200;
const MAX_CACHED = 50;

export type DiagramResult =
  | { ok: true; id: string; svg: string; css: string }
  | { ok: false; reason: 'oversized' | 'syntax' | 'load'; message?: string };

type MermaidApi = typeof import('mermaid').default;

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

// Mermaid does colour maths on these, so they must be literal colours, not var(). The app is dark-only.
function themeVariables() {
  return {
    darkMode: true,
    background: cssVar('--panel', '#1b1a21'),
    fontFamily: cssVar('--font-ui', "system-ui, -apple-system, 'Segoe UI', sans-serif"),
    fontSize: '14px',
    textColor: cssVar('--text', '#e6e3ee'),
    primaryColor: cssVar('--panel-3', '#24222c'),
    primaryTextColor: cssVar('--text', '#e6e3ee'),
    primaryBorderColor: cssVar('--ink', '#7452e0'),
    secondaryColor: cssVar('--panel-2', '#211f28'),
    tertiaryColor: cssVar('--side', '#121117'),
    lineColor: cssVar('--ink-link', '#8d7bc4'),
    noteBkgColor: cssVar('--panel-2', '#211f28'),
    noteTextColor: cssVar('--text', '#e6e3ee'),
    noteBorderColor: cssVar('--border-2', '#34323f'),
  };
}

const THEME_CSS = `
  .node rect, .node polygon { rx: 6px; ry: 6px; }
  .cluster rect { rx: 8px; ry: 8px; }
  .flowchart-link, .messageLine0, .messageLine1 { stroke-width: 1.5px; }
`;

let loading: Promise<MermaidApi> | null = null;

function loadMermaid(): Promise<MermaidApi> {
  if (!loading) {
    loading = import('mermaid').then((m) => {
      const mermaid = m.default;
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: 'base',
        themeVariables: themeVariables(),
        themeCSS: THEME_CSS,
        maxTextSize: MAX_TEXT_SIZE,
        maxEdges: MAX_EDGES,
        htmlLabels: false,
        flowchart: { htmlLabels: false },
        suppressErrorRendering: true,
        // Keys a note's %%{init}%% directive may not change: Mermaid's own list plus the look.
        secure: [
          'secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering',
          'theme', 'themeCSS', 'themeVariables', 'fontFamily',
        ],
      });
      return mermaid;
    });
    // A failed load is not kept: the next view tries again.
    loading.catch(() => {
      loading = null;
    });
  }
  return loading;
}

interface Entry {
  promise: Promise<DiagramResult>;
  value?: DiagramResult;
}

const cache = new Map<string, Entry>();
let counter = 0;

function firstLine(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.split('\n')[0].trim().slice(0, 120);
}

async function draw(text: string): Promise<DiagramResult> {
  let mermaid: MermaidApi;
  try {
    mermaid = await loadMermaid();
  } catch {
    return { ok: false, reason: 'load' };
  }
  const id = `inked-dg-${++counter}`;
  try {
    const { svg } = await mermaid.render(id, text);
    const prepared = prepareDiagramSvg(svg);
    if (!prepared) return { ok: false, reason: 'syntax' };
    return { ok: true, id, ...prepared };
  } catch (e) {
    const message = firstLine(e);
    return { ok: false, reason: /edge/i.test(message) ? 'oversized' : 'syntax', message };
  } finally {
    // Mermaid can leave its measuring node in <body> after an error.
    document.getElementById(`d${id}`)?.remove();
  }
}

export function peekDiagram(source: string): DiagramResult | undefined {
  return cache.get(source.trim())?.value;
}

export function renderDiagram(source: string): Promise<DiagramResult> {
  const text = source.trim();
  if (text.length > MAX_TEXT_SIZE) return Promise.resolve({ ok: false, reason: 'oversized' });
  const hit = cache.get(text);
  if (hit) return hit.promise;
  const entry: Entry = { promise: draw(text) };
  cache.set(text, entry);
  if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  void entry.promise.then((r) => {
    if (!r.ok && r.reason === 'load') cache.delete(text);
    else entry.value = r;
  });
  return entry.promise;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w web -- src/diagrams/mermaidRender.test.ts`
Expected: PASS. If a test fails because Mermaid's real option names differ from the ones above (for example `secure` or top-level `htmlLabels` being rejected by the types), run `npx tsc -b` in `web`, read the type error, fix the config and keep the test's intent.

- [ ] **Step 5: Type-check**

Run: `npm run build -w web`
Expected: PASS (`tsc -b` clean and the Vite build succeeds; Mermaid lands in separate lazy chunks).

- [ ] **Step 6: Commit**

```bash
git add web/src/diagrams/mermaidRender.ts web/src/diagrams/mermaidRender.test.ts
git commit -m "feat(web): lazy Mermaid renderer with limits, cache and locked theme

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: View hook, wiring and styles

**Files:**
- Create: `web/src/diagrams/useDiagrams.ts`
- Test: `web/src/diagrams/useDiagrams.test.tsx`
- Modify: `web/src/pages/NotePane.tsx` (the `useInkedImages(articleRef, vault.id, html);` line, 178), `web/src/pages/NodePreview.tsx` (line 37), `web/src/styles/note.css` (after the `.md pre code` rule, about line 347)
- Test: `web/src/markdown/render.test.ts` (add one case)

**Interfaces:**
- Consumes: `renderDiagram`, `peekDiagram`, `DiagramResult` from `./mermaidRender` (Task 4); `adoptDiagramCss` from `./diagramSheets` (Task 3).
- Produces: `useDiagrams(ref: RefObject<HTMLElement | null>, html: string): void`.

- [ ] **Step 1: Write the failing hook tests**

`web/src/diagrams/useDiagrams.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiagramResult } from './mermaidRender';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const renderDiagram = vi.fn<(s: string) => Promise<DiagramResult>>();
const peekDiagram = vi.fn<(s: string) => DiagramResult | undefined>();
const adopt = vi.fn();
vi.mock('./mermaidRender', () => ({
  renderDiagram: (s: string) => renderDiagram(s),
  peekDiagram: (s: string) => peekDiagram(s),
}));
vi.mock('./diagramSheets', () => ({ adoptDiagramCss: (k: string, c: string) => adopt(k, c) }));

const { useDiagrams } = await import('./useDiagrams');

const SVG =
  '<svg id="inked-dg-1" viewBox="0 0 10 10" data-inline-style="max-width: 300px;"><title>Flow</title><rect data-inline-style="opacity: 0.5"/></svg>';
const ok = (id = 'inked-dg-1'): DiagramResult => ({ ok: true, id, svg: SVG, css: '#inked-dg-1 .n{fill:red}' });
const block = (src: string) => `<pre><code class="language-mermaid">${src}</code></pre>`;

function Host({ markup }: { markup: string }) {
  const ref = useRef<HTMLElement>(null);
  useDiagrams(ref, markup);
  return <article ref={ref} dangerouslySetInnerHTML={{ __html: markup }} />;
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function mount(markup: string) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<Host markup={markup} />));
  return host;
}

let release: ReturnType<typeof vi.fn>;
beforeEach(() => {
  renderDiagram.mockReset();
  peekDiagram.mockReset().mockReturnValue(undefined);
  release = vi.fn();
  adopt.mockReset().mockReturnValue(release);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

describe('useDiagrams', () => {
  it('replaces a mermaid block with a figure holding the svg, css adopted and inline styles applied', async () => {
    renderDiagram.mockResolvedValue(ok());
    const el = await mount(block('graph TD; A-->B'));
    expect(renderDiagram).toHaveBeenCalledWith('graph TD; A-->B');
    expect(el.querySelector('pre')).toBeNull();
    const figure = el.querySelector('figure.diagram')!;
    expect(figure.getAttribute('role')).toBe('img');
    expect(figure.getAttribute('aria-label')).toBe('Flow');
    expect(figure.querySelector('svg')).not.toBeNull();
    expect(adopt).toHaveBeenCalledWith('inked-dg-1', '#inked-dg-1 .n{fill:red}');
    const svg = figure.querySelector('svg')!;
    expect(svg.style.maxWidth).toBe('300px');
    expect((figure.querySelector('rect') as SVGElement).style.opacity).toBe('0.5');
    expect(figure.querySelector('[data-inline-style]')).toBeNull();
  });

  it('uses a cached result at once, without waiting', async () => {
    peekDiagram.mockReturnValue(ok());
    const el = await mount(block('graph TD; A-->B'));
    expect(renderDiagram).not.toHaveBeenCalled();
    expect(el.querySelector('figure.diagram')).not.toBeNull();
  });

  it('labels the figure "Diagram" when the svg has no title', async () => {
    renderDiagram.mockResolvedValue({ ...ok(), svg: '<svg id="inked-dg-1" viewBox="0 0 1 1"><rect/></svg>' });
    const el = await mount(block('graph TD; A-->B'));
    expect(el.querySelector('figure')!.getAttribute('aria-label')).toBe('Diagram');
  });

  it.each([
    [{ ok: false, reason: 'syntax', message: 'Parse error on line 2:' } as const, 'Diagram error: Parse error on line 2:'],
    [{ ok: false, reason: 'syntax' } as const, 'Diagram error'],
    [{ ok: false, reason: 'oversized' } as const, 'Diagram too large to draw.'],
    [{ ok: false, reason: 'load' } as const, 'Could not load the diagram renderer.'],
  ])('keeps the code block and adds a note for a failure (%j)', async (result, text) => {
    renderDiagram.mockResolvedValue(result);
    const el = await mount(block('graph TD; A-->B'));
    expect(el.querySelector('pre')).not.toBeNull();
    expect(el.querySelector('figure')).toBeNull();
    const note = el.querySelector('.diagram-note')!;
    expect(note.textContent).toBe(text);
    expect(note.getAttribute('role')).toBe('note');
    expect(adopt).not.toHaveBeenCalled();
  });

  it('leaves other code blocks and empty mermaid blocks alone', async () => {
    const el = await mount(
      `<pre><code class="language-js">x</code></pre>${block('')}${block('   \n ')}<pre><code>plain</code></pre>`,
    );
    expect(renderDiagram).not.toHaveBeenCalled();
    expect(el.querySelectorAll('pre')).toHaveLength(4);
    expect(el.querySelector('.diagram-note')).toBeNull();
  });

  it('draws two identical diagrams, each adopting the shared sheet, and releases both on unmount', async () => {
    renderDiagram.mockResolvedValue(ok());
    const el = await mount(block('graph TD; A-->B') + block('graph TD; A-->B'));
    expect(el.querySelectorAll('figure.diagram')).toHaveLength(2);
    expect(adopt).toHaveBeenCalledTimes(2);
    act(() => root!.unmount());
    root = null;
    expect(release).toHaveBeenCalledTimes(2);
  });

  it('does not touch the DOM or adopt css when unmounted before the render resolves', async () => {
    let resolve!: (r: DiagramResult) => void;
    renderDiagram.mockReturnValue(new Promise((r) => (resolve = r)));
    const el = await mount(block('graph TD; A-->B'));
    const pre = el.querySelector('pre')!;
    act(() => root!.unmount());
    root = null;
    await act(async () => resolve(ok()));
    expect(adopt).not.toHaveBeenCalled();
    expect(pre.isConnected).toBe(false);
    expect(document.querySelector('figure.diagram')).toBeNull();
  });

  it('releases the sheet and draws again when the html changes', async () => {
    renderDiagram.mockResolvedValue(ok());
    const el = await mount(block('graph TD; A-->B'));
    expect(adopt).toHaveBeenCalledTimes(1);
    await act(async () => root!.render(<Host markup={block('graph TD; B-->C')} />));
    expect(release).toHaveBeenCalledTimes(1);
    expect(renderDiagram).toHaveBeenLastCalledWith('graph TD; B-->C');
    expect(adopt).toHaveBeenCalledTimes(2);
    expect(el.querySelectorAll('figure.diagram')).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w web -- src/diagrams/useDiagrams.test.tsx`
Expected: FAIL (cannot resolve `./useDiagrams`).

- [ ] **Step 3: Implement the hook**

`web/src/diagrams/useDiagrams.ts`:

```ts
import { useEffect, type RefObject } from 'react';
import { adoptDiagramCss } from './diagramSheets';
import { peekDiagram, renderDiagram, type DiagramResult } from './mermaidRender';

type Drawn = Extract<DiagramResult, { ok: true }>;
type Failed = Extract<DiagramResult, { ok: false }>;

function failureText(r: Failed): string {
  if (r.reason === 'oversized') return 'Diagram too large to draw.';
  if (r.reason === 'load') return 'Could not load the diagram renderer.';
  return r.message ? `Diagram error: ${r.message}` : 'Diagram error';
}

function figureFor(r: Drawn): HTMLElement {
  const parsed = new DOMParser().parseFromString(`<body>${r.svg}</body>`, 'text/html');
  const svg = document.importNode(parsed.body.firstElementChild!, true) as SVGElement;
  // The CSP bans style="..." strings but allows CSSOM writes, so each style attribute is applied this way.
  for (const el of [svg, ...Array.from(svg.querySelectorAll<SVGElement>('[data-inline-style]'))]) {
    const css = el.getAttribute('data-inline-style');
    if (css === null) continue;
    el.style.cssText = css;
    el.removeAttribute('data-inline-style');
  }
  const figure = document.createElement('figure');
  figure.className = 'diagram';
  figure.setAttribute('role', 'img');
  figure.setAttribute('aria-label', svg.querySelector('title')?.textContent?.trim() || 'Diagram');
  figure.append(svg);
  return figure;
}

/**
 * Replaces each `pre > code.language-mermaid` in `ref` with a drawn diagram after every render. A diagram that
 * cannot be drawn stays a code block with a one-line note. `html` is a dependency because React rebuilds the
 * blocks whenever it changes. Not used for untrusted (Ask) output.
 */
export function useDiagrams(ref: RefObject<HTMLElement | null>, html: string): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let live = true;
    const releases: Array<() => void> = [];
    for (const code of Array.from(root.querySelectorAll<HTMLElement>('pre > code.language-mermaid'))) {
      const pre = code.parentElement as HTMLElement;
      const source = code.textContent ?? '';
      if (!source.trim()) continue;
      const show = (r: DiagramResult) => {
        if (!live || !pre.isConnected) return;
        if (r.ok) {
          releases.push(adoptDiagramCss(r.id, r.css));
          pre.replaceWith(figureFor(r));
        } else {
          const note = document.createElement('p');
          note.className = 'diagram-note';
          note.setAttribute('role', 'note');
          note.textContent = failureText(r);
          pre.after(note);
        }
      };
      const cached = peekDiagram(source);
      if (cached) show(cached);
      else void renderDiagram(source).then(show);
    }
    return () => {
      live = false;
      for (const release of releases) release();
    };
  }, [ref, html]);
}
```

- [ ] **Step 4: Run the hook tests to verify they pass**

Run: `npm test -w web -- src/diagrams/useDiagrams.test.tsx`
Expected: PASS.

- [ ] **Step 5: Wire the hook into the two views**

In `web/src/pages/NotePane.tsx`, add the import beside `useInkedImages` and the call after it:

```tsx
import { useDiagrams } from '../diagrams/useDiagrams';
```

```tsx
  useInkedImages(articleRef, vault.id, html);
  useDiagrams(articleRef, html);
```

In `web/src/pages/NodePreview.tsx`, the same import and, after line 37:

```tsx
  useInkedImages(articleRef, vaultId, html);
  useDiagrams(articleRef, html);
```

Do not touch `web/src/ask/AskAnswer.tsx`.

- [ ] **Step 6: Add the styles**

In `web/src/styles/note.css`, directly after the `.md pre code { ... }` rule:

```css
.md .diagram {
  margin: 0 0 20px;
  padding: 12px 14px;
  background: var(--side);
  border: 1px solid var(--side-border);
  border-radius: var(--radius-lg);
  overflow-x: auto;
}
.md .diagram svg {
  display: block;
  margin: 0 auto;
  height: auto;
}
.md .diagram-note {
  margin: -12px 0 20px;
  font: 400 12px/1.5 var(--font-ui);
  color: var(--muted-2);
}
```

- [ ] **Step 7: Pin that the markdown side is unchanged**

Add to `web/src/markdown/render.test.ts` (inside the existing top-level `describe` for `renderMarkdown`; follow the file's existing import and style):

```ts
  it('leaves a mermaid fence as an ordinary code block, in notes and in untrusted output', () => {
    const src = '```mermaid\ngraph TD; A-->B\n```';
    expect(renderMarkdown(src)).toContain('<pre><code class="language-mermaid">');
    expect(renderUntrustedMarkdown(src)).toContain('<pre><code class="language-mermaid">');
  });
```

If `renderUntrustedMarkdown` is not already imported in that test file, add it to the existing import from `./render`.

- [ ] **Step 8: Run the whole web suite and the build**

Run: `npm test -w web`
Expected: all PASS (the existing count was 710; yours is higher by the new tests).
Run: `npm run build -w web`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add web/src/diagrams/useDiagrams.ts web/src/diagrams/useDiagrams.test.tsx web/src/pages/NotePane.tsx web/src/pages/NodePreview.tsx web/src/styles/note.css web/src/markdown/render.test.ts
git commit -m "feat(web): draw mermaid fences as diagrams in note view

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Docs

**Files:**
- Modify: `docs/architecture.md`, `docs/mcp.md`, `docs/superpowers/specs/2026-10-15-mermaid-diagrams-design.md`

**Interfaces:**
- Consumes: the behavior built in Tasks 2 to 5.
- Produces: nothing code depends on.

- [ ] **Step 1: Add a Diagrams section to `docs/architecture.md`**

Directly after the `## Images` section (which ends before the next `##` heading), add:

```markdown
## Diagrams

A fenced block tagged `mermaid` is drawn as a diagram in note view. The note stays plain Markdown: `markdown-it` renders the fence as an ordinary code block, and after render a view hook (`useDiagrams`) loads Mermaid on demand, renders the block to SVG in the browser, and swaps it in. The server never sees a diagram, and the Mermaid code is a self-hosted lazy chunk that notes without a diagram never load. Mermaid runs with `securityLevel: 'strict'`, HTML labels off, `maxTextSize` 20 000 and `maxEdges` 200, and its theme is locked to Inked's colors, so a note's `%%{init}%%` directive cannot change the look or inject CSS.

The CSP is unchanged (`style-src 'self'`). Mermaid's SVG carries an inline `<style>` and `style=""` attributes, which that CSP forbids, so the SVG is first sanitized with DOMPurify (no script, `foreignObject`, event attributes or external `href`), its `<style>` text goes into a constructed stylesheet (refcounted in `document.adoptedStyleSheets`), and each style attribute is applied through CSSOM. A diagram that is too large, has a syntax error, or cannot load stays a code block with a one-line note. Ask answers are never hydrated: a mermaid fence in an LLM answer stays a code block.
```

- [ ] **Step 2: Add a short note to `docs/mcp.md`**

After the `## Adding images` section, add:

```markdown
## Diagrams

Notes can hold diagrams written in Mermaid. Put the diagram in a fenced block tagged `mermaid`; Inked draws it in the browser when the note is viewed, and the source stays plain text in the note, so `read_note` and search see it as written. Diagrams need no tool, no action and no setting.
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md docs/mcp.md
git commit -m "docs: mermaid diagrams (architecture, MCP)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Production build, real-browser check, bundle size

**Files:**
- Modify: `docs/superpowers/specs/2026-10-15-mermaid-diagrams-design.md` (the Open items line)

**Interfaces:**
- Consumes: everything above.
- Produces: a verified feature and a measured chunk size.

- [ ] **Step 1: Build and start the app on a scratch data dir**

```bash
npm run build
```

Start the built server in the background on a free port with a new empty `DATA_DIR` in your scratchpad (`PORT=8098 DATA_DIR=<scratch>/mermaid-data npm start`). Read the first-run setup token from its log. Open `http://localhost:8098/` in the Browser pane, create an account with a test password, and create a vault and a note (as in the images check).

- [ ] **Step 2: Check each case in view mode**

Put these in notes and switch each to view mode. Read the console filtered to `Content Security Policy` after each one.

1. A flowchart with a subgraph, a decision node and a labeled edge. Drawn, dark and purple, labels inside their boxes, no console CSP error.
2. A sequence diagram. Drawn.
3. A state diagram, a class diagram and an ER diagram. Drawn or, if one looks wrong, noted as best-effort in the spec.
4. A flowchart with `style A fill:#ff00ff` on one node. That node is magenta (the style attribute went through CSSOM).
5. A diagram with a syntax error. The source block stays, with `Diagram error: ...` under it.
6. `%%{init: {"themeCSS": ".node rect { fill: red !important }", "theme": "forest"}}%%` at the top of a flowchart. The look is unchanged (no red, not forest).
7. The same diagram twice in one note. Both drawn and both styled. Delete one of them in edit mode and return to view: the other keeps its styling.
8. An empty mermaid fence. Stays an empty code block, no label.
9. Lock the app and unlock it, then open the note again. Redrawn. (Diagrams are not persisted.)
10. Resize the pane to 375px wide with a wide flowchart. The figure scrolls horizontally and the page does not.
11. Open the note in the node preview (concept map). Drawn there too.
12. An Ask answer containing a mermaid fence, if an Ask connection is available. Stays a code block. If Ask cannot be used, skip it and say so.

If any case fails, fix it with a new failing test first (TDD), re-run Task 5 Step 8, and repeat the failed case.

- [ ] **Step 3: Measure the chunk**

```bash
ls -l web/dist/assets | sort -k5 -n -r | head -8
```

Gzip the largest few (`gzip -c <file> | wc -c`). Record the total size of what a flowchart note loads: the largest Mermaid chunks, raw and gzipped. Confirm none of them is referenced from `web/dist/index.html` (they must load only on demand).

- [ ] **Step 4: Record the size in the spec and commit**

Replace the "Measured size of the Mermaid chunk" line in the spec's Open items with the measured raw and gzipped sizes and the Mermaid version.

```bash
git add docs/superpowers/specs/2026-10-15-mermaid-diagrams-design.md
git commit -m "docs: record Mermaid chunk size and browser check

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Stop the server, then run the full suite**

Stop the background server. Run: `npm test`
Expected: all workspaces PASS.

- [ ] **Step 6: Hand off**

Run a whole-branch review (superpowers:requesting-code-review), fix what it finds, then use superpowers:finishing-a-development-branch. Nothing is merged or pushed without the user's choice.
