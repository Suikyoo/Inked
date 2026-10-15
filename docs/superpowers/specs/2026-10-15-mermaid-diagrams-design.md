# Mermaid diagrams in notes: design (revision 2, sandboxed renderer)

Date: 2026-10-15. Status: draft revision, awaiting review. Revision 1 (render in the page, style around the CSP) failed its probe; see "Why revision 2".

## Goal

A note can contain a diagram written in Mermaid inside a fenced block. When the note is shown in view mode, the browser draws it as an SVG themed to match Inked. The note stays plain Markdown, and the server still only sees ciphertext.

Primary use: architecture and flow diagrams that the AI (through the MCP tools) or the owner writes, replacing hand-drawn ASCII boxes.

## Decisions already made

- Language: Mermaid, not a custom DSL and not ASCII auto-detection.
- Rendering happens in the browser, on view, from the decrypted note text. Nothing about a diagram reaches the server.
- Mermaid is self-hosted. No CDN. The main app's CSP (`style-src 'self'`) does not change.
- Styling is Inked's own: dark and purple, driven by CSS variables.
- Mermaid runs inside a sandboxed iframe with its own CSP (this revision).

## Non-goals

Export to PNG or SVG, zoom and pan, live preview in the editor, clickable nodes, ASCII auto-detection, a light theme, a persistent diagram cache, and updating the `inked-notes` skill in the sibling plugin repo (a follow-up).

## Why revision 2

Revision 1 rendered Mermaid in the page and tried to make its output pass the CSP afterwards. A probe on a production build under the real CSP (Mermaid 11.17.2) found:

- Constructed stylesheets (`new CSSStyleSheet().replaceSync()` in `document.adoptedStyleSheets`) and CSSOM style writes (`el.style.cssText`) both apply under `style-src 'self'`. The theme fill and a per-node inline style rendered correctly.
- Mermaid's text measuring pass does not survive the CSP. It builds its SVG inside the page, using inline styles and a `<style>` element, and the CSP blocks them (about 120 `style-src-attr` and `style-src-elem` violations). A 22px monospace theme font left every label wider than its box, and the box widths were identical to the 14px run. Mermaid sizes boxes before we can touch the output, so no post-processing fixes it.

So the layout has to run in a document that is allowed to use inline styles. We do not loosen the main page for that. The renderer moves to a sandboxed iframe. The display side of revision 1 (sanitizing, constructed stylesheet, CSSOM) is kept, because the probe showed it works.

## Architecture

```
note view (main page, strict CSP)                 /frame/frame.html (sandboxed iframe, own CSP)
  useDiagrams hook                                  MessageChannel port
    renderDiagram(source) --> frame client ------>  render(id, source)  --> Mermaid (inline styles allowed)
    cache by source          <-- {svg} -----------  returns the SVG string
    sanitize SVG (DOMPurify)
    lift <style> -> constructed stylesheet
    style="" -> CSSOM writes
    swap code block for <figure><svg>
```

### The frame page

- A separate Vite build produces `dist/frame/` (a `frame.html`, one script, Mermaid chunks and the two fonts). It is built with `base: '/frame/'` and no `public/` copy. Mermaid lives only here, so the main bundle does not grow.
- The server serves every path under `/frame/` with different headers from the rest of the app:
  - `Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`. The page is a sandbox even when opened directly. It cannot make any network request. There is no `'unsafe-eval'`; a diagram type that needs it is unsupported.
  - `Access-Control-Allow-Origin: *`. A sandboxed document without `allow-same-origin` has an opaque origin, and module scripts and fonts it loads are CORS requests. Everything under `/frame/` is public static code and fonts, so `*` leaks nothing.
  - The other security headers stay as they are.
  - An unknown path under `/frame/` is a plain 404 JSON, never the SPA shell (the SPA must never be served with these relaxed headers).
- The parent embeds it as `<iframe sandbox="allow-scripts" src="/frame/frame.html">`. No `allow-same-origin`: the frame cannot read the app's cookies, storage, memory, keys or DOM. The main CSP's `default-src 'self'` already permits a same-origin frame source.
- The iframe is created on the first diagram in a session, hidden with a CSS class (`visibility: hidden`, off-screen, fixed size, not `display: none`, because Mermaid measures text and needs real layout).

### Protocol

All traffic after the handshake uses a `MessageChannel`, so no other window can send into it.

1. The parent creates the channel and, on the iframe's `load`, sends `{ type: 'inked-diagram-connect', theme }` with `port2` in the transfer list, to target origin `'*'` (the frame's origin is opaque).
2. The frame accepts the first such message only if `event.source === window.parent`, keeps `ports[0]`, configures Mermaid from `theme` on first use, and replies `{ type: 'ready' }`.
3. Parent to frame: `{ type: 'render', id, source }`. `id` is a string the parent makes unique (`inked-dg-<n>`) and Mermaid uses as the SVG id, so cached results never collide.
4. Frame to parent: `{ type: 'result', id, ok: true, svg, css }` or `{ type: 'result', id, ok: false, reason: 'oversized' | 'syntax' | 'load', message? }`.

Both sides validate every message with a type guard and ignore anything else. The parent treats the returned SVG as untrusted and runs it through the sanitizer. The frame only ever receives diagram text; it has no keys and no other note content.

The parent applies timeouts. No `ready` within 15 s counts as `load`. A render with no result within 30 s rejects with `timeout`, and the parent removes the iframe (which kills a runaway script) and creates a fresh one on the next request.

### Frame renderer

Runs in the frame. Mermaid is imported on the first `render`. Config: `startOnLoad: false`, `securityLevel: 'strict'`, `theme: 'base'`, `themeVariables` from the parent's `theme`, a small `themeCSS` of Inked tweaks, `maxTextSize` 20 000, `maxEdges` 200, HTML labels off (`htmlLabels: false` and `flowchart.htmlLabels: false`, so labels are plain selectable SVG text and the SVG has no `foreignObject`), and `secure` extended with `theme`, `themeCSS`, `themeVariables` and `fontFamily` so a note's `%%{init}%%` directive cannot change the look or inject CSS. Before the first render it loads Public Sans 400, 500 and 600 with `document.fonts.load` (capped at 3 s), so text is measured in the font the main page will show.

### Parent pipeline

1. `markdown-it` is unchanged. A `mermaid` fence is an ordinary `pre > code.language-mermaid` block. If a render fails, or the app is locked, the reader sees readable source.
2. A hook, `useDiagrams`, mirrors `useInkedImages`. After the note HTML is in the DOM it finds `code.language-mermaid` blocks and asks `renderDiagram(source)` for each.
3. `renderDiagram` trims the source, refuses it over 20 000 characters, checks a cache keyed by source, and otherwise asks the frame client to render. The reply `{ svg, css }` goes through `prepareDiagramSvg` (below). The result `{ id, svg, css }` is cached in memory.
4. The hook swaps the block for a `<figure class="diagram" role="img">` with an `aria-label` ("Diagram", or the SVG `<title>` when present).
5. In-flight renders are cancelled when the note HTML changes or the component unmounts; a late result must not write into a replaced DOM.

Where it runs: note view in `NotePane` and `NodePreview`. It never runs for `AskAnswer`; LLM answers are untrusted and a mermaid fence there stays a code block.

### Display under the strict CSP

This is the part the probe confirmed.

- The frame, not the page, takes Mermaid's markup apart (`liftStyles`, in the frame): it cuts every `<style>` out of the SVG into a `css` string and moves each `style=""` attribute into `data-inline-style`, then sends `{ svg, css }`. The page must never parse markup that contains either: the page's CSP reports a violation for every `<style>` element and `style` attribute in any document it parses, even a detached `DOMParser` one (the first gate run logged 138 of them). So the page only ever sees style-free SVG.
- The page sanitizes what it receives, because the frame is another window: the SVG with a separate DOMPurify profile (keep SVG shapes, text and markers; remove `script`, `foreignObject`, event attributes, any leftover `<style>` or `style` attribute, and any `href` or `xlink:href` that is not a same-document fragment), and the css (no `@import`, no `url()` other than `url(#fragment)`). The note sanitizer `sanitizeHtml` is unchanged.
- The sanitized css goes into a constructed stylesheet in `document.adoptedStyleSheets`, shared per diagram id and removed when the last figure using it goes.
- Each `data-inline-style` is written back with `el.style.cssText` once the SVG is in the page. CSSOM writes are what React `style` props already use here.

### Theme

The app is dark-only. The parent reads the CSS variables once, when the frame connects, and sends them as `theme` (`themeVariables` need literal colors, not `var()`). If a light theme is ever added, the cache key and the connect message must carry the theme.

### Limits and errors

- Over 20 000 characters, or over `maxEdges` edges: keep the code block and show "Diagram too large to draw."
- Mermaid syntax error: keep the code block and show "Diagram error: <first error line>".
- Frame failed to load or connect: keep the code block and show "Could not load the diagram renderer." Not cached, so the next view retries.
- Render timed out: keep the code block and show "Diagram took too long to draw." Not cached.
- No allowlist of diagram types. Flowchart, sequence, state, class and ER are tested; others get best-effort rendering.

### Setting

Diagrams are optional. A per-browser preference, `prefs.diagrams()` (localStorage key `inked.diagrams`, like spell-check and the semantic-search choice in `web/src/lib/prefs.ts`), is on by default and is switched in a new "Diagrams" card on the Settings page. It is per browser, not synced: it governs what this browser loads, and the server never learns it.

- **On:** as described above.
- **Off:** the hook does nothing but leave each mermaid block as a code block and add the note "Diagrams are off. Turn them on in Settings." No iframe is created and no request is made to `/frame/`. Turning the setting off also calls `clearDiagrams()`, so an iframe that already exists is removed at once.
- The card explains the cost: the first diagram in a session loads a hidden renderer from this server in the background, later diagrams need no request, and nothing about a diagram leaves the browser.

### Lock

Locking or signing out drops the keys, and `store.images.clear()` already drops decrypted images there. The diagram cache holds rendered text of decrypted notes, so the same two places (`enterUnlocked` and `dropKeys` in `web/src/state/store.ts`) also call `clearDiagrams()`, which empties the cache and removes the iframe.

### Phone

The SVG scales with `max-width: 100%` through Mermaid's own inline `max-width`. A wide diagram scrolls horizontally inside its wrapper, like `pre` does in `phone.css`.

### Dev server

`vite dev` does not build the frame. The dev proxy forwards `/frame` to the backend like `/api`, so diagrams work in dev once `npm run build` has produced `dist/frame` and the backend is running. Without that, a diagram shows the "could not load" note.

## Security notes

- The frame cannot reach the app: opaque origin (both the `sandbox` attribute and the CSP `sandbox` directive), no network (`connect-src 'none'`), and it holds no secrets, only the diagram text the parent sends.
- Mermaid output is untrusted: it is sanitized in the parent, and its CSS is filtered.
- The relaxed `style-src 'unsafe-inline'` applies only to `/frame/*` responses. The main page's CSP, and `docs/architecture.md`'s promise of no `'unsafe-inline'` for the app, are unchanged.
- `Access-Control-Allow-Origin: *` is limited to `/frame/*`.

## Testing

- Server: header tests for `/frame/frame.html` and `/frame/assets/*` (exact CSP, CORS header, nosniff), 404 for unknown `/frame/...` and `/frame`, no regression on the main headers.
- Frame renderer: unit tests with Mermaid mocked (config, secure list, error mapping, oversize, font loading, retry after a failed import).
- Frame client: unit tests with Node's real `MessageChannel` standing in for the frame (request and result, timeout and restart, `ready` timeout, stale ids, malformed messages ignored).
- Sanitizer, stylesheets, cache and hook: as in revision 1 (fixtures, mocked renderer, jsdom).
- The setting: `prefs.diagrams()` default, off and round-trip, a storage failure meaning on; the Settings card toggles it and removes the iframe when turned off; with the setting off the hook calls no renderer and shows the note.
- A gate probe on a production build before the rest is built: the real frame, client and host under the real CSP, checking the frame loads from an opaque origin, the layout is right at 22px monospace, and our own insertion causes no violation.
- Final real-browser check on the production build: flowchart, sequence, state, class and ER diagrams, a bad-syntax diagram, an `%%{init}%%` theme directive that must be ignored, two identical diagrams in one note, lock and unlock (cache and iframe gone), 375px width, node preview, and no CSP violation in the main page.

## Docs

`docs/architecture.md` (the frame, its headers, the protocol, the lock behavior, the setting) and `docs/mcp.md` (notes may contain ```` ```mermaid ```` fences; a browser can turn drawing off in Settings) are updated. `docs/deploy.md`: nothing to change unless the gate shows nginx or Cloudflare strips the headers on `/frame/`; if so, record it there.

## Open items

- Measured size of the frame's Mermaid chunks (record after the first production build).
- Follow-up: teach the `inked-notes` skill in the plugin repo to prefer mermaid fences for diagrams.
- Possible later optimization: an encrypted diagram cache in the existing image store, to skip re-rendering. Not needed now; rendering is fast and the cache is per session.

## Probe result, revision 2 (Task 4): FAILED on one criterion

Date: 2026-10-15. mermaid 11.17.2 (`npm ls -w web mermaid`). The real frame, client and host, served by the real server under the real CSP, showed: the sandboxed frame loads from an opaque origin and the handshake completes (`small`, `big`, `directive` all `ok: true`); layout is correct at 22px monospace (`big` has `overflow: []` and the labels sit inside their boxes in the screenshot); `themeFillApplied: true` and `inlineStyleApplied: true` for all three; the `%%{init}%%` directive was ignored (`redInjected: false`, `themeFillApplied: true`).

Failing criterion: `mainViolations` was not `[]`. The parent page logged 138 CSP violations: 3 `style-src-elem: inline` and 135 `style-src-attr: inline`, all reported asynchronously after the SVG was handed to the page. A side experiment showed they come from the probe's display path parsing the SVG string with `DOMParser` in the parent page (the `<style>` elements and `style="..."` attributes in the markup), not from `adoptedStyleSheets`, `importNode`, `style.cssText` or `CSSStyleSheet.replaceSync`, which logged none. The display path therefore needs to avoid parsing Mermaid's inline style markup in the parent document, or the frame must send a style-free structure, before the design can be confirmed.

## Probe result, revision 2, second run (Task 4)

Date and mermaid version: 2026-10-15, mermaid@11.17.2 (`npm ls -w web mermaid`). The first run failed only on `mainViolations` (see the section above). After the frame took over lifting `<style>` and `style=""` (Task 3b), the second run showed: the real frame, client and host, served by the real server under the real CSP, showed: the sandboxed frame loads from an opaque origin (script, chunks and fonts pass CORS under the frame CSP) and the handshake completes; layout is correct at 22px monospace (no label overflows its box); the theme fill and a per-node inline style survive the display path; a note's `%%{init}%%` directive is ignored; and the main page logged no CSP violation. The design in this revision is confirmed.
