// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown, renderUntrustedMarkdown, sanitizeHtml, toggleTaskAtLine, wikiLinkTargets } from './render';

const dom = (html: string) => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
};

describe('sanitizer', () => {
  it('strips <script>, javascript: links and event handlers from raw HTML', () => {
    const out = sanitizeHtml(
      '<p>ok</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><img src="x" onerror="alert(1)">' +
        '<svg><script>alert(2)</script></svg><div onclick="alert(3)">y</div>',
    );
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/onerror|onclick/i);
    expect(out).toContain('<p>ok</p>');
  });

  it('never emits raw HTML from Markdown source', () => {
    const out = renderMarkdown('hi <script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(dom(out).querySelector('script')).toBeNull();
    expect(dom(out).querySelector('img')).toBeNull();
    expect(out).not.toMatch(/<script/i);
  });

  it('does not render javascript: or data:text links', () => {
    const out = renderMarkdown('[a](javascript:alert(1)) [b](JAVASCRIPT:alert(1)) [c](data:text/html,<b>x</b>)');
    expect(out).not.toMatch(/href="javascript:/i);
    expect(out).not.toMatch(/href="data:text/i);
    expect(dom(out).querySelectorAll('a[href]')).toHaveLength(0);
  });

  it('opens external links in a new tab without referrer', () => {
    const a = dom(renderMarkdown('[site](https://example.com)')).querySelector('a')!;
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('markdown features', () => {
  it('leaves a mermaid fence as an ordinary code block, in notes and in untrusted output', () => {
    const src = '```mermaid\ngraph TD; A-->B\n```';
    expect(renderMarkdown(src)).toContain('<pre><code class="language-mermaid">');
    expect(renderUntrustedMarkdown(src)).toContain('<pre><code class="language-mermaid">');
  });
  it('renders GFM tables, strikethrough and fenced code', () => {
    const d = dom(renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n~~old~~\n\n```bash\necho hi\n```\n'));
    expect(d.querySelector('table td')?.textContent).toBe('1');
    expect(d.querySelector('s')?.textContent).toBe('old');
    expect(d.querySelector('pre code.language-bash')?.textContent).toBe('echo hi\n');
  });

  it('does not linkify bare URLs', () => {
    expect(dom(renderMarkdown('see https://example.com')).querySelector('a')).toBeNull();
  });

  it('renders task lists with source lines', () => {
    const d = dom(renderMarkdown('intro\n\n- [x] done\n- [ ] todo\n- not a task\n'));
    const boxes = d.querySelectorAll<HTMLInputElement>('input.task-checkbox');
    expect(boxes).toHaveLength(2);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[0].dataset.line).toBe('2');
    expect(boxes[1].checked).toBe(false);
    expect(boxes[1].dataset.line).toBe('3');
    expect(d.querySelector('ul')?.className).toContain('contains-task-list');
    expect(d.querySelectorAll('li.task-list-item')).toHaveLength(2);
    expect(d.querySelector('li.task-list-item')?.textContent).toBe('done');
  });

  it('toggles a task in the source', () => {
    const src = 'a\n\n- [x] done\n- [ ] todo\n> - [ ] quoted';
    expect(toggleTaskAtLine(src, 3)).toBe('a\n\n- [x] done\n- [x] todo\n> - [ ] quoted');
    expect(toggleTaskAtLine(src, 2)).toBe('a\n\n- [ ] done\n- [ ] todo\n> - [ ] quoted');
    expect(toggleTaskAtLine(src, 4)).toBe('a\n\n- [x] done\n- [ ] todo\n> - [x] quoted');
    expect(toggleTaskAtLine(src, 0)).toBeNull();
  });

  it('resolves wiki links and mutes unresolved ones', () => {
    const titles: Record<string, string> = { 'deploy-prod': '/v/v1/n/n1' };
    const out = renderMarkdown('See [[Deploy-Prod]], [[deploy-prod|the runbook]] and [[missing note]]. [[ ]]', {
      resolveWikiLink: (t) => titles[t.toLowerCase()] ?? null,
    });
    const d = dom(out);
    const links = d.querySelectorAll('a.wl');
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBe('/v/v1/n/n1');
    expect(links[0].textContent).toBe('Deploy-Prod');
    expect(links[1].textContent).toBe('the runbook');
    expect(d.querySelector('.wl-missing')?.textContent).toBe('missing note');
    expect(d.textContent).toContain('[[ ]]');
  });

  it('escapes wiki link labels', () => {
    const out = renderMarkdown('[[<img src=x onerror=alert(1)>]]');
    expect(dom(out).querySelector('img')).toBeNull();
  });

  it('extracts wiki-link targets', () => {
    expect([...wikiLinkTargets('[[A]] and [[b c|label]] and `[[C]]`')]).toEqual(['a', 'b c', 'c']);
  });
});

describe('internal links', () => {
  it('marks same-origin links internal so the router handles them (M9)', () => {
    const html = renderMarkdown('[a](/v/123) [b](https://example.com) [c](//evil.example)');
    expect(html).toContain('href="/v/123" data-internal="1"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toMatch(/href="\/\/evil\.example"[^>]*data-internal/);
  });

  const ORIGIN = 'https://inked.test';
  /** Every link marked internal stays on this origin: a single leading slash, nothing the browser reads as `//`. */
  const expectInternalSafe = (html: string) => {
    for (const a of dom(html).querySelectorAll('a[data-internal]')) {
      const href = a.getAttribute('href') ?? '';
      expect(href.startsWith('/')).toBe(true);
      expect(href.startsWith('//')).toBe(false);
      expect(href.startsWith('/\\')).toBe(false);
      expect(new URL(href, ORIGIN).origin).toBe(ORIGIN);
    }
  };

  it('a backslash link cannot leave the origin (B4)', () => {
    const html = renderMarkdown('[x](/\\evil.example)');
    const a = dom(html).querySelector('a')!;
    const href = a.getAttribute('href')!;
    expect(href).toBe('/%5Cevil.example');
    expect(new URL(href, ORIGIN).origin).toBe(ORIGIN);
    expectInternalSafe(html);
  });

  it('a javascript: link renders no javascript: href (B4)', () => {
    const html = renderMarkdown('[j](javascript:alert(1))');
    for (const a of dom(html).querySelectorAll('a')) expect(a.getAttribute('href') ?? '').not.toMatch(/javascript:/i);
    expect(html).not.toMatch(/href="javascript:/i);
    expectInternalSafe(html);
  });

  it('strips data-internal from any link whose href is not a single-slash path (B4)', () => {
    const html = sanitizeHtml(
      '<a href="https://evil.example/" data-internal="1">a</a>' +
        '<a href="//evil.example/" data-internal="1">b</a>' +
        '<a href="/\\evil.example" data-internal="1">c</a>' +
        '<a href="relative/path" data-internal="1">d</a>' +
        '<a href="mailto:x@example.com" data-internal="1">e</a>',
    );
    expect(dom(html).querySelectorAll('a[data-internal]')).toHaveLength(0);
    expect(dom(html).querySelectorAll('a')).toHaveLength(5);
  });

  it('classifies the href with TAB/LF/CR removed, as browsers read it (D5e)', () => {
    const html = sanitizeHtml(
      '<a href="/&#9;/evil.example" data-internal="1">a</a>' +
        '<a href="/&#10;/evil" data-internal="1">b</a>' +
        '<a href="/&#13;/evil" data-internal="1">c</a>',
    );
    const links = [...dom(html).querySelectorAll('a')];
    expect(links).toHaveLength(3);
    for (const a of links) {
      expect(a.hasAttribute('data-internal')).toBe(false);
      expect(a.getAttribute('target')).toBe('_blank');
    }
  });

  it('strips data-wikilink from non-internal links but keeps it on resolved wiki-links (D5e)', () => {
    const html = sanitizeHtml(
      '<a href="//evil.example" data-wikilink="">a</a>' +
        '<a href="https://x.example" data-wikilink="">b</a>' +
        '<a href="relative" data-wikilink="">c</a>' +
        '<a href="/&#9;/evil" data-wikilink="">d</a>',
    );
    expect(dom(html).querySelectorAll('a[data-wikilink]')).toHaveLength(0);
    expect(dom(html).querySelectorAll('a')).toHaveLength(4);
    const ok = renderMarkdown('[[Note]]', { resolveWikiLink: () => '/v/1' });
    expect(dom(ok).querySelector('a[data-wikilink][data-internal]')).not.toBeNull();
  });
});

describe('images', () => {
  const ID = '3f2b8c1e-5d4a-4e7b-9a6c-1d2e3f4a5b6c';

  it('renders an inked:// image as a src-less placeholder carrying the id', () => {
    const img = dom(renderMarkdown(`![a chart](inked://${ID})`)).querySelector('img')!;
    expect(img.getAttribute('data-inked-image')).toBe(ID);
    expect(img.getAttribute('alt')).toBe('a chart');
    expect(img.hasAttribute('src')).toBe(false);
  });
  it('keeps the placeholder inside lists and links', () => {
    const out = dom(renderMarkdown(`- item ![x](inked://${ID})\n\n[![y](inked://${ID})](https://example.com)`));
    expect(out.querySelectorAll('img[data-inked-image]')).toHaveLength(2);
  });
  it('turns a public image into a plain external link and never loads it', () => {
    const out = dom(renderMarkdown('![logo](https://example.com/a.png)'));
    expect(out.querySelector('img')).toBeNull();
    const a = out.querySelector('a')!;
    expect(a.getAttribute('href')).toBe('https://example.com/a.png');
    expect(a.textContent).toBe('logo');
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });
  it('shows the url when a public image has no alt text', () => {
    expect(dom(renderMarkdown('![](https://example.com/a.png)')).querySelector('a')!.textContent).toBe('https://example.com/a.png');
  });
  it('never emits a javascript: or data: image', () => {
    const out = renderMarkdown('![x](javascript:alert(1)) ![y](data:text/html;base64,PHNjcmlwdD4=)');
    expect(out).not.toMatch(/<img/i);
    expect(out).not.toMatch(/href="javascript:/i);
  });
  it('ignores a malformed inked uri', () => {
    const out = dom(renderMarkdown('![x](inked://not-a-uuid) ![y](inked://' + ID + '/extra)'));
    expect(out.querySelector('img')).toBeNull();
  });
  it('escapes alt text', () => {
    const img = dom(renderMarkdown(`![a "q" <b>](inked://${ID})`)).querySelector('img')!;
    expect(img.getAttribute('alt')).toBe('a "q" <b>');
    expect(dom(renderMarkdown(`![a "q" <b>](inked://${ID})`)).querySelector('b')).toBeNull();
  });
});
