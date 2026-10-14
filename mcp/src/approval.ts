import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ToolError } from './errors';

/** A problem to show on the page, written for the user. The page stays open for another try. */
export class PageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PageError';
  }
}

/** One page the user fills in: sign-in, access settings, or a new vault. */
export interface ApprovalPage<T> {
  title: string;
  /** One sentence under the title. */
  intro: string;
  submitLabel: string;
  /** Extra CSS for this page. */
  css?: string;
  /** The form fields as HTML. `form` is the last submission, to refill after an error. */
  fields(form?: URLSearchParams): string;
  /** Throws PageError to show a message and keep the page open. */
  submit(form: URLSearchParams): Promise<T>;
  /** The line shown after a successful submit. */
  done(value: T): string;
}

export type PageOutcome<T> = { outcome: 'done'; value: T } | { outcome: 'cancelled' } | { outcome: 'timed_out' };

export interface OpenedPage<T> {
  url: string;
  result: Promise<PageOutcome<T>>;
  /** False when no browser could be started: the user must open `url` by hand. */
  launched: Promise<boolean>;
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ENTITIES[c]);

const MAX_BODY = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

const BASE_CSS = `
:root{color-scheme:light dark;--bg:#F6F4FA;--fg:#1E1B26;--muted:#625C73;--line:#D8D3E3;--card:#FFFFFF;--accent:#2F7F77;--error:#B4415E}
@media (prefers-color-scheme:dark){:root{--bg:#17151F;--fg:#ECE8F4;--muted:#A39DB5;--line:#3A3550;--card:#211E2B;--accent:#45A89E;--error:#D9768F}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:32rem;margin:6vh auto;padding:2rem;background:var(--card);border:1px solid var(--line);border-radius:12px}
.brand{margin:0;color:var(--accent);font-weight:600;letter-spacing:.04em}
h1{margin:.25rem 0 1rem;font-size:1.4rem}
.intro,.hint{color:var(--muted)}
label{display:block;margin:.9rem 0 .3rem;font-weight:600}
input[type=text],input[type=url],input[type=password],input[type=number]{width:100%;padding:.55rem .7rem;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:inherit}
fieldset{border:1px solid var(--line);border-radius:8px;margin:1rem 0;padding:.5rem 1rem}
legend{font-weight:600;padding:0 .3rem}
label.check{display:flex;gap:.5rem;align-items:baseline;margin:.35rem 0;font-weight:400}
.error{color:var(--error);font-weight:600}
.tag{font-size:.8rem;color:var(--accent);margin-left:.4rem}
.actions{display:flex;gap:.75rem;margin-top:1.5rem}
button{padding:.6rem 1.1rem;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--fg);font:inherit;cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
`;

function layout(nonce: string, title: string, body: string, css = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Inked</title><style nonce="${nonce}">${BASE_CSS}${css}</style></head>
<body><main><p class="brand">Inked</p><h1>${esc(title)}</h1>${body}</main></body></html>`;
}

function formHtml<T>(page: ApprovalPage<T>, csrf: string, error?: string, form?: URLSearchParams): string {
  return `<p class="intro">${esc(page.intro)}</p>${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
<form method="post"><input type="hidden" name="csrf" value="${csrf}">${page.fields(form)}
<div class="actions"><button class="primary" type="submit" name="_action" value="submit">${esc(page.submitLabel)}</button>
<button type="submit" name="_action" value="cancel" formnovalidate>Cancel</button></div></form>`;
}

/** The request body, or null when it is larger than MAX_BODY. */
function readBody(req: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size <= MAX_BODY) chunks.push(c);
    });
    req.on('end', () => resolve(size > MAX_BODY ? null : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Starts the default browser on `url`. Resolves false when that clearly failed. */
export function openBrowser(url: string): Promise<boolean> {
  const [cmd, args]: [string, string[]] =
    process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true });
      child.on('error', () => resolve(false));
      // explorer.exe exits with 1 even when it opened the page.
      child.on('exit', (code) => resolve(process.platform === 'win32' || code === 0));
      child.unref();
    } catch {
      resolve(false);
    }
  });
}

/**
 * One-shot local pages for steps only the user may take. Each page lives on 127.0.0.1 behind a
 * random token, accepts one successful submit, and closes. One page at a time.
 */
export class ApprovalServer {
  private busy = false;

  constructor(private readonly opts: { timeoutMs?: number; openBrowser?: (url: string) => Promise<boolean> } = {}) {}

  async open<T>(page: ApprovalPage<T>): Promise<OpenedPage<T>> {
    if (this.busy) {
      throw new ToolError('busy', 'An Inked page is already open in the browser. Ask the user to finish or cancel it first.');
    }
    this.busy = true;
    try {
      return await this.serve(page);
    } catch (e) {
      this.busy = false;
      throw e;
    }
  }

  private async serve<T>(page: ApprovalPage<T>): Promise<OpenedPage<T>> {
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const nonce = randomBytes(16).toString('base64url');
    let settle!: (o: PageOutcome<T>) => void;
    const result = new Promise<PageOutcome<T>>((r) => {
      settle = r;
    });
    let finished = false;
    let submitting = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const server = createServer((req, res) => {
      handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    const finish = (o: PageOutcome<T>) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      server.close();
      server.closeIdleConnections();
      this.busy = false;
      settle(o);
    };

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    // A later server error closes the page; unhandled, it would crash `serve`.
    server.on('error', () => finish({ outcome: 'timed_out' }));
    const { port } = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${port}`;
    const pathname = `/t/${token}`;
    const expire = () => {
      if (submitting) timer = setTimeout(expire, 1000);
      else finish({ outcome: 'timed_out' });
    };
    timer = setTimeout(expire, this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const send = (res: ServerResponse, status: number, title: string, body: string) => {
      res.writeHead(status, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; style-src 'nonce-${nonce}'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
        'Cache-Control': 'no-store',
        // same-origin, not no-referrer: with no-referrer, browsers send "Origin: null" on the form POST.
        'Referrer-Policy': 'same-origin',
        'X-Content-Type-Options': 'nosniff',
        Connection: 'close',
      });
      res.end(layout(nonce, title, body, page.css));
    };

    const handle = async (req: IncomingMessage, res: ServerResponse) => {
      // The Host check stops DNS rebinding: a web page on another name cannot reach this server.
      if (req.headers.host !== `127.0.0.1:${port}`) return send(res, 421, 'Wrong address', '<p>Open the link exactly as given.</p>');
      if (req.url !== pathname) return send(res, 404, 'Not found', '<p>This page does not exist.</p>');
      if (finished) return send(res, 410, 'Page closed', '<p>This page has closed. Go back to Claude Code.</p>');
      if (req.method === 'GET') return send(res, 200, page.title, formHtml(page, csrf));
      if (req.method !== 'POST') return send(res, 405, 'Not allowed', '<p>Use the form.</p>');
      const from = req.headers.origin;
      if (from !== undefined && from !== origin) return send(res, 403, 'Refused', '<p>This form can only be sent from its own page.</p>');
      const raw = await readBody(req);
      if (raw === null) return send(res, 413, 'Too large', '<p>That was too much text.</p>');
      // The page may have timed out or been cancelled while the body was arriving.
      if (finished) return send(res, 410, 'Page closed', '<p>This page has closed. Go back to Claude Code.</p>');
      const form = new URLSearchParams(raw);
      if (!sameToken(form.get('csrf') ?? '', csrf)) return send(res, 403, 'Refused', '<p>This form expired. Reload the page.</p>');
      if (submitting) return send(res, 409, page.title, '<p>Still working on your last submit. Wait a moment.</p>');
      if (form.get('_action') === 'cancel') {
        send(res, 200, 'Cancelled', '<p>Nothing changed. You can close this tab and go back to Claude Code.</p>');
        return finish({ outcome: 'cancelled' });
      }
      submitting = true;
      try {
        const value = await page.submit(form);
        send(res, 200, 'Done', `<p>${esc(page.done(value))}</p><p class="hint">You can close this tab and go back to Claude Code.</p>`);
        finish({ outcome: 'done', value });
      } catch (e) {
        const message = e instanceof PageError ? e.message : 'Something went wrong. Try again.';
        send(res, 200, page.title, formHtml(page, csrf, message, form));
      } finally {
        submitting = false;
      }
    };

    const url = `${origin}${pathname}`;
    const launched = (this.opts.openBrowser ?? openBrowser)(url).catch(() => false);
    return { url, result, launched };
  }
}
