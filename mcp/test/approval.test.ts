import { describe, expect, it } from 'vitest';
import { ApprovalServer, esc, PageError, type ApprovalPage } from '../src/approval';
import { fakeBrowser, loadPage, statusWithHost, submitPage } from './helpers/page';

function testPage(submit = async (f: URLSearchParams) => f.get('name') ?? ''): ApprovalPage<string> {
  return {
    title: 'Test page',
    intro: 'Say a name.',
    submitLabel: 'Send',
    fields: (f) => `<input type="text" name="name" value="${esc(f?.get('name') ?? '')}">`,
    submit,
    done: (v) => `Hello ${v}`,
  };
}

describe('ApprovalServer', () => {
  it('serves the form only at the token path, with strict headers and no scripts', async () => {
    const browser = fakeBrowser();
    const p = await new ApprovalServer({ openBrowser: browser.open }).open(testPage());
    expect(await browser.next()).toBe(p.url);
    expect(p.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/t\/[A-Za-z0-9_-]{43}$/);
    const { res, html } = await loadPage(p.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('referrer-policy')).toBe('same-origin');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(html).toContain('Say a name.');
    expect(html).not.toMatch(/<script/i);
    expect((await fetch(new URL('/t/wrong', p.url))).status).toBe(404);
    expect((await fetch(new URL('/', p.url))).status).toBe(404);
    await submitPage(p.url, {}, 'cancel');
  });

  it('refuses a foreign Host, a foreign Origin and a bad CSRF token; accepts its own Origin or none', async () => {
    const p = await new ApprovalServer({ openBrowser: fakeBrowser().open }).open(testPage());
    expect(await statusWithHost(p.url, 'evil.example')).toBe(421);
    expect((await submitPage(p.url, { name: 'x' }, 'submit', { origin: 'http://evil.example' })).res.status).toBe(403);
    expect((await submitPage(p.url, { name: 'x' }, 'submit', { csrf: 'nope' })).res.status).toBe(403);
    expect((await submitPage(p.url, { name: 'Ada' }, 'submit', { origin: null })).res.status).toBe(200);
    expect(await p.result).toEqual({ outcome: 'done', value: 'Ada' });
  });

  it('accepts a submit from its own Origin and closes afterwards', async () => {
    const p = await new ApprovalServer({ openBrowser: fakeBrowser().open }).open(testPage());
    const { html } = await submitPage(p.url, { name: 'Ada' });
    expect(html).toContain('Hello Ada');
    expect(await p.result).toEqual({ outcome: 'done', value: 'Ada' });
    await expect(fetch(p.url)).rejects.toThrow();
  });

  it('shows a PageError, escapes what was typed, and stays open for another try', async () => {
    let tries = 0;
    const p = await new ApprovalServer({ openBrowser: fakeBrowser().open }).open(
      testPage(async (f) => {
        if (++tries === 1) throw new PageError('Wrong name.');
        return f.get('name') ?? '';
      }),
    );
    const first = await submitPage(p.url, { name: '<b>x</b>' });
    expect(first.html).toContain('Wrong name.');
    expect(first.html).toContain('&lt;b&gt;x&lt;/b&gt;');
    await submitPage(p.url, { name: 'Ada' });
    expect(await p.result).toEqual({ outcome: 'done', value: 'Ada' });
  });

  it('hides unexpected errors behind a generic message', async () => {
    const p = await new ApprovalServer({ openBrowser: fakeBrowser().open }).open(
      testPage(async () => {
        throw new Error('secret detail');
      }),
    );
    const { html } = await submitPage(p.url, { name: 'x' });
    expect(html).toContain('Something went wrong. Try again.');
    expect(html).not.toContain('secret detail');
    await submitPage(p.url, {}, 'cancel');
    expect(await p.result).toEqual({ outcome: 'cancelled' });
  });

  it('times out, but never in the middle of a submit', async () => {
    const quick = await new ApprovalServer({ timeoutMs: 50, openBrowser: fakeBrowser().open }).open(testPage());
    expect(await quick.result).toEqual({ outcome: 'timed_out' });
    // Submitted at once; the timeout fires at 200 ms, mid-submit, and must wait for it.
    const slow = await new ApprovalServer({ timeoutMs: 200, openBrowser: fakeBrowser().open }).open(
      testPage(async (f) => {
        await new Promise((r) => setTimeout(r, 500));
        return f.get('name') ?? '';
      }),
    );
    await submitPage(slow.url, { name: 'Ada' });
    expect(await slow.result).toEqual({ outcome: 'done', value: 'Ada' });
  });

  it('allows one page at a time', async () => {
    const approvals = new ApprovalServer({ openBrowser: fakeBrowser().open });
    const p = await approvals.open(testPage());
    await expect(approvals.open(testPage())).rejects.toThrow('already open');
    await submitPage(p.url, {}, 'cancel');
    await p.result;
    const q = await approvals.open(testPage());
    await submitPage(q.url, {}, 'cancel');
    expect(await q.result).toEqual({ outcome: 'cancelled' });
  });

  it('reports a browser that did not start', async () => {
    const p = await new ApprovalServer({ timeoutMs: 50, openBrowser: async () => false }).open(testPage());
    expect(await p.launched).toBe(false);
    await p.result;
  });

  it('refuses a body over 64 KB', async () => {
    const p = await new ApprovalServer({ openBrowser: fakeBrowser().open }).open(testPage());
    expect((await submitPage(p.url, { name: 'x'.repeat(70_000) })).res.status).toBe(413);
    await submitPage(p.url, {}, 'cancel');
  });
  it('refuses a cancel while a submit is still running', async () => {
    let started!: () => void;
    const running = new Promise<void>((r) => {
      started = r;
    });
    const p = await new ApprovalServer({ timeoutMs: 30_000, openBrowser: fakeBrowser().open }).open(
      testPage(async (f) => {
        started();
        await new Promise((r) => setTimeout(r, 300));
        return f.get('name') ?? '';
      }),
    );
    const { csrf } = await loadPage(p.url);
    const first = submitPage(p.url, { name: 'Ada' }, 'submit', { csrf });
    await running;
    expect((await submitPage(p.url, {}, 'cancel', { csrf })).res.status).toBe(409);
    await first;
    expect(await p.result).toEqual({ outcome: 'done', value: 'Ada' });
  });
});
