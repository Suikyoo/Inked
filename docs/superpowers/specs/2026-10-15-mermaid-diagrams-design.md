# Mermaid diagrams in notes: design

Date: 2026-10-15. Status: draft, awaiting review.

## Goal

A note can contain a diagram written in Mermaid inside a fenced block. When the note is shown in view mode, the browser draws it as an SVG themed to match Inked. The note stays plain Markdown, and the server still only sees ciphertext.

Primary use: architecture and flow diagrams that the AI (through the MCP tools) or the owner writes, replacing hand-drawn ASCII boxes.

## Decisions already made

- Language: Mermaid, not a custom DSL and not ASCII auto-detection.
- Rendering happens in the browser, on view, from the decrypted note text. Nothing about a diagram reaches the server.
- Mermaid is self-hosted as a lazily loaded chunk. No CDN. No change to `script-src`, `connect-src` or `style-src`.
- Styling is Inked's own: dark and purple, driven by CSS variables, not Mermaid's default look.

## Non-goals

Export to PNG or SVG, zoom and pan, live preview in the editor, clickable nodes, ASCII auto-detection, and updating the `inked-notes` skill in the sibling plugin repo (listed as a follow-up).

## Pipeline

1. `markdown-it` is unchanged. A ```` ```mermaid ```` fence renders as an ordinary `pre > code.language-mermaid` block. If rendering fails, is skipped, or the app is locked, the reader sees readable source.
2. A hook, `useDiagrams` (in `web/src/diagrams/`), runs after the note HTML is in the DOM, like `useInkedImages`. It finds `code.language-mermaid` blocks in the view article.
3. For each block it calls `renderDiagram(source, theme)` in `mermaidRender.ts`, which:
   - dynamic-imports Mermaid on first use (notes without a diagram never load it);
   - initializes Mermaid with `startOnLoad: false`, `securityLevel: 'strict'`, `theme: 'base'`, `themeVariables` read from the current CSS variables, `maxTextSize` about 20 000 and `maxEdges` about 200, and HTML labels off so labels are plain SVG text;
   - renders to an SVG string;
   - sanitizes it (see Sanitizing);
   - applies styles under the CSP (see CSP).
4. The hook replaces the `pre` with a wrapper element holding the SVG. The wrapper has `role="img"` and an `aria-label` ("Diagram", plus the title when Mermaid provides one).
5. Renders are keyed by source. The app is dark-only today, so the theme is read once, when Mermaid first loads. If a light theme is ever added, the cache key must include the theme. In-flight renders are cancelled when the note HTML changes or the component unmounts. A render finishing late must not write into a replaced DOM. Results are cached in memory only, never persisted.

Where it runs: note view in `NotePane` and `NodePreview`. It never runs for `AskAnswer`. `renderUntrustedMarkdown` output keeps mermaid fences as code blocks, because LLM answers are untrusted.

## CSP

The CSP is `style-src 'self'`: no inline `<style>` elements and no `style="..."` attribute strings (see `docs/architecture.md`). Mermaid's SVG contains both, so inserting it unchanged would render unstyled and fill the console with CSP errors.

Approach:

- Cut the `<style>` block out of the SVG. Mermaid scopes it to `#mermaid-<id>`. Apply its text through a constructed stylesheet (`new CSSStyleSheet().replaceSync(text)` added to `document.adoptedStyleSheets`). Remove the sheet when no diagram on the page uses its id.
- Parse each `style` attribute and re-apply it with `el.style.setProperty()`, then remove the attribute. This is the CSSOM path React `style` props already use in this app.
- Inked's own rules for `.md` diagram wrappers (overflow, max-width, spacing) go in `note.css`.

This depends on two assumptions. First, that a constructed stylesheet is allowed under `style-src 'self'`. Second, that Mermaid's own measuring pass is not fooled: it inserts the SVG into the page to measure text before we ever see it, and that insertion is also subject to the CSP. If the measuring pass ignores the font settings, labels overflow their boxes. Task 1 of the plan is a throwaway probe that checks it in a real browser under the real CSP, using the production build. If the assumption fails, the fallback is to render the sanitized SVG into an `<img src="data:image/svg+xml,...">`. `img-src data:` allows that, and the SVG is fully sandboxed. The cost is page fonts, text selection and live theming, so labels must then be plain SVG text with explicit font stacks. The spec is amended if the fallback is used.

## Sanitizing

A separate DOMPurify configuration for Mermaid SVG, not the note sanitizer. It keeps SVG shapes, text and markers. It removes `script`, `foreignObject`, event attributes and any `href` or `xlink:href` that is not a same-document fragment (`#...`). The existing `sanitizeHtml` for notes is unchanged.

## Theming

`theme: 'base'` with `themeVariables` for node and cluster fill, border, text, line and note colors, plus font family and size. Values are read from the computed CSS variables when Mermaid first loads. `themeCSS` carries small Inked tweaks (corner radius, stroke width, label weight).

A note's own `%%{init: {...}}%%` directive must not override the theme or inject CSS. Mermaid's `secure` list names the keys a diagram directive cannot change; we add `theme`, `themeCSS`, `themeVariables` and `fontFamily` to it, on top of Mermaid's defaults (`secure`, `securityLevel`, `startOnLoad`, `maxTextSize`, `maxEdges`, `suppressErrorRendering`).

## Limits and errors

- Over `maxTextSize` or `maxEdges`: keep the code block and show an "oversized diagram" label.
- Mermaid syntax error: keep the code block and show a short "diagram error" label with Mermaid's first error line.
- Mermaid chunk fails to load: same as a syntax error, with a different label.
- No allowlist of diagram types. Flowchart, sequence, state, class and ER are tested. Others get best-effort rendering.

## Phone

The SVG scales with `max-width: 100%`. A wide diagram scrolls horizontally inside its wrapper, like `pre` does in `phone.css` today.

## Testing

- Unit, with Mermaid mocked (jsdom cannot lay out SVG): hook flow, replacement, stale guard, cache key, oversize, error fallback, and untrusted content not hydrating.
- Fixture tests for the SVG sanitizer (no script, `foreignObject` or external href survives) and for style-attribute conversion and stylesheet cleanup.
- Real-browser check on the production build under the strict CSP: a flowchart, a sequence diagram, a bad-syntax diagram, an `%%{init}%%` theme directive that must be ignored, two identical diagrams in one note, lock and unlock, and a 375px width. The console must show no CSP violations from our own insertion.

## Docs

`docs/architecture.md` (rendering, CSP handling, the fallback) and `docs/mcp.md` (notes may contain ```` ```mermaid ```` fences) are updated.

## Open items

- Measured size of the Mermaid chunk (to be recorded after the first production build).
- Follow-up: teach the `inked-notes` skill in the plugin repo to prefer mermaid fences for diagrams.
