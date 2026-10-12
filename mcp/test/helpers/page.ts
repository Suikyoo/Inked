import { request } from 'node:http';

/** Loads an approval page the way a browser would, and picks out its CSRF token. */
export async function loadPage(url: string) {
  const res = await fetch(url);
  const html = await res.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
  return { res, html, csrf };
}

/** Submits an approval page's form. `origin: null` sends no Origin header, as some browsers do. */
export async function submitPage(
  url: string,
  fields: Record<string, string | string[]>,
  action: 'submit' | 'cancel' = 'submit',
  opts: { csrf?: string; origin?: string | null } = {},
) {
  const csrf = opts.csrf ?? (await loadPage(url)).csrf;
  const body = new URLSearchParams({ csrf, _action: action });
  for (const [k, v] of Object.entries(fields)) for (const x of Array.isArray(v) ? v : [v]) body.append(k, x);
  const origin = opts.origin === undefined ? new URL(url).origin : opts.origin;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(origin ? { Origin: origin } : {}) },
    body,
  });
  return { res, html: await res.text() };
}

/** GET with a forged Host header (fetch cannot set Host). */
export function statusWithHost(url: string, host: string): Promise<number> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = request({ host: u.hostname, port: u.port, path: u.pathname, headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

/** Stands in for the browser opener: records each URL and reports success (or failure). */
export function fakeBrowser(ok = true) {
  const seen: string[] = [];
  const waiting: ((u: string) => void)[] = [];
  const browser = {
    calls: 0,
    open: async (url: string) => {
      browser.calls++;
      const w = waiting.shift();
      if (w) w(url);
      else seen.push(url);
      return ok;
    },
    /** The next URL the server opened. */
    next: () =>
      new Promise<string>((resolve) => {
        const u = seen.shift();
        if (u !== undefined) resolve(u);
        else waiting.push(resolve);
      }),
  };
  return browser;
}
