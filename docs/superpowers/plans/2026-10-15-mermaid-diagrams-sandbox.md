# Mermaid diagrams in notes (sandboxed renderer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A ```` ```mermaid ```` fence in a note is drawn as a themed SVG diagram in view mode. Mermaid runs in a sandboxed iframe with its own CSP; the main page keeps its strict CSP.

**Architecture:** A separate Vite build produces `dist/frame/` (Mermaid and two fonts). The server serves `/frame/*` with its own CSP (inline styles allowed, no network, `sandbox`) and CORS. The note view talks to the iframe over a `MessageChannel`, gets back an SVG string, sanitizes it, lifts its `<style>` into a constructed stylesheet and its `style=""` attributes into CSSOM writes (both CSP-safe, as the revision 1 probe confirmed), and swaps the code block for a `<figure>`. Any failure leaves the code block and adds a one-line note.

**Tech Stack:** TypeScript, React 18, `mermaid` 11 (already added to `web/package.json` by an earlier task), DOMPurify, Fastify, Vite (second build config), vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-10-15-mermaid-diagrams-design.md` (revision 2). This plan replaces `docs/superpowers/plans/2026-10-15-mermaid-diagrams.md`, whose Task 1 probe failed (commit `8a2e955`; the `mermaid` dependency from that commit stays).

## Global Constraints

Copied from the spec. Every task's requirements include these.

- Mermaid runs in the browser only, on view, from the decrypted note text. The MCP and the data model are not changed. The server only serves static files for the frame.
- The main app's CSP stays exactly as in `securityHeaders` of `server/src/app.ts` (`style-src 'self'`; no inline `<style>`, no `style="..."` attribute strings; CSSOM writes are fine). Only `/frame/*` responses differ.
- `/frame/*` response headers: `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'` and `Access-Control-Allow-Origin: *`, plus the other existing security headers unchanged. No `'unsafe-eval'`. An unknown path under `/frame` (including `/frame` and `/frame/`) is a 404 JSON `{ "error": "not_found" }`, never the SPA shell.
- The iframe is `<iframe sandbox="allow-scripts" src="/frame/frame.html">`: no `allow-same-origin`. It is created on the first diagram, hidden with the CSS class `diagram-frame` (`visibility: hidden`, off-screen, fixed size; never `display: none`).
- Protocol (all after the handshake on a `MessageChannel`): parent posts `{ type: 'inked-diagram-connect', theme }` with `port2` transferred, target origin `'*'`; the frame accepts only the first such message with `event.source === window.parent` and one port, and replies `{ type: 'ready' }`. Requests `{ type: 'render', id, source }`; replies `{ type: 'result', id, ok: true, svg }` or `{ type: 'result', id, ok: false, reason: 'oversized' | 'syntax' | 'load', message? }`. Both sides validate every message with a type guard and ignore the rest. The parent treats the SVG as untrusted.
- Timeouts: no `ready` within 15 s is a load failure; no result within 30 s is `timeout` and the parent removes the iframe and makes a new one on the next request. `load` and `timeout` results are never cached.
- Mermaid config in the frame: `startOnLoad: false`, `securityLevel: 'strict'`, `theme: 'base'`, `themeVariables` from the connect message, `maxTextSize` 20 000, `maxEdges` 200, `htmlLabels: false` and `flowchart.htmlLabels: false`, and `secure` extended with `theme`, `themeCSS`, `themeVariables`, `fontFamily`. Public Sans 400, 500 and 600 are loaded (3 s cap) before the first render.
- SVG sanitizer (parent): removes `script`, `foreignObject`, event attributes and any `href` / `xlink:href` that is not a same-document fragment (`#...`). CSS: no `@import`, no `url()` except `url(#fragment)`. The note sanitizer `sanitizeHtml` is unchanged.
- `markdown-it` gets no mermaid rule. The fence stays `pre > code.language-mermaid`. `renderUntrustedMarkdown` output (Ask answers) is never hydrated.
- Cache: in memory only, keyed by trimmed source, at most 50 entries. `clearDiagrams()` empties it and removes the iframe, and is called from `enterUnlocked` and `dropKeys` in `web/src/state/store.ts` next to `this.images.clear()`.
- Failure notes (text exact): "Diagram too large to draw.", "Diagram error" (plus ": <first error line>" when there is one), "Could not load the diagram renderer.", "Diagram took too long to draw." Wrapper: `<figure class="diagram" role="img" aria-label="Diagram" or the SVG title>`.
- Setting: diagrams are optional. `prefs.diagrams()` (localStorage key `inked.diagrams`; on unless the value is `'off'`, and on when storage is unavailable) is switched by a "Diagrams" card on the Settings page, per browser and never sent to the server. When off, the hook draws nothing, creates no iframe and makes no request to `/frame/`; each mermaid block stays a code block with the note "Diagrams are off. Turn them on in Settings."; turning it off calls `clearDiagrams()`.
- Out of scope: export, zoom and pan, editor live preview, clickable nodes, ASCII auto-detection, a light theme, a persistent cache, syncing the setting across devices, the `inked-notes` skill in the plugin repo.
- Commits: conventional commit subject, and end every commit message with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Branch: `feat/mermaid-diagrams` (already created).

## Review Focus

Failure modes the spec implies that no single feature task would otherwise pin. Each has a test in the task that owns the code.

1. **The frame's relaxed CSP leaking to the app.** `/frame` and unknown `/frame/...` paths must be 404 JSON, never the SPA shell under the frame CSP, and the app's own responses must keep the strict CSP and carry no CORS header. Task 1.
2. **A hung or crashed frame.** A render with no reply times out, the iframe is replaced, every pending request fails cleanly, and the next view retries instead of caching the failure. Task 3 and Task 7.
3. **Lock or sign-out leaving diagram text or the iframe alive.** The cache is emptied and the iframe removed in both places the store drops keys. Task 7 and Task 8.
4. **A hostile or oversized reply from the frame** (script, `foreignObject`, external `href`, a multi-MB SVG, malformed messages). The parent ignores bad messages, caps the SVG size, and sanitizes. Task 3 and Task 5.
5. **A note's `%%{init: {...}}%%` directive overriding the look or injecting CSS.** The frame's `secure` list blocks it. Task 2 pins the list; Task 4 and Task 11 check it in a real browser.
6. **The setting off but something still loading.** With diagrams off there must be no iframe and no request to `/frame/`, and turning the setting off must remove an iframe that already exists. Task 8 (hook) and Task 9 (card).

---

## File Structure

| File | Responsibility |
|---|---|
| `server/src/app.ts` (modify) | `/frame/*` headers and 404 rule. |
| `web/frame.html`, `web/vite.frame.config.ts` (create), `web/package.json`, `web/vite.config.ts`, `web/tsconfig.node.json` (modify) | The frame's own build and dev proxy. |
| `web/src/diagram-frame/renderer.ts` (create) | Runs in the frame: configure Mermaid, render, map errors. Dependencies injected so it is unit-testable. |
| `web/src/diagram-frame/main.ts` (create) | Runs in the frame: fonts, handshake, message loop. |
| `web/src/diagrams/protocol.ts` (create) | Message types, type guards, shared limits. |
| `web/src/diagrams/frameClient.ts` (create) | Parent: request/response over a port, timeouts, restart. Transport injected. |
| `web/src/diagrams/frameHost.ts` (create) | Parent: create the iframe, hand over the port, wait for `ready`. |
| `web/src/diagrams/svgSanitize.ts` (create) | Pure DOM: Mermaid SVG string to `{ svg, css }` that is safe and CSP-clean. |
| `web/src/diagrams/diagramSheets.ts` (create) | Ref-counted constructed stylesheets. |
| `web/src/diagrams/theme.ts` (create) | Read the CSS variables into the theme object sent to the frame. |
| `web/src/diagrams/diagramRender.ts` (create) | Parent API: `renderDiagram`, `peekDiagram`, `clearDiagrams`; cache. |
| `web/src/diagrams/useDiagrams.ts` (create) | View hook. |
| `web/src/pages/NotePane.tsx`, `NodePreview.tsx`, `web/src/state/store.ts`, `web/src/styles/note.css` (modify) | Wiring, lock clearing, styles. |
| `web/src/lib/prefs.ts` (modify), `web/src/pages/SettingsDiagrams.tsx` (create), `web/src/pages/SettingsPage.tsx` (modify) | The per-browser on/off setting and its Settings card. |
| `docs/architecture.md`, `docs/mcp.md`, `docs/deploy.md` (modify) | Docs. |

---

### Task 1: Server: `/frame/*` headers

**Files:**
- Modify: `server/src/app.ts` (header function near `securityHeaders` ~line 41; `isModelsPath` ~line 76; the `onSend` hook ~line 143; `setNotFoundHandler` ~line 219)
- Test: `server/test/http.test.ts` (new `describe` after `'SPA hosting'`)

**Interfaces:**
- Consumes: nothing.
- Produces: every response whose normalized path is `/frame` or starts with `/frame/` carries the frame CSP and `access-control-allow-origin: *`; unknown such paths return 404 `{ error: 'not_found' }`.

- [ ] **Step 1: Write the failing tests**

Add to `server/test/http.test.ts`, after the `describe('SPA hosting', ...)` block:

```ts
describe('diagram frame hosting', () => {
  const FRAME_CSP =
    "sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";

  function makeFrameDist() {
    const dir = mkdtempSync(path.join(tmpdir(), 'inked-web-'));
    mkdirSync(path.join(dir, 'assets'));
    mkdirSync(path.join(dir, 'frame', 'assets'), { recursive: true });
    writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Inked</title>');
    writeFileSync(path.join(dir, 'frame', 'frame.html'), '<!doctype html><title>Diagram renderer</title>');
    writeFileSync(path.join(dir, 'frame', 'assets', 'frame-abc123.js'), 'console.log(2)');
    return dir;
  }

  it('serves the frame page and its assets with their own CSP and CORS', async () => {
    webDist = makeFrameDist();
    t = await makeApp({ webDist });

    const page = await t.app.inject({ method: 'GET', url: '/frame/frame.html' });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('Diagram renderer');
    expect(page.headers['content-security-policy']).toBe(FRAME_CSP);
    expect(page.headers['access-control-allow-origin']).toBe('*');
    expect(page.headers['x-content-type-options']).toBe('nosniff');
    expect(page.headers['cache-control']).toBe('no-cache');

    const js = await t.app.inject({ method: 'GET', url: '/frame/assets/frame-abc123.js' });
    expect(js.statusCode).toBe(200);
    expect(js.headers['content-security-policy']).toBe(FRAME_CSP);
    expect(js.headers['access-control-allow-origin']).toBe('*');
    expect(js.headers['cache-control']).toContain('immutable');
  });

  it('leaves the app and the API on the strict CSP with no CORS header', async () => {
    webDist = makeFrameDist();
    t = await makeApp({ webDist });
    for (const url of ['/', '/v/123/n/456', '/assets/none.js', '/api/status', '/api/nope']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.headers).toMatchObject(EXPECTED_HEADERS);
      expect(res.headers['access-control-allow-origin']).toBeUndefined();
    }
  });

  it('never answers an unknown /frame path with the SPA shell', async () => {
    webDist = makeFrameDist();
    t = await makeApp({ webDist });
    for (const url of ['/frame', '/frame/', '/frame/nope.html', '/frame/assets/missing.js']) {
      const res = await t.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toEqual({ error: 'not_found' });
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w server -- test/http.test.ts`
Expected: the three new tests FAIL (the frame page has the app CSP; unknown `/frame` paths return the SPA shell with status 200).

- [ ] **Step 3: Implement**

In `server/src/app.ts`, after `securityHeaders`:

```ts
/** The diagram renderer page: inline styles allowed, no network, always sandboxed, framed only by this origin. */
function frameHeaders(base: Record<string, string>): Record<string, string> {
  return {
    ...base,
    'content-security-policy':
      "sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
      "font-src 'self'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; " +
      "form-action 'none'; frame-ancestors 'self'",
    // A sandboxed document has an opaque origin, so its module scripts and fonts are CORS requests.
    // Everything under /frame is public static code and fonts.
    'access-control-allow-origin': '*',
  };
}
```

After `isModelsPath`:

```ts
const isFramePath = (url: string) => {
  const p = routedPathname(url);
  return p === '/frame' || p.startsWith('/frame/');
};
```

In `buildApp`, next to `const headers = securityHeaders(llmOrigins);`:

```ts
  const frameHdrs = frameHeaders(headers);
```

In the `onSend` hook, replace `reply.headers(headers);` with:

```ts
    reply.headers(isFramePath(request.url) ? frameHdrs : headers);
```

In `setNotFoundHandler`, replace the models line with:

```ts
    // A missing model or frame file is a plain 404, never the SPA shell.
    if (isModelsPath(request.url) || isFramePath(request.url)) return reply.code(404).send({ error: 'not_found' });
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w server -- test/http.test.ts`
Expected: PASS, including every pre-existing test in the file.
Run: `npm run build -w server`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/app.ts server/test/http.test.ts
git commit -m "feat(server): serve /frame with its own CSP and CORS

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 2: The frame app (renderer, bootstrap, build)

**Files:**
- Create: `web/src/diagrams/protocol.ts` (the whole file, see Interfaces), `web/src/diagram-frame/renderer.ts`, `web/src/diagram-frame/main.ts`, `web/frame.html`, `web/vite.frame.config.ts`
- Modify: `web/package.json` (build script), `web/vite.config.ts` (dev proxy), `web/tsconfig.node.json` (include the new config)
- Test: `web/src/diagram-frame/renderer.test.ts`, `web/src/diagrams/protocol.test.ts`

**Interfaces:**
- Consumes: the `mermaid` package.
- Produces (all in `web/src/diagrams/protocol.ts`, the whole file is written in this task):
  - `CONNECT = 'inked-diagram-connect'`, `MAX_TEXT_SIZE = 20_000`, `MAX_SVG_SIZE = 2_000_000`
  - `type DiagramTheme = Record<string, string | boolean>`
  - `type FailReason = 'oversized' | 'syntax' | 'load'`
  - `type RenderResult = { type: 'result'; id: string; ok: true; svg: string } | { type: 'result'; id: string; ok: false; reason: FailReason; message?: string }`
  - `type RenderRequest = { type: 'render'; id: string; source: string }`; `type ConnectMessage = { type: typeof CONNECT; theme: DiagramTheme }`; `type ReadyMessage = { type: 'ready' }`
  - guards `isConnectMessage`, `isReadyMessage`, `isRenderRequest`, `isRenderResult` (each `(v: unknown) => v is ...`)
  - `createRenderer(deps: { theme: DiagramTheme; loadMermaid: () => Promise<MermaidApi>; loadFonts: () => Promise<void> }): { render(id: string, source: string): Promise<RenderResult> }` and `MAX_EDGES = 200`, in `renderer.ts`.

- [ ] **Step 1: Write the failing protocol tests**

`web/src/diagrams/protocol.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CONNECT, isConnectMessage, isReadyMessage, isRenderRequest, isRenderResult } from './protocol';

describe('protocol guards', () => {
  it('accepts well-formed messages', () => {
    expect(isConnectMessage({ type: CONNECT, theme: { darkMode: true } })).toBe(true);
    expect(isReadyMessage({ type: 'ready' })).toBe(true);
    expect(isRenderRequest({ type: 'render', id: 'a', source: 'graph TD' })).toBe(true);
    expect(isRenderResult({ type: 'result', id: 'a', ok: true, svg: '<svg/>' })).toBe(true);
    expect(isRenderResult({ type: 'result', id: 'a', ok: false, reason: 'syntax' })).toBe(true);
    expect(isRenderResult({ type: 'result', id: 'a', ok: false, reason: 'load', message: 'x' })).toBe(true);
  });

  it.each([null, undefined, 'ready', 5, [], {}])('rejects %j everywhere', (v) => {
    expect(isConnectMessage(v)).toBe(false);
    expect(isReadyMessage(v)).toBe(false);
    expect(isRenderRequest(v)).toBe(false);
    expect(isRenderResult(v)).toBe(false);
  });

  it('rejects wrong shapes', () => {
    expect(isConnectMessage({ type: CONNECT })).toBe(false);
    expect(isConnectMessage({ type: CONNECT, theme: 'dark' })).toBe(false);
    expect(isRenderRequest({ type: 'render', id: 1, source: 'x' })).toBe(false);
    expect(isRenderRequest({ type: 'render', id: 'a' })).toBe(false);
    expect(isRenderResult({ type: 'result', id: 'a', ok: true })).toBe(false);
    expect(isRenderResult({ type: 'result', id: 'a', ok: true, svg: 5 })).toBe(false);
    expect(isRenderResult({ type: 'result', id: 'a', ok: false, reason: 'timeout' })).toBe(false);
    expect(isRenderResult({ type: 'result', id: 'a', ok: false, reason: 'syntax', message: 5 })).toBe(false);
    expect(isRenderResult({ type: 'result', ok: true, svg: '' })).toBe(false);
  });
});
```

- [ ] **Step 2: Write the failing renderer tests**

`web/src/diagram-frame/renderer.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { createRenderer } from './renderer';

const THEME = { darkMode: true, primaryColor: '#24222c' };

function make(overrides: { render?: ReturnType<typeof vi.fn>; initialize?: ReturnType<typeof vi.fn> } = {}) {
  const calls: string[] = [];
  const initialize = overrides.initialize ?? vi.fn(() => void calls.push('initialize'));
  const render = overrides.render ?? vi.fn(async (id: string) => ({ svg: `<svg id="${id}"></svg>` }));
  const mermaid = { initialize, render } as never; // only these two members are used
  const loadMermaid = vi.fn(async () => mermaid);
  const loadFonts = vi.fn(async () => void calls.push('fonts'));
  const renderer = createRenderer({ theme: THEME, loadMermaid, loadFonts });
  return { renderer, initialize, render, loadMermaid, loadFonts, calls };
}

describe('createRenderer', () => {
  it('renders and returns the svg under the same id', async () => {
    const { renderer, render } = make();
    const r = await renderer.render('inked-dg-1', ' graph TD; A-->B \n');
    expect(r).toEqual({ type: 'result', id: 'inked-dg-1', ok: true, svg: '<svg id="inked-dg-1"></svg>' });
    expect(render).toHaveBeenCalledWith('inked-dg-1', 'graph TD; A-->B');
  });

  it('loads fonts before Mermaid is configured, and configures once', async () => {
    const { renderer, initialize, loadMermaid, calls } = make();
    await renderer.render('a', 'graph TD; A-->B');
    await renderer.render('b', 'graph TD; B-->C');
    expect(calls).toEqual(['fonts', 'initialize']);
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(loadMermaid).toHaveBeenCalledTimes(1);
  });

  it('configures Mermaid strict, with our limits, the sent theme and a locked secure list', async () => {
    const { renderer, initialize } = make();
    await renderer.render('a', 'graph TD; A-->B');
    const cfg = initialize.mock.calls[0][0];
    expect(cfg).toMatchObject({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      themeVariables: THEME,
      htmlLabels: false,
      maxTextSize: 20000,
      maxEdges: 200,
      flowchart: { htmlLabels: false },
    });
    // A note's %%{init}%% directive may not change the theme or inject css.
    expect(cfg.secure).toEqual(
      expect.arrayContaining(['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'theme', 'themeCSS', 'themeVariables', 'fontFamily']),
    );
    expect(typeof cfg.themeCSS).toBe('string');
  });

  it('refuses an oversized source without loading anything', async () => {
    const { renderer, loadMermaid, render } = make();
    const r = await renderer.render('a', `graph TD;\n${'A-->B;\n'.repeat(5000)}`);
    expect(r).toEqual({ type: 'result', id: 'a', ok: false, reason: 'oversized' });
    expect(loadMermaid).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
  });

  it('maps a parse error to syntax with the first line only', async () => {
    const render = vi.fn().mockRejectedValue(new Error('Parse error on line 2:\n...A--\n-----^\nExpecting X'));
    const { renderer } = make({ render });
    const r = await renderer.render('a', 'graph TD\nA--');
    expect(r).toEqual({ type: 'result', id: 'a', ok: false, reason: 'syntax', message: 'Parse error on line 2:' });
  });

  it('maps an edge-limit error to oversized', async () => {
    const render = vi.fn().mockRejectedValue(new Error('Edge limit exceeded. 201 edges found, but the limit is 200.'));
    const { renderer } = make({ render });
    const r = await renderer.render('a', 'graph TD; A-->B');
    expect(r).toMatchObject({ ok: false, reason: 'oversized' });
  });

  it('reports a load failure and retries on the next render', async () => {
    const initialize = vi.fn();
    initialize.mockImplementationOnce(() => {
      throw new Error('chunk failed');
    });
    const { renderer } = make({ initialize });
    expect(await renderer.render('a', 'graph TD; A-->B')).toEqual({ type: 'result', id: 'a', ok: false, reason: 'load' });
    const again = await renderer.render('b', 'graph TD; A-->B');
    expect(again.ok).toBe(true);
  });

  it('removes the temporary node Mermaid leaves behind on an error', async () => {
    const render = vi.fn(async (id: string) => {
      const leftover = document.createElement('div');
      leftover.id = `d${id}`;
      document.body.append(leftover);
      throw new Error('boom');
    });
    const { renderer } = make({ render });
    await renderer.render('inked-dg-7', 'graph TD; A-->B');
    expect(document.getElementById('dinked-dg-7')).toBeNull();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w web -- src/diagrams/protocol.test.ts src/diagram-frame/renderer.test.ts`
Expected: FAIL (cannot resolve `./protocol` and `./renderer`).

- [ ] **Step 4: Implement the protocol**

`web/src/diagrams/protocol.ts`:

```ts
/** Messages between the note view and the sandboxed diagram frame. Both sides validate everything they receive. */

export const CONNECT = 'inked-diagram-connect';
export const MAX_TEXT_SIZE = 20_000;
export const MAX_SVG_SIZE = 2_000_000;

/** Mermaid theme variables: literal colors, a font family and size, never var(). */
export type DiagramTheme = Record<string, string | boolean>;

export type FailReason = 'oversized' | 'syntax' | 'load';

export interface ConnectMessage {
  type: typeof CONNECT;
  theme: DiagramTheme;
}
export interface ReadyMessage {
  type: 'ready';
}
export interface RenderRequest {
  type: 'render';
  id: string;
  source: string;
}
export type RenderResult =
  | { type: 'result'; id: string; ok: true; svg: string }
  | { type: 'result'; id: string; ok: false; reason: FailReason; message?: string };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function isConnectMessage(v: unknown): v is ConnectMessage {
  return isObject(v) && v.type === CONNECT && isObject(v.theme);
}

export function isReadyMessage(v: unknown): v is ReadyMessage {
  return isObject(v) && v.type === 'ready';
}

export function isRenderRequest(v: unknown): v is RenderRequest {
  return isObject(v) && v.type === 'render' && typeof v.id === 'string' && typeof v.source === 'string';
}

export function isRenderResult(v: unknown): v is RenderResult {
  if (!isObject(v) || v.type !== 'result' || typeof v.id !== 'string') return false;
  if (v.ok === true) return typeof v.svg === 'string';
  return (
    v.ok === false &&
    (v.reason === 'oversized' || v.reason === 'syntax' || v.reason === 'load') &&
    (v.message === undefined || typeof v.message === 'string')
  );
}
```

- [ ] **Step 5: Implement the renderer**

`web/src/diagram-frame/renderer.ts`:

```ts
import { MAX_TEXT_SIZE, type DiagramTheme, type RenderResult } from '../diagrams/protocol';

export const MAX_EDGES = 200;

type MermaidApi = typeof import('mermaid').default;

export interface RendererDeps {
  theme: DiagramTheme;
  loadMermaid: () => Promise<MermaidApi>;
  loadFonts: () => Promise<void>;
}

const THEME_CSS = `
  .node rect, .node polygon { rx: 6px; ry: 6px; }
  .cluster rect { rx: 8px; ry: 8px; }
  .flowchart-link, .messageLine0, .messageLine1 { stroke-width: 1.5px; }
`;

function firstLine(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.split('\n')[0].trim().slice(0, 120);
}

/** Runs inside the sandboxed frame, where inline styles are allowed so Mermaid can measure text correctly. */
export function createRenderer(deps: RendererDeps) {
  let ready: Promise<MermaidApi> | null = null;

  function prepare(): Promise<MermaidApi> {
    if (!ready) {
      ready = (async () => {
        // Fonts first, so text is measured in the font the main page will show.
        const [mermaid] = await Promise.all([deps.loadMermaid(), deps.loadFonts()]);
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: 'base',
          themeVariables: deps.theme,
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
      })();
      // A failed load is not kept: the next render tries again.
      ready.catch(() => {
        ready = null;
      });
    }
    return ready;
  }

  return {
    async render(id: string, source: string): Promise<RenderResult> {
      const text = source.trim();
      if (text.length > MAX_TEXT_SIZE) return { type: 'result', id, ok: false, reason: 'oversized' };
      let mermaid: MermaidApi;
      try {
        mermaid = await prepare();
      } catch {
        return { type: 'result', id, ok: false, reason: 'load' };
      }
      try {
        const { svg } = await mermaid.render(id, text);
        return { type: 'result', id, ok: true, svg };
      } catch (e) {
        const message = firstLine(e);
        return { type: 'result', id, ok: false, reason: /edge/i.test(message) ? 'oversized' : 'syntax', message };
      } finally {
        // Mermaid can leave its measuring node in <body> after an error.
        document.getElementById(`d${id}`)?.remove();
      }
    },
  };
}
```

- [ ] **Step 6: Implement the frame bootstrap and page**

`web/src/diagram-frame/main.ts`:

```ts
import '@fontsource/public-sans/400.css';
import '@fontsource/public-sans/500.css';
import '@fontsource/public-sans/600.css';
import { isConnectMessage, isRenderRequest } from '../diagrams/protocol';
import { createRenderer } from './renderer';

async function loadFonts(): Promise<void> {
  const faces = ['400 14px "Public Sans"', '500 14px "Public Sans"', '600 14px "Public Sans"'];
  // Best effort: a font that is slow or missing must not block drawing.
  await Promise.race([Promise.all(faces.map((f) => document.fonts.load(f))), new Promise((r) => setTimeout(r, 3000))]);
}

let connected = false;
window.addEventListener('message', (e: MessageEvent) => {
  // Only the embedding page may connect, once, and it must hand over exactly one port.
  if (connected || e.source !== window.parent || !isConnectMessage(e.data) || e.ports.length !== 1) return;
  connected = true;
  const port = e.ports[0];
  const renderer = createRenderer({
    theme: e.data.theme,
    loadMermaid: () => import('mermaid').then((m) => m.default),
    loadFonts,
  });
  port.onmessage = (m: MessageEvent) => {
    if (!isRenderRequest(m.data)) return;
    void renderer.render(m.data.id, m.data.source).then((result) => port.postMessage(result));
  };
  port.postMessage({ type: 'ready' });
});
```

`web/frame.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="referrer" content="no-referrer" />
    <title>Diagram renderer</title>
  </head>
  <body>
    <script type="module" src="/src/diagram-frame/main.ts"></script>
  </body>
</html>
```

`web/vite.frame.config.ts`:

```ts
import { defineConfig } from 'vite';

// The sandboxed diagram renderer: its own build, served by the server under /frame/ with its own CSP.
export default defineConfig({
  base: '/frame/',
  publicDir: false, // the main build's public/ (semantic model files) must not be copied here
  build: {
    outDir: 'dist/frame',
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
    rollupOptions: { input: 'frame.html' },
  },
});
```

In `web/package.json` change the build script (the frame build must run after the main build, which empties `dist`) and add a frame-only script:

```json
    "build": "tsc -b && vite build && vite build -c vite.frame.config.ts",
    "build:frame": "vite build -c vite.frame.config.ts",
```

In `web/vite.config.ts` add to `server.proxy`:

```ts
      '/frame': { target: 'http://localhost:8080', changeOrigin: false },
```

In `web/tsconfig.node.json`, add `"vite.frame.config.ts"` to `include` next to `vite.config.ts`.

- [ ] **Step 7: Run the tests, type-check and build**

Run: `npm test -w web -- src/diagrams/protocol.test.ts src/diagram-frame/renderer.test.ts`
Expected: PASS. If a test fails because Mermaid's real option names differ from the ones above, run `npx tsc -b` in `web`, read the type error, and fix the config while keeping the test's intent.
Run: `npm run build -w web`
Expected: PASS. Then check:

```bash
ls web/dist/frame web/dist/frame/assets | head -30
grep -c "mermaid" web/dist/index.html
grep -o 'src="[^"]*"' web/dist/frame/frame.html
```

Expected: `web/dist/frame/frame.html` exists with a `/frame/assets/...js` script; `web/dist/frame` holds no `models` folder; `dist/index.html` mentions no mermaid asset (count 0).

- [ ] **Step 8: Commit**

```bash
git add web/src/diagrams/protocol.ts web/src/diagrams/protocol.test.ts web/src/diagram-frame web/frame.html web/vite.frame.config.ts web/package.json web/vite.config.ts web/tsconfig.node.json
git commit -m "feat(web): sandboxed Mermaid renderer frame and its build

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Parent side: frame client and frame host

**Files:**
- Create: `web/src/diagrams/frameClient.ts`, `web/src/diagrams/frameHost.ts`
- Test: `web/src/diagrams/frameClient.test.ts`

**Interfaces:**
- Consumes: `protocol.ts` from Task 2 (`isRenderResult`, `isReadyMessage`, `CONNECT`, `MAX_SVG_SIZE`, `DiagramTheme`, `FailReason`, `RenderRequest`).
- Produces:
  - `interface FrameConnection { port: MessagePort; dispose(): void }`
  - `type FrameOutcome = { ok: true; svg: string } | { ok: false; reason: FailReason | 'timeout'; message?: string }`
  - `interface FrameClient { render(id: string, source: string): Promise<FrameOutcome>; reset(): void }`
  - `createFrameClient(connect: () => Promise<FrameConnection>, opts?: { renderTimeoutMs?: number }): FrameClient` (default timeout 30 000 ms)
  - `connectFrame(theme: DiagramTheme): Promise<FrameConnection>` (creates the iframe, resolves on `ready`, rejects after 15 s)

- [ ] **Step 1: Write the failing tests**

`web/src/diagrams/frameClient.test.ts` (runs in Node, where `MessageChannel` is a global; the test plays the frame on one end of a real channel):

```ts
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFrameClient, type FrameConnection } from './frameClient';
import { MAX_SVG_SIZE } from './protocol';

const tick = () => new Promise<void>((r) => setImmediate(r));
async function until(cond: () => boolean) {
  for (let i = 0; i < 100 && !cond(); i++) await tick();
  expect(cond()).toBe(true);
}

interface Fake {
  conn: FrameConnection;
  frame: MessagePort;
  seen: Array<{ type: string; id: string; source: string }>;
  dispose: ReturnType<typeof vi.fn>;
}

function fakeFrame(): Fake {
  const ch = new MessageChannel();
  const seen: Fake['seen'] = [];
  ch.port2.onmessage = (e) => seen.push(e.data);
  const dispose = vi.fn(() => {
    ch.port1.close();
    ch.port2.close();
  });
  return { conn: { port: ch.port1, dispose }, frame: ch.port2, seen, dispose };
}

beforeEach(() => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }));
afterEach(() => vi.useRealTimers());

describe('createFrameClient', () => {
  it('sends a render request and resolves with the svg', async () => {
    const f = fakeFrame();
    const client = createFrameClient(async () => f.conn);
    const p = client.render('inked-dg-1', 'graph TD; A-->B');
    await until(() => f.seen.length === 1);
    expect(f.seen[0]).toEqual({ type: 'render', id: 'inked-dg-1', source: 'graph TD; A-->B' });
    f.frame.postMessage({ type: 'result', id: 'inked-dg-1', ok: true, svg: '<svg/>' });
    expect(await p).toEqual({ ok: true, svg: '<svg/>' });
    client.reset();
  });

  it('maps a failure result', async () => {
    const f = fakeFrame();
    const client = createFrameClient(async () => f.conn);
    const p = client.render('a', 'x');
    await until(() => f.seen.length === 1);
    f.frame.postMessage({ type: 'result', id: 'a', ok: false, reason: 'syntax', message: 'Parse error on line 2:' });
    expect(await p).toEqual({ ok: false, reason: 'syntax', message: 'Parse error on line 2:' });
    client.reset();
  });

  it('ignores malformed messages and results for unknown ids', async () => {
    const f = fakeFrame();
    const client = createFrameClient(async () => f.conn);
    const p = client.render('a', 'x');
    await until(() => f.seen.length === 1);
    f.frame.postMessage('garbage');
    f.frame.postMessage({ type: 'result', id: 'zzz', ok: true, svg: '<svg/>' });
    f.frame.postMessage({ type: 'result', id: 'a', ok: true, svg: 5 });
    f.frame.postMessage({ type: 'result', id: 'a', ok: true, svg: '<svg id="real"/>' });
    expect(await p).toEqual({ ok: true, svg: '<svg id="real"/>' });
    client.reset();
  });

  it('turns an svg over the size cap into oversized', async () => {
    const f = fakeFrame();
    const client = createFrameClient(async () => f.conn);
    const p = client.render('a', 'x');
    await until(() => f.seen.length === 1);
    f.frame.postMessage({ type: 'result', id: 'a', ok: true, svg: 'x'.repeat(MAX_SVG_SIZE + 1) });
    expect(await p).toEqual({ ok: false, reason: 'oversized' });
    client.reset();
  });

  it('shares one connection between concurrent renders', async () => {
    const f = fakeFrame();
    const connect = vi.fn(async () => f.conn);
    const client = createFrameClient(connect);
    const p1 = client.render('a', 'x');
    const p2 = client.render('b', 'y');
    await until(() => f.seen.length === 2);
    expect(connect).toHaveBeenCalledTimes(1);
    f.frame.postMessage({ type: 'result', id: 'b', ok: true, svg: '<svg id="b"/>' });
    f.frame.postMessage({ type: 'result', id: 'a', ok: true, svg: '<svg id="a"/>' });
    expect(await p1).toEqual({ ok: true, svg: '<svg id="a"/>' });
    expect(await p2).toEqual({ ok: true, svg: '<svg id="b"/>' });
    client.reset();
  });

  it('reports a failed connect as load and tries again on the next render', async () => {
    const f = fakeFrame();
    const connect = vi.fn<() => Promise<FrameConnection>>().mockRejectedValueOnce(new Error('no ready')).mockResolvedValue(f.conn);
    const client = createFrameClient(connect);
    expect(await client.render('a', 'x')).toEqual({ ok: false, reason: 'load' });
    const p = client.render('b', 'x');
    await until(() => f.seen.length === 1);
    f.frame.postMessage({ type: 'result', id: 'b', ok: true, svg: '<svg/>' });
    expect((await p).ok).toBe(true);
    expect(connect).toHaveBeenCalledTimes(2);
    client.reset();
  });

  it('times out, removes the frame, fails every pending request and reconnects next time', async () => {
    const first = fakeFrame();
    const second = fakeFrame();
    const connect = vi.fn<() => Promise<FrameConnection>>().mockResolvedValueOnce(first.conn).mockResolvedValue(second.conn);
    const client = createFrameClient(connect, { renderTimeoutMs: 1000 });
    const p1 = client.render('a', 'x');
    const p2 = client.render('b', 'y');
    await until(() => first.seen.length === 2);
    vi.advanceTimersByTime(1000);
    expect(await p1).toEqual({ ok: false, reason: 'timeout' });
    expect(await p2).toEqual({ ok: false, reason: 'timeout' });
    expect(first.dispose).toHaveBeenCalledTimes(1);
    const p3 = client.render('c', 'z');
    await until(() => second.seen.length === 1);
    expect(connect).toHaveBeenCalledTimes(2);
    second.frame.postMessage({ type: 'result', id: 'c', ok: true, svg: '<svg/>' });
    expect((await p3).ok).toBe(true);
    client.reset();
  });

  it('does not time out a request that was answered', async () => {
    const f = fakeFrame();
    const client = createFrameClient(async () => f.conn, { renderTimeoutMs: 1000 });
    const p = client.render('a', 'x');
    await until(() => f.seen.length === 1);
    f.frame.postMessage({ type: 'result', id: 'a', ok: true, svg: '<svg/>' });
    await p;
    vi.advanceTimersByTime(5000);
    expect(f.dispose).not.toHaveBeenCalled();
    client.reset();
  });

  it('reset removes the frame, fails pending requests as load and reconnects next time', async () => {
    const first = fakeFrame();
    const second = fakeFrame();
    const connect = vi.fn<() => Promise<FrameConnection>>().mockResolvedValueOnce(first.conn).mockResolvedValue(second.conn);
    const client = createFrameClient(connect);
    const p = client.render('a', 'x');
    await until(() => first.seen.length === 1);
    client.reset();
    expect(await p).toEqual({ ok: false, reason: 'load' });
    expect(first.dispose).toHaveBeenCalledTimes(1);
    const p2 = client.render('b', 'x');
    await until(() => second.seen.length === 1);
    expect(connect).toHaveBeenCalledTimes(2);
    second.frame.postMessage({ type: 'result', id: 'b', ok: true, svg: '<svg/>' });
    expect((await p2).ok).toBe(true);
    client.reset();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w web -- src/diagrams/frameClient.test.ts`
Expected: FAIL (cannot resolve `./frameClient`).

- [ ] **Step 3: Implement the client**

`web/src/diagrams/frameClient.ts`:

```ts
import { isRenderResult, MAX_SVG_SIZE, type FailReason, type RenderRequest } from './protocol';

export interface FrameConnection {
  port: MessagePort;
  /** Close the port and remove the frame. */
  dispose(): void;
}

export type FrameOutcome = { ok: true; svg: string } | { ok: false; reason: FailReason | 'timeout'; message?: string };

export interface FrameClient {
  render(id: string, source: string): Promise<FrameOutcome>;
  /** Drop the frame (lock, sign-out). Pending renders fail as `load`; the next render reconnects. */
  reset(): void;
}

/**
 * Talks to the diagram frame over a port. The transport is injected so the request, timeout and restart logic
 * can be tested without a browser. A frame that stops answering is removed, which also kills a runaway script.
 */
export function createFrameClient(connect: () => Promise<FrameConnection>, opts: { renderTimeoutMs?: number } = {}): FrameClient {
  const renderTimeoutMs = opts.renderTimeoutMs ?? 30_000;
  let conn: Promise<FrameConnection> | null = null;
  const pending = new Map<string, (outcome: FrameOutcome) => void>();

  function open(): Promise<FrameConnection> {
    if (!conn) {
      const p = connect().then((c) => {
        c.port.onmessage = (e: MessageEvent) => {
          const d: unknown = e.data;
          if (!isRenderResult(d)) return;
          const settle = pending.get(d.id);
          if (!settle) return;
          if (!d.ok) settle({ ok: false, reason: d.reason, message: d.message });
          else if (d.svg.length > MAX_SVG_SIZE) settle({ ok: false, reason: 'oversized' });
          else settle({ ok: true, svg: d.svg });
        };
        return c;
      });
      conn = p;
      // A failed connect is not kept: the next render tries again.
      p.catch(() => {
        if (conn === p) conn = null;
      });
    }
    return conn;
  }

  function drop(outcome: FrameOutcome): void {
    const c = conn;
    conn = null;
    c?.then(
      (x) => x.dispose(),
      () => undefined,
    );
    for (const settle of Array.from(pending.values())) settle(outcome);
  }

  return {
    render(id, source) {
      return new Promise<FrameOutcome>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (outcome: FrameOutcome) => {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          resolve(outcome);
        };
        pending.set(id, settle);
        open().then(
          (c) => {
            if (!pending.has(id)) return; // settled while connecting
            timer = setTimeout(() => drop({ ok: false, reason: 'timeout' }), renderTimeoutMs);
            c.port.postMessage({ type: 'render', id, source } satisfies RenderRequest);
          },
          () => settle({ ok: false, reason: 'load' }),
        );
      });
    },
    reset() {
      drop({ ok: false, reason: 'load' });
    },
  };
}
```

- [ ] **Step 4: Implement the host**

`web/src/diagrams/frameHost.ts`:

```ts
import type { FrameConnection } from './frameClient';
import { CONNECT, isReadyMessage, type DiagramTheme } from './protocol';

const FRAME_URL = '/frame/frame.html';
const READY_TIMEOUT_MS = 15_000;

/**
 * Create the sandboxed diagram iframe, hand it one end of a MessageChannel with the theme, and resolve once it
 * says `ready`. The iframe has no `allow-same-origin`, so it cannot reach this page. It is hidden by the
 * `.diagram-frame` class (not display:none: Mermaid measures text and needs real layout).
 */
export function connectFrame(theme: DiagramTheme): Promise<FrameConnection> {
  return new Promise((resolve, reject) => {
    const iframe = document.createElement('iframe');
    iframe.className = 'diagram-frame';
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.setAttribute('title', 'Diagram renderer');
    iframe.setAttribute('aria-hidden', 'true');
    iframe.tabIndex = -1;
    const channel = new MessageChannel();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const dispose = () => {
      clearTimeout(timer);
      channel.port1.close();
      iframe.remove();
    };
    timer = setTimeout(() => {
      dispose();
      reject(new Error('The diagram frame did not become ready'));
    }, READY_TIMEOUT_MS);
    channel.port1.onmessage = (e: MessageEvent) => {
      if (!isReadyMessage(e.data)) return;
      clearTimeout(timer);
      resolve({ port: channel.port1, dispose });
    };
    iframe.addEventListener(
      'load',
      () => {
        // The frame's origin is opaque, so the target origin has to be '*'.
        iframe.contentWindow?.postMessage({ type: CONNECT, theme }, '*', [channel.port2]);
      },
      { once: true },
    );
    iframe.src = FRAME_URL;
    document.body.append(iframe);
  });
}
```

- [ ] **Step 5: Run the tests to verify they pass, then type-check**

Run: `npm test -w web -- src/diagrams/frameClient.test.ts`
Expected: PASS, output pristine.
Run: `npx tsc -b` (in `web`)
Expected: PASS. `frameHost.ts` has no unit test: it needs a real browser and is exercised by Task 4.

- [ ] **Step 6: Commit**

```bash
git add web/src/diagrams/frameClient.ts web/src/diagrams/frameClient.test.ts web/src/diagrams/frameHost.ts
git commit -m "feat(web): frame client and host for the sandboxed renderer

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Gate probe (throwaway): the real frame under the real CSP

This is the gate for the rest of the plan. The probe harness is deleted at the end of the task. Only the recorded result is committed.

**Files:**
- Create then delete: `web/vite.probe.config.ts`, `web/probe/index.html`, `web/probe/probe.css`, `web/probe/probe.ts`, `web/dist-probe/`
- Modify: `docs/superpowers/specs/2026-10-15-mermaid-diagrams-design.md` (append the result)

**Interfaces:**
- Consumes: the real server (Task 1), the built frame (Task 2), `createFrameClient` and `connectFrame` (Task 3).
- Produces: a recorded pass or fail on whether the sandbox design works.

- [ ] **Step 1: Create the probe harness**

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
  <head>
    <meta charset="utf-8" />
    <title>diagram frame probe</title>
    <link rel="stylesheet" href="./probe.css" />
  </head>
  <body>
    <pre id="out"></pre>
    <script type="module" src="./probe.ts"></script>
  </body>
</html>
```

`web/probe/probe.css`:

```css
.diagram-frame {
  position: fixed;
  left: -10000px;
  top: 0;
  width: 1200px;
  height: 800px;
  border: 0;
  visibility: hidden;
  pointer-events: none;
}
```

`web/probe/probe.ts`:

```ts
import { createFrameClient } from '../src/diagrams/frameClient';
import { connectFrame } from '../src/diagrams/frameHost';
import type { DiagramTheme } from '../src/diagrams/protocol';

const violations: string[] = [];
document.addEventListener('securitypolicyviolation', (e) => violations.push(`${e.violatedDirective}: ${e.blockedURI || e.sample}`));

const FLOW = `graph TD
  A[Browser decrypts the note] --> B{Has mermaid fence?}
  B -- yes --> C[Lazy-load the renderer]
  B -- no --> D[Plain Markdown]
  subgraph Server
    E[(Ciphertext only)]
  end
  C --> E
  style A fill:#ff00ff,stroke:#333`;
const DIRECTIVE = `%%{init: {"theme":"forest","themeCSS":".node rect { fill: red !important }"}}%%\n${FLOW}`;

const base = { darkMode: true, background: '#1b1a21', primaryColor: '#24222c', primaryTextColor: '#e6e3ee', primaryBorderColor: '#7452e0', lineColor: '#8d7bc4' };
const small: DiagramTheme = { ...base, fontFamily: "'Public Sans', system-ui, sans-serif", fontSize: '14px' };
const big: DiagramTheme = { ...base, fontFamily: 'monospace', fontSize: '22px' };

const results: Record<string, unknown> = {};

function show(name: string, svg: string) {
  const doc = new DOMParser().parseFromString(`<body>${svg}</body>`, 'text/html');
  const el = doc.body.querySelector('svg') as SVGElement;
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
  host.id = `host-${name}`;
  host.append(live);
  document.body.append(host);
  return { live, css };
}

async function run(name: string, theme: DiagramTheme, source: string) {
  const client = createFrameClient(() => connectFrame(theme));
  const t0 = performance.now();
  const out = await client.render(`p-${name}`, source);
  if (!out.ok) {
    results[name] = { ok: false, reason: out.reason, message: out.message };
    return;
  }
  const { live, css } = show(name, out.svg);
  await new Promise((r) => setTimeout(r, 100));
  const overflow: string[] = [];
  for (const g of Array.from(live.querySelectorAll('g.node'))) {
    const shape = g.querySelector('rect, polygon, path') as SVGGraphicsElement | null;
    const label = g.querySelector('g.label') as SVGGraphicsElement | null;
    if (shape && label && label.getBBox().width > shape.getBBox().width + 1) overflow.push(g.id);
  }
  const plain = live.querySelector('g.node[id*="flowchart-D-"] rect') as Element | null;
  const styled = live.querySelector('g.node[id*="flowchart-A-"] rect') as Element | null;
  results[name] = {
    ok: true,
    ms: Math.round(performance.now() - t0),
    cssBytes: css.length,
    themeFillApplied: plain ? getComputedStyle(plain).fill === 'rgb(36, 34, 44)' : null,
    inlineStyleApplied: styled ? getComputedStyle(styled).fill === 'rgb(255, 0, 255)' : null,
    overflow,
    redInjected: /red\s*!important/.test(out.svg),
  };
}

await run('small', small, FLOW);
await run('big', big, FLOW);
await run('directive', small, DIRECTIVE);
results.mainViolations = violations;
(window as unknown as { __probe: unknown }).__probe = results;
document.getElementById('out')!.textContent = JSON.stringify(results, null, 2);
```

- [ ] **Step 2: Build everything and serve the probe through the real server**

From the repo root:

```bash
npm run build -w web
npm run build -w server
(cd web && npx vite build -c vite.probe.config.ts)
cp -r web/dist/frame web/dist-probe/frame
```

Start the server in the background on a new empty data folder in your scratchpad directory (replace `<repo>` and `<scratch>`):

```bash
WEB_DIST=<repo>/web/dist-probe DATA_DIR=<scratch>/probe-data PORT=8099 npm start -w server
```

Confirm the headers:

```bash
curl -sI http://localhost:8099/ | grep -i content-security-policy
curl -sI http://localhost:8099/frame/frame.html | grep -i -E "content-security-policy|access-control-allow-origin"
```

Expected: the first shows `style-src 'self'` with no `'unsafe-inline'`; the second shows the frame CSP starting `sandbox allow-scripts;` and `access-control-allow-origin: *`.

- [ ] **Step 3: Run the probe in a real browser**

Open `http://localhost:8099/` in the Browser pane (or Playwright). Wait about 5 seconds. Read `window.__probe` and the `#out` text. Take a screenshot and look at the three diagrams (the page may be taller than the screen; scroll).

- [ ] **Step 4: Judge the result**

All of these must hold:

- `small`, `big` and `directive` are all `ok: true` (so the frame loaded from an opaque origin: its module script and fonts passed CORS under the frame CSP, and the handshake worked).
- `big` (22px monospace) has `overflow: []`, and in the screenshot its labels sit inside their boxes. This is the result that failed in revision 1.
- `small` and `big` have `themeFillApplied: true` and `inlineStyleApplied: true`.
- `directive` has `redInjected: false` and `themeFillApplied: true` (the `%%{init}%%` directive was ignored).
- `mainViolations` is `[]` (the parent page logged no CSP violation at all).

If every condition holds, go on. **If any fails, STOP.** Delete the harness (Step 5), record the failing values in the spec, commit that, and report to the user. Do not start Task 5.

- [ ] **Step 5: Stop the server and delete the probe**

Stop the background server. Run:

```bash
rm -rf web/probe web/dist-probe web/vite.probe.config.ts
git status --short
```

Expected: nothing is modified except what the next step adds (and `web/dist` is git-ignored).

- [ ] **Step 6: Record the result in the spec and commit**

Append to the end of `docs/superpowers/specs/2026-10-15-mermaid-diagrams-design.md`:

```markdown
## Probe result, revision 2 (Task 4)

Date and mermaid version: <fill from the run>. The real frame, client and host, served by the real server under the real CSP, showed: the sandboxed frame loads from an opaque origin (script, chunks and fonts pass CORS under the frame CSP) and the handshake completes; layout is correct at 22px monospace (no label overflows its box); the theme fill and a per-node inline style survive the display path; a note's `%%{init}%%` directive is ignored; and the main page logged no CSP violation. The design in this revision is confirmed.
```

Replace `<fill from the run>` with the real date and the output of `npm ls -w web mermaid` before committing.

```bash
git add docs/superpowers/specs/2026-10-15-mermaid-diagrams-design.md
git commit -m "docs: record sandboxed renderer probe result

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 5: SVG sanitizer

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
 * Turn the renderer's SVG string into something the strict CSP allows. The CSP bans inline <style> and style="..."
 * strings, so both are taken out here: the css goes to a constructed stylesheet, and each style attribute is kept
 * as data-inline-style for the mount step to apply through CSSOM. The input is untrusted (it came from another
 * window), so it is also sanitized.
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
git commit -m "feat(web): sanitize and CSP-prepare diagram SVG

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Ref-counted constructed stylesheets

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

### Task 7: Parent API: theme, cache, `renderDiagram`

**Files:**
- Create: `web/src/diagrams/theme.ts`, `web/src/diagrams/diagramRender.ts`
- Test: `web/src/diagrams/theme.test.ts`, `web/src/diagrams/diagramRender.test.ts`

**Interfaces:**
- Consumes: `createFrameClient`, `FrameClient` (Task 3); `connectFrame` (Task 3); `prepareDiagramSvg` (Task 5); `MAX_TEXT_SIZE`, `DiagramTheme` (Task 2).
- Produces:
  - `readDiagramTheme(): DiagramTheme` (in `theme.ts`)
  - `type DiagramResult = { ok: true; id: string; svg: string; css: string } | { ok: false; reason: 'oversized' | 'syntax' | 'load' | 'timeout'; message?: string }`
  - `renderDiagram(source: string): Promise<DiagramResult>`: trims, refuses over 20 000 characters, caches by trimmed source (a `load` or `timeout` result is not cached), same source gives the same `id` (`inked-dg-<n>`).
  - `peekDiagram(source: string): DiagramResult | undefined`: the settled result, if any.
  - `clearDiagrams(): void`: empties the cache and resets the frame client (removing the iframe).

- [ ] **Step 1: Write the failing theme test**

`web/src/diagrams/theme.test.ts`:

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readDiagramTheme } from './theme';

afterEach(() => vi.restoreAllMocks());

describe('readDiagramTheme', () => {
  it('reads colors from the CSS variables and trims them', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({
      getPropertyValue: (name: string) => (name === '--ink' ? ' #123456 ' : ''),
    } as unknown as CSSStyleDeclaration);
    const t = readDiagramTheme();
    expect(t.darkMode).toBe(true);
    expect(t.primaryBorderColor).toBe('#123456');
  });

  it('falls back to the dark token values when a variable is missing', () => {
    vi.spyOn(window, 'getComputedStyle').mockReturnValue({ getPropertyValue: () => '' } as unknown as CSSStyleDeclaration);
    const t = readDiagramTheme();
    expect(t.primaryColor).toBe('#24222c');
    expect(t.primaryTextColor).toBe('#e6e3ee');
    expect(t.fontSize).toBe('14px');
    expect(String(t.fontFamily)).toContain('Public Sans');
    // Mermaid does color maths on these, so none may be a var() reference.
    expect(Object.values(t).filter((v) => typeof v === 'string' && v.includes('var('))).toEqual([]);
  });
});
```

- [ ] **Step 2: Write the failing renderer-API tests**

`web/src/diagrams/diagramRender.test.ts`:

```ts
// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameOutcome } from './frameClient';

const frame = { render: vi.fn<(id: string, source: string) => Promise<FrameOutcome>>(), reset: vi.fn() };
const createFrameClient = vi.fn((_connect: () => Promise<unknown>) => frame);
const connectFrame = vi.fn();
vi.mock('./frameClient', () => ({ createFrameClient: (c: () => Promise<unknown>) => createFrameClient(c) }));
vi.mock('./frameHost', () => ({ connectFrame: (t: unknown) => connectFrame(t) }));
vi.mock('./theme', () => ({ readDiagramTheme: () => ({ darkMode: true, tag: 'theme' }) }));

const OK_SVG =
  '<svg id="inked-dg-1" viewBox="0 0 1 1" xmlns="http://www.w3.org/2000/svg"><style>#inked-dg-1 .n{fill:red}</style><rect class="n"/></svg>';

async function load() {
  vi.resetModules();
  return import('./diagramRender');
}

beforeEach(() => {
  frame.render.mockReset();
  frame.reset.mockReset();
  createFrameClient.mockClear();
  connectFrame.mockReset();
});

describe('renderDiagram', () => {
  it('renders through the frame, sanitizes, and returns the css separately', async () => {
    const mod = await load();
    frame.render.mockResolvedValue({ ok: true, svg: OK_SVG });
    const r = await mod.renderDiagram('  graph TD; A-->B\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.id).toMatch(/^inked-dg-\d+$/);
    expect(r.svg).not.toContain('<style');
    expect(r.css).toContain('.n{fill:red}');
    expect(frame.render).toHaveBeenCalledWith(r.id, 'graph TD; A-->B');
  });

  it('connects the frame lazily, once, with the current theme', async () => {
    const mod = await load();
    expect(createFrameClient).not.toHaveBeenCalled();
    frame.render.mockResolvedValue({ ok: true, svg: OK_SVG });
    await mod.renderDiagram('graph TD; A-->B');
    await mod.renderDiagram('graph TD; B-->C');
    expect(createFrameClient).toHaveBeenCalledTimes(1);
    createFrameClient.mock.calls[0][0]();
    expect(connectFrame).toHaveBeenCalledWith({ darkMode: true, tag: 'theme' });
  });

  it('refuses an oversized source without touching the frame', async () => {
    const mod = await load();
    const r = await mod.renderDiagram(`graph TD;\n${'A-->B;\n'.repeat(5000)}`);
    expect(r).toEqual({ ok: false, reason: 'oversized' });
    expect(frame.render).not.toHaveBeenCalled();
    expect(createFrameClient).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, reason: 'syntax', message: 'Parse error on line 2:' } as const],
    [{ ok: false, reason: 'oversized' } as const],
  ])('passes a frame failure through (%j)', async (outcome) => {
    const mod = await load();
    frame.render.mockResolvedValue(outcome);
    expect(await mod.renderDiagram('graph TD; A-->B')).toEqual(outcome);
  });

  it('treats svg that sanitizes to nothing as a syntax failure', async () => {
    const mod = await load();
    frame.render.mockResolvedValue({ ok: true, svg: '<div>not an svg</div>' });
    expect(await mod.renderDiagram('graph TD; A-->B')).toMatchObject({ ok: false, reason: 'syntax' });
  });

  it('caches by source: one render, same object, and peek sees it once settled', async () => {
    const mod = await load();
    frame.render.mockResolvedValue({ ok: true, svg: OK_SVG });
    expect(mod.peekDiagram('graph TD; A-->B')).toBeUndefined();
    const p = mod.renderDiagram('graph TD; A-->B');
    expect(mod.peekDiagram('graph TD; A-->B')).toBeUndefined();
    const first = await p;
    const second = await mod.renderDiagram('  graph TD; A-->B\n');
    expect(frame.render).toHaveBeenCalledTimes(1);
    expect(second).toBe(first);
    expect(mod.peekDiagram('graph TD; A-->B')).toBe(first);
  });

  it.each(['load', 'timeout'] as const)('does not cache a %s failure, so the next view retries', async (reason) => {
    const mod = await load();
    frame.render.mockResolvedValueOnce({ ok: false, reason });
    expect(await mod.renderDiagram('graph TD; A-->B')).toEqual({ ok: false, reason });
    expect(mod.peekDiagram('graph TD; A-->B')).toBeUndefined();
    frame.render.mockResolvedValueOnce({ ok: true, svg: OK_SVG });
    expect((await mod.renderDiagram('graph TD; A-->B')).ok).toBe(true);
    expect(frame.render).toHaveBeenCalledTimes(2);
  });

  it('keeps at most 50 results', async () => {
    const mod = await load();
    frame.render.mockResolvedValue({ ok: true, svg: OK_SVG });
    for (let i = 0; i < 51; i++) await mod.renderDiagram(`graph TD; A${i}-->B`);
    expect(mod.peekDiagram('graph TD; A0-->B')).toBeUndefined();
    expect(mod.peekDiagram('graph TD; A50-->B')).toBeDefined();
  });

  it('clearDiagrams empties the cache and resets the frame', async () => {
    const mod = await load();
    frame.render.mockResolvedValue({ ok: true, svg: OK_SVG });
    await mod.renderDiagram('graph TD; A-->B');
    mod.clearDiagrams();
    expect(frame.reset).toHaveBeenCalledTimes(1);
    expect(mod.peekDiagram('graph TD; A-->B')).toBeUndefined();
    await mod.renderDiagram('graph TD; A-->B');
    expect(frame.render).toHaveBeenCalledTimes(2);
  });

  it('clearDiagrams before any render is harmless', async () => {
    const mod = await load();
    expect(() => mod.clearDiagrams()).not.toThrow();
    expect(createFrameClient).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm test -w web -- src/diagrams/theme.test.ts src/diagrams/diagramRender.test.ts`
Expected: FAIL (cannot resolve `./theme` and `./diagramRender`).

- [ ] **Step 4: Implement the theme reader**

`web/src/diagrams/theme.ts`:

```ts
import type { DiagramTheme } from './protocol';

function cssVar(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

/**
 * Inked's colors for Mermaid, read from the CSS variables. Mermaid does colour maths on these, so they must be
 * literal colors, not var(). The app is dark-only; if a light theme is added, the cache key must include the theme.
 */
export function readDiagramTheme(): DiagramTheme {
  return {
    darkMode: true,
    background: cssVar('--panel', '#1b1a21'),
    fontFamily: cssVar('--font-ui', "'Public Sans', system-ui, -apple-system, 'Segoe UI', sans-serif"),
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
```

- [ ] **Step 5: Implement the renderer API**

`web/src/diagrams/diagramRender.ts`:

```ts
import { createFrameClient, type FrameClient } from './frameClient';
import { connectFrame } from './frameHost';
import { MAX_TEXT_SIZE } from './protocol';
import { prepareDiagramSvg } from './svgSanitize';
import { readDiagramTheme } from './theme';

const MAX_CACHED = 50;

export type DiagramResult =
  | { ok: true; id: string; svg: string; css: string }
  | { ok: false; reason: 'oversized' | 'syntax' | 'load' | 'timeout'; message?: string };

interface Entry {
  promise: Promise<DiagramResult>;
  value?: DiagramResult;
}

let client: FrameClient | null = null;
let counter = 0;
const cache = new Map<string, Entry>();

function frameClient(): FrameClient {
  client ??= createFrameClient(() => connectFrame(readDiagramTheme()));
  return client;
}

async function draw(text: string): Promise<DiagramResult> {
  // A fresh id per source: Mermaid scopes its css to it, and cached results must never collide on a page.
  const id = `inked-dg-${++counter}`;
  const out = await frameClient().render(id, text);
  if (!out.ok) return { ok: false, reason: out.reason, message: out.message };
  // The frame is another window: its svg is untrusted.
  const prepared = prepareDiagramSvg(out.svg);
  if (!prepared) return { ok: false, reason: 'syntax' };
  return { ok: true, id, ...prepared };
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
    // A load failure or a timeout may be transient: the next view tries again.
    if (!r.ok && (r.reason === 'load' || r.reason === 'timeout')) cache.delete(text);
    else entry.value = r;
  });
  return entry.promise;
}

/** Drop every rendered diagram and the frame. Called when the keys are dropped (lock, sign-out). */
export function clearDiagrams(): void {
  cache.clear();
  client?.reset();
}
```

- [ ] **Step 6: Run the tests to verify they pass, then type-check**

Run: `npm test -w web -- src/diagrams/theme.test.ts src/diagrams/diagramRender.test.ts`
Expected: PASS.
Run: `npx tsc -b` (in `web`)
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/diagrams/theme.ts web/src/diagrams/theme.test.ts web/src/diagrams/diagramRender.ts web/src/diagrams/diagramRender.test.ts
git commit -m "feat(web): diagram render API with cache, theme and clear

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 8: View hook, wiring, lock clearing and styles

**Files:**
- Create: `web/src/diagrams/useDiagrams.ts`
- Test: `web/src/diagrams/useDiagrams.test.tsx`
- Modify: `web/src/pages/NotePane.tsx` (the `useInkedImages(articleRef, vault.id, html);` line, ~178), `web/src/pages/NodePreview.tsx` (~line 37), `web/src/state/store.ts` (`enterUnlocked` ~line 572 and `dropKeys` ~line 590, each right after `this.images.clear();`), `web/src/styles/note.css` (after the `.md pre code` rule, ~line 347)
- Test: `web/src/markdown/render.test.ts` (add one case); the existing store test file for locking (see Step 8)

**Interfaces:**
- Consumes: `renderDiagram`, `peekDiagram`, `clearDiagrams`, `DiagramResult` from `./diagramRender` (Task 7); `adoptDiagramCss` from `./diagramSheets` (Task 6); `prefs.diagrams(): boolean` from `web/src/lib/prefs.ts` (written in Task 9; until then the hook tests exercise it through the real `prefs` and `localStorage`, so Task 8 adds the `prefs.diagrams` method itself, see Step 3a).
- Produces: `useDiagrams(ref: RefObject<HTMLElement | null>, html: string): void`.

- [ ] **Step 1: Write the failing hook tests**

`web/src/diagrams/useDiagrams.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiagramResult } from './diagramRender';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const renderDiagram = vi.fn<(s: string) => Promise<DiagramResult>>();
const peekDiagram = vi.fn<(s: string) => DiagramResult | undefined>();
const adopt = vi.fn();
vi.mock('./diagramRender', () => ({
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
  localStorage.clear();
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
    [{ ok: false, reason: 'timeout' } as const, 'Diagram took too long to draw.'],
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

  it('with diagrams switched off in Settings: no render, no peek, code block kept, note shown', async () => {
    localStorage.setItem('inked.diagrams', 'off');
    const el = await mount(block('graph TD; A-->B') + block('graph TD; B-->C'));
    expect(renderDiagram).not.toHaveBeenCalled();
    expect(peekDiagram).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
    expect(el.querySelectorAll('pre')).toHaveLength(2);
    expect(el.querySelector('figure')).toBeNull();
    const notes = el.querySelectorAll('.diagram-note');
    expect(notes).toHaveLength(2);
    expect(notes[0].textContent).toBe('Diagrams are off. Turn them on in Settings.');
  });

  it('with diagrams switched off, an empty mermaid block gets no note', async () => {
    localStorage.setItem('inked.diagrams', 'off');
    const el = await mount(block(''));
    expect(el.querySelector('.diagram-note')).toBeNull();
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
import { prefs } from '../lib/prefs';
import { peekDiagram, renderDiagram, type DiagramResult } from './diagramRender';
import { adoptDiagramCss } from './diagramSheets';

type Drawn = Extract<DiagramResult, { ok: true }>;
type Failed = Extract<DiagramResult, { ok: false }>;

function failureText(r: Failed): string {
  if (r.reason === 'oversized') return 'Diagram too large to draw.';
  if (r.reason === 'load') return 'Could not load the diagram renderer.';
  if (r.reason === 'timeout') return 'Diagram took too long to draw.';
  return r.message ? `Diagram error: ${r.message}` : 'Diagram error';
}

function addNote(pre: HTMLElement, text: string): void {
  const note = document.createElement('p');
  note.className = 'diagram-note';
  note.setAttribute('role', 'note');
  note.textContent = text;
  pre.after(note);
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
    const enabled = prefs.diagrams();
    const releases: Array<() => void> = [];
    for (const code of Array.from(root.querySelectorAll<HTMLElement>('pre > code.language-mermaid'))) {
      const pre = code.parentElement as HTMLElement;
      const source = code.textContent ?? '';
      if (!source.trim()) continue;
      if (!enabled) {
        // Off in Settings: nothing is loaded and no frame is created.
        addNote(pre, 'Diagrams are off. Turn them on in Settings.');
        continue;
      }
      const show = (r: DiagramResult) => {
        if (!live || !pre.isConnected) return;
        if (r.ok) {
          releases.push(adoptDiagramCss(r.id, r.css));
          pre.replaceWith(figureFor(r));
        } else {
          addNote(pre, failureText(r));
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

- [ ] **Step 3a: Add the preference to `prefs`**

The hook reads the setting, so the preference method lands here (Task 9 adds its tests and the Settings card). In `web/src/lib/prefs.ts`, add a key next to the others:

```ts
const DIAGRAMS_KEY = 'inked.diagrams';
```

and these two members to the `prefs` object, after `setSemanticChoice`:

```ts
  /** Draw Mermaid diagrams in notes. On unless this browser turned it off; on too when storage is blocked. */
  diagrams(): boolean {
    try {
      return localStorage.getItem(DIAGRAMS_KEY) !== 'off';
    } catch {
      return true;
    }
  },
  setDiagrams(on: boolean): void {
    try {
      if (on) localStorage.removeItem(DIAGRAMS_KEY);
      else localStorage.setItem(DIAGRAMS_KEY, 'off');
    } catch {
      /* storage blocked: keep default */
    }
  },
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

- [ ] **Step 6: Clear diagrams when the keys are dropped**

In `web/src/state/store.ts`, import `clearDiagrams` from `'../diagrams/diagramRender'` and add `clearDiagrams();` directly after `this.images.clear();` in both `enterUnlocked` and `dropKeys`:

```ts
    this.images.clear();
    clearDiagrams();
```

- [ ] **Step 7: Add the styles**

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
/* The hidden renderer iframe: laid out (Mermaid measures text) but invisible and off-screen. */
.diagram-frame {
  position: fixed;
  left: -10000px;
  top: 0;
  width: 1200px;
  height: 800px;
  border: 0;
  visibility: hidden;
  pointer-events: none;
}
```

- [ ] **Step 8: Pin the markdown side and the lock behavior**

Add to `web/src/markdown/render.test.ts` (inside the existing top-level `describe` for `renderMarkdown`; follow the file's existing style, and add `renderUntrustedMarkdown` to its import from `./render` if missing):

```ts
  it('leaves a mermaid fence as an ordinary code block, in notes and in untrusted output', () => {
    const src = '```mermaid\ngraph TD; A-->B\n```';
    expect(renderMarkdown(src)).toContain('<pre><code class="language-mermaid">');
    expect(renderUntrustedMarkdown(src)).toContain('<pre><code class="language-mermaid">');
  });
```

Find the existing store test that checks decrypted images are dropped on lock (`grep -n "images" web/src/state/*.test.ts`, or look for a test of `lock` or `dropKeys`). In that file add `vi.mock('../diagrams/diagramRender', () => ({ clearDiagrams: vi.fn() }))` (adjust if the file already mocks modules) and assert, next to the existing image assertion, that `clearDiagrams` was called on lock and on sign-out. If no such test exists, add a minimal one that locks a store the way a neighbouring test does and expects `clearDiagrams` to have been called once.

- [ ] **Step 9: Run the whole web suite and the build**

Run: `npm test -w web`
Expected: all PASS.
Run: `npm run build -w web`
Expected: PASS (`tsc -b`, the main build and the frame build).

- [ ] **Step 10: Commit**

```bash
git add web/src/diagrams/useDiagrams.ts web/src/diagrams/useDiagrams.test.tsx web/src/lib/prefs.ts web/src/pages/NotePane.tsx web/src/pages/NodePreview.tsx web/src/state/store.ts web/src/styles/note.css web/src/markdown/render.test.ts web/src/state
git commit -m "feat(web): draw mermaid fences as diagrams in note view

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 9: The Settings toggle

**Files:**
- Create: `web/src/pages/SettingsDiagrams.tsx`
- Modify: `web/src/pages/SettingsPage.tsx` (render the new card after `<SemanticSearch />`, ~line 47)
- Test: `web/src/pages/SettingsDiagrams.test.tsx`; a prefs test (add to `web/src/lib/prefs.test.ts` if that file exists, otherwise create it)

**Interfaces:**
- Consumes: `prefs.diagrams()` and `prefs.setDiagrams(on)` (added to `prefs.ts` in Task 8 Step 3a); `clearDiagrams()` from `../diagrams/diagramRender` (Task 7).
- Produces: `DiagramSettings` component (no props), a card with `id="diagrams-h"` on its heading.

- [ ] **Step 1: Write the failing tests**

Prefs (create `web/src/lib/prefs.test.ts` if it does not exist, otherwise add the `describe` to it):

```ts
// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prefs } from './prefs';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe('prefs.diagrams', () => {
  it('is on by default', () => {
    expect(prefs.diagrams()).toBe(true);
  });
  it('round-trips off and on', () => {
    prefs.setDiagrams(false);
    expect(prefs.diagrams()).toBe(false);
    expect(localStorage.getItem('inked.diagrams')).toBe('off');
    prefs.setDiagrams(true);
    expect(prefs.diagrams()).toBe(true);
    expect(localStorage.getItem('inked.diagrams')).toBeNull();
  });
  it('is on when storage is unavailable, and setting it does not throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(prefs.diagrams()).toBe(true);
    expect(() => prefs.setDiagrams(false)).not.toThrow();
  });
});
```

If `prefs.test.ts` already exists, keep its existing header (`// @vitest-environment` line and imports) and merge; do not duplicate imports.

`web/src/pages/SettingsDiagrams.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const clearDiagrams = vi.fn();
vi.mock('../diagrams/diagramRender', () => ({ clearDiagrams: () => clearDiagrams() }));

const { DiagramSettings } = await import('./SettingsDiagrams');

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
  localStorage.clear();
  clearDiagrams.mockReset();
});

async function mount() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<DiagramSettings />));
  return host;
}
const box = (el: HTMLElement) => el.querySelector('input[type="checkbox"]') as HTMLInputElement;

describe('DiagramSettings', () => {
  it('shows the preference, on by default, under a labelled heading', async () => {
    const el = await mount();
    expect(box(el).checked).toBe(true);
    expect(el.querySelector('#diagrams-h')!.textContent).toBe('Diagrams');
    expect(el.textContent).toContain('Draw Mermaid diagrams in notes');
    expect(el.textContent).toContain('this browser only');
  });

  it('turning it off stores the choice and removes any existing renderer', async () => {
    const el = await mount();
    await act(async () => box(el).click());
    expect(box(el).checked).toBe(false);
    expect(localStorage.getItem('inked.diagrams')).toBe('off');
    expect(clearDiagrams).toHaveBeenCalledTimes(1);
  });

  it('turning it back on stores the choice without touching the renderer', async () => {
    localStorage.setItem('inked.diagrams', 'off');
    const el = await mount();
    expect(box(el).checked).toBe(false);
    await act(async () => box(el).click());
    expect(box(el).checked).toBe(true);
    expect(localStorage.getItem('inked.diagrams')).toBeNull();
    expect(clearDiagrams).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -w web -- src/lib/prefs.test.ts src/pages/SettingsDiagrams.test.tsx`
Expected: the `SettingsDiagrams` tests FAIL (cannot resolve `./SettingsDiagrams`). The prefs tests already PASS because Task 8 added the method; that is fine, they pin it.

- [ ] **Step 3: Implement the card**

`web/src/pages/SettingsDiagrams.tsx`:

```tsx
import { useState } from 'react';
import { clearDiagrams } from '../diagrams/diagramRender';
import { prefs } from '../lib/prefs';

/** Per-browser switch for drawing Mermaid diagrams (see docs/architecture.md, "Diagrams"). */
export function DiagramSettings() {
  const [on, setOn] = useState(prefs.diagrams());
  return (
    <section className="card" aria-labelledby="diagrams-h">
      <h2 id="diagrams-h" className="card-title">
        Diagrams
      </h2>
      <label className="check">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            const next = e.target.checked;
            prefs.setDiagrams(next);
            // Turning it off also removes a renderer that is already running.
            if (!next) clearDiagrams();
            setOn(next);
          }}
        />
        <span>Draw Mermaid diagrams in notes</span>
      </label>
      <p className="field-hint">
        On by default. The first diagram in a session loads a hidden renderer from this server, in the background; later
        diagrams are drawn in your browser without any request. Nothing about a diagram leaves your browser. When this is off,
        nothing is loaded and diagrams stay as plain text. This setting applies to this browser only.
      </p>
    </section>
  );
}
```

In `web/src/pages/SettingsPage.tsx`, add `import { DiagramSettings } from './SettingsDiagrams';` beside the `AskSettings` import, and render it after `<SemanticSearch />`:

```tsx
      <SemanticSearch />
      <DiagramSettings />
      <AskSettings />
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -w web -- src/lib/prefs.test.ts src/pages/SettingsDiagrams.test.tsx`
Expected: PASS.
Run: `npm test -w web`
Expected: all PASS (the Settings page tests, if any, still pass with the extra card).

- [ ] **Step 5: Commit**

```bash
git add web/src/pages/SettingsDiagrams.tsx web/src/pages/SettingsDiagrams.test.tsx web/src/pages/SettingsPage.tsx web/src/lib/prefs.test.ts
git commit -m "feat(web): per-browser setting to turn diagrams off

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Docs

**Files:**
- Modify: `docs/architecture.md`, `docs/mcp.md`, `docs/deploy.md`

**Interfaces:**
- Consumes: the behavior built in Tasks 1 to 9.
- Produces: nothing code depends on.

- [ ] **Step 1: Add a Diagrams section to `docs/architecture.md`**

Directly after the `## Images` section (before the next `##` heading), add:

```markdown
## Diagrams

A fenced block tagged `mermaid` is drawn as a diagram in note view. The note stays plain Markdown: `markdown-it` renders the fence as an ordinary code block, and after render a view hook (`useDiagrams`) asks a sandboxed renderer to draw it. The server never sees a diagram, and Mermaid is a self-hosted bundle that the main app never loads.

Mermaid cannot run under the app's CSP: it measures text by inserting inline-styled SVG into the page, and `style-src 'self'` blocks that, so labels end up wider than their boxes. Mermaid therefore runs in an iframe (`<iframe sandbox="allow-scripts" src="/frame/frame.html">`) built separately (`web/vite.frame.config.ts`, output `dist/frame/`) and served by the server with its own headers: `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'` and `Access-Control-Allow-Origin: *` (the frame has an opaque origin, so its scripts and fonts are CORS requests; everything under `/frame/` is public static code). The frame has no `allow-same-origin`, so it cannot reach the app's cookies, keys or DOM, and it cannot make network requests. Unknown paths under `/frame` are a 404, never the SPA shell. The app's own CSP is unchanged.

The page and the frame talk over a `MessageChannel` handed over once (`inked-diagram-connect`, with the theme read from the CSS variables). The page sends `{ type: 'render', id, source }` and gets back the SVG string, or a failure (`oversized`, `syntax`, `load`). A frame that does not answer in 30 seconds is removed and replaced on the next request. The frame runs Mermaid with `securityLevel: 'strict'`, HTML labels off, `maxTextSize` 20 000 and `maxEdges` 200, and a `secure` list that stops a note's `%%{init}%%` directive from changing the theme or injecting CSS.

The SVG that comes back is untrusted. The page sanitizes it with DOMPurify (no script, `foreignObject`, event attributes or external `href`), applies its `<style>` text through a constructed stylesheet (no `@import`, no external `url()`), and applies each `style=""` attribute through CSSOM, which the strict CSP allows. A diagram that is too large, has a syntax error, cannot load or times out stays a code block with a one-line note. Rendered diagrams are cached in memory by source and dropped, with the iframe, whenever the keys are dropped (lock and sign-out). Ask answers are never drawn: a mermaid fence in an LLM answer stays a code block. In `vite dev` the frame is proxied to the backend, so run `npm run build` once and keep the backend running to see diagrams there.

Drawing diagrams is optional. A per-browser preference (`prefs.diagrams()`, localStorage key `inked.diagrams`, on by default, switched in Settings under "Diagrams") controls it, and the server never learns it. When it is off the hook creates no iframe and makes no request to `/frame/`; each mermaid block stays a code block with the note "Diagrams are off. Turn them on in Settings." Turning it off also removes a renderer that is already running.
```

- [ ] **Step 2: Add a short note to `docs/mcp.md`**

After the `## Adding images` section, add:

```markdown
## Diagrams

Notes can hold diagrams written in Mermaid. Put the diagram in a fenced block tagged `mermaid`; Inked draws it in the browser when the note is viewed, and the source stays plain text in the note, so `read_note` and search see it as written. Diagrams need no tool and no action. Each browser can turn drawing off under Settings, "Diagrams"; the source then stays plain text.
```

- [ ] **Step 3: Note the `/frame/` headers in `docs/deploy.md`**

Directly after the line that shows the `Content-Security-Policy:` header (about line 169), add:

```markdown
Responses under `/frame/` (the sandboxed diagram renderer) deliberately carry a different policy, with `style-src 'unsafe-inline'`, `connect-src 'none'`, `sandbox allow-scripts` and `Access-Control-Allow-Origin: *`; see `docs/architecture.md`, "Diagrams". Do not let nginx, Cloudflare transform rules or any other layer add, replace or strip these headers on `/frame/` paths, or diagrams stop drawing.
```

- [ ] **Step 4: Commit**

```bash
git add docs/architecture.md docs/mcp.md docs/deploy.md
git commit -m "docs: mermaid diagrams (architecture, MCP, deploy)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

---

### Task 11: Production build, real-browser check, bundle size

**Files:**
- Modify: `docs/superpowers/specs/2026-10-15-mermaid-diagrams-design.md` (the Open items line)

**Interfaces:**
- Consumes: everything above.
- Produces: a verified feature and a measured size.

- [ ] **Step 1: Build and start the app on a scratch data dir**

```bash
npm run build
```

Start the built server in the background on a free port with a new empty `DATA_DIR` in your scratchpad (`PORT=8098 DATA_DIR=<scratch>/mermaid-data npm start`). Read the first-run setup token from its log. Open `http://localhost:8098/` in the Browser pane, create an account with a test password, and create a vault and a note (as in the images check).

- [ ] **Step 2: Check each case in view mode**

Put these in notes and switch each to view mode. Read the console filtered to `Content Security Policy` after each one. The main page must log no violation.

1. A flowchart with a subgraph, a decision node and a labeled edge. Drawn, dark and purple, labels inside their boxes.
2. A sequence diagram. Drawn.
3. A state diagram, a class diagram and an ER diagram. Drawn or, if one looks wrong, noted as best-effort in the spec.
4. A flowchart with `style A fill:#ff00ff` on one node. That node is magenta.
5. A diagram with a syntax error. The source block stays, with `Diagram error: ...` under it.
6. `%%{init: {"themeCSS": ".node rect { fill: red !important }", "theme": "forest"}}%%` at the top of a flowchart. The look is unchanged (no red, not forest).
7. The same diagram twice in one note. Both drawn and both styled. Delete one of them in edit mode and return to view: the other keeps its styling.
8. An empty mermaid fence. Stays an empty code block, no label.
9. Lock the app. Check `document.querySelector('iframe.diagram-frame')` is `null` and `document.adoptedStyleSheets.length` is 0 (run these in the page console). Unlock and open the note again: redrawn, and one new `iframe.diagram-frame` exists.
10. Resize the pane to 375px wide with a wide flowchart. The figure scrolls horizontally and the page does not.
11. Open the note in the node preview (concept map). Drawn there too.
12. Open `http://localhost:8098/frame/frame.html` directly in a tab: it loads and does nothing (no handshake). Open `http://localhost:8098/frame/nope` : 404 JSON.
13. Kill-switch: in the page console run `document.querySelector('iframe.diagram-frame').remove()`, then switch to another note with a diagram and back. The diagram is drawn again (the next render after a lost frame recovers once its timeout fires, up to 30 s; note how long it took and whether the note showed the timeout line meanwhile).
14. An Ask answer containing a mermaid fence, if an Ask connection is available. Stays a code block. If Ask cannot be used, skip it and say so.
15. The setting. Settings page shows a "Diagrams" card with the box checked. Untick it while a diagram note was viewed earlier in the session: `document.querySelector('iframe.diagram-frame')` is `null` straight away. Open a note with a diagram: the code block stays with "Diagrams are off. Turn them on in Settings." beneath it, and the network log shows no request to `/frame/` after the toggle (reload the page first, then open the note, to prove none is made from a cold start). Tick it again: the note draws.
16. In case 15 with a fresh reload and the setting off, confirm `performance.getEntriesByType('resource').filter(e => e.name.includes('/frame/'))` is empty.

If any case fails, fix it with a new failing test first (TDD), re-run `npm test -w web`, rebuild, and repeat the failed case.

- [ ] **Step 3: Measure the frame bundle**

```bash
ls -l web/dist/frame/assets | sort -k5 -n -r | head -8
```

Gzip the largest few (`gzip -c <file> | wc -c`). Record the sizes of what a flowchart note loads, raw and gzipped, and the Mermaid version. Confirm nothing in `web/dist/index.html` or the main `web/dist/assets` bundle mentions Mermaid (`grep -l -i mermaid web/dist/assets/*.js` lists none).

- [ ] **Step 4: Record the size in the spec and commit**

Replace the "Measured size of the frame's Mermaid chunks" line in the spec's Open items with the measured raw and gzipped sizes and the Mermaid version. Also note case 13's observed recovery time.

```bash
git add docs/superpowers/specs/2026-10-15-mermaid-diagrams-design.md
git commit -m "docs: record frame bundle size and browser check

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>"
```

- [ ] **Step 5: Stop the server, then run the full suite**

Stop the background server. Run: `npm test`
Expected: all workspaces PASS.

- [ ] **Step 6: Hand off**

Run a whole-branch review (superpowers:requesting-code-review), fix what it finds, then use superpowers:finishing-a-development-branch. Nothing is merged or pushed without the user's choice.
