// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObPublicResponse } from 'inked-core';
import { VisitorPage } from './VisitorPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = '2026-10-20T10:00:00.000Z';
const later = '2026-10-21T10:00:00.000Z';

function payload(permission: ObPublicResponse['permission'] = 'read'): ObPublicResponse {
  return {
    label: 'Reading group',
    permission,
    vaults: [{ id: 'v1', name: 'Research', color: '#7452e0', updatedAt: later }],
    folders: [{ id: 'f1', vaultId: 'v1', parentId: null, name: 'Ops' }],
    notes: [
      { id: 'n1', vaultId: 'v1', folderId: null, title: 'Alpha', body: '## Alpha heading\n\nSee [[Beta]].', createdAt: at, updatedAt: later },
      { id: 'n2', vaultId: 'v1', folderId: 'f1', title: 'Beta', body: 'Beta body', createdAt: at, updatedAt: at },
      { id: 'n3', vaultId: 'v1', folderId: 'f1', title: 'Foo bar', body: 'Foo body', createdAt: at, updatedAt: at },
      { id: 'ix', vaultId: 'v1', folderId: 'f1', title: 'Index', body: 'About the Ops folder', createdAt: at, updatedAt: at },
    ],
  };
}

let root: Root | null = null;
let host: HTMLElement | null = null;
let fetchMock: ReturnType<typeof vi.fn>;

function respond(status: number, body: unknown) {
  fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
}

async function render() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<VisitorPage />));
  // Let the fetch and its json() settle.
  for (let i = 0; i < 4; i++) await act(async () => {});
}

const q = <T extends Element = HTMLElement>(sel: string) => host!.querySelector<T>(sel);
const qa = (sel: string) => Array.from(host!.querySelectorAll<HTMLElement>(sel));
const label = (r: HTMLElement) => r.querySelector('.ob-row-label')?.textContent?.trim();
const railRows = () => qa('.ob-rail .ob-row-note').map(label);
const railNote = (title: string) => qa('.ob-rail .ob-row-note').find((r) => label(r) === title)!;
const drawer = () => q('.ob-drawer');

function type(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
  act(() => {
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Answers the page load with a payload and each write with the next queued answer (default: echo the change). */
function writeServer(p: ObPublicResponse, answers: Response[] = []) {
  fetchMock.mockImplementation(async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    if (method === 'GET') return json(200, p);
    const queued = answers.shift();
    if (queued) return queued;
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    const edit = url.match(/^\/api\/ob\/tok123\/notes\/([^/]+)$/);
    if (edit && method === 'PATCH') {
      const note = p.notes.find((n) => n.id === edit[1])!;
      return json(200, { ...note, ...body, baseUpdatedAt: undefined, updatedAt: '2026-10-24T10:00:00.000Z', visitorEdited: true });
    }
    if (url === '/api/ob/tok123/notes' && method === 'POST') {
      return json(201, { id: 'new1', ...body, createdAt: later, updatedAt: later, visitorEdited: true });
    }
    return json(404, { error: 'not_found' });
  });
}
const writes = () => fetchMock.mock.calls.filter(([, init]) => ((init as RequestInit | undefined)?.method ?? 'GET') !== 'GET');
const buttonIn = (scope: ParentNode, text: string) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === text);
async function settle() {
  for (let i = 0; i < 6; i++) await act(async () => {});
}
async function press(el: HTMLElement | undefined) {
  await act(async () => el!.click());
  await settle();
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  window.history.replaceState(null, '', '/ob/tok123');
  // Wide enough that the rail starts open.
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

describe('VisitorPage', () => {
  it('fetches the token from the path with no credentials and renders the rail and the map', async () => {
    respond(200, payload());
    await render();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('/api/ob/tok123');
    expect((init as RequestInit).credentials).toBe('omit');
    expect(q('.ob-label')!.textContent).toBe('Reading group');
    expect(q('.ob-rail')!.textContent).toContain('Research');
    expect(q('svg.cmap-svg')).not.toBeNull();
    expect(qa('g.cmap-node').map((n) => n.dataset.note).sort()).toEqual(['n1', 'n2', 'n3']);
    // Visitors get no Ask, no editing controls, no sign-in.
    expect(host!.textContent).not.toMatch(/\bAsk\b|Sign in|New note/);
    expect(drawer()).toBeNull();
  });

  it('clicking a note in the rail opens the drawer with its rendered body and selects it on the map', async () => {
    respond(200, payload());
    await render();
    act(() => railNote('Alpha').click());
    expect(drawer()).not.toBeNull();
    expect(drawer()!.querySelector('h1')!.textContent).toBe('Alpha');
    expect(drawer()!.querySelector('article h2')!.textContent).toBe('Alpha heading');
    expect(q('g.cmap-node[data-note="n1"] .cmap-sel')).not.toBeNull();
    // A [[link]] in the reader opens that note in place.
    act(() => drawer()!.querySelector<HTMLButtonElement>('article button.wl')!.click());
    expect(drawer()!.querySelector('h1')!.textContent).toBe('Beta');
  });

  it('clicking a dot on the map opens the drawer for that note', async () => {
    respond(200, payload());
    await render();
    act(() => q('g.cmap-node[data-note="n3"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(drawer()!.querySelector('h1')!.textContent).toBe('Foo bar');
  });

  it('selecting a folder on the map shows its Index note', async () => {
    respond(200, payload());
    await render();
    act(() => q('g.cmap-folder[data-folder="f1"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(drawer()!.querySelector('article')!.textContent).toContain('About the Ops folder');
  });

  it('title search filters the rail rows and highlights hits on the map', async () => {
    respond(200, payload());
    await render();
    expect(railRows()).toEqual(expect.arrayContaining(['Alpha', 'Beta', 'Foo bar']));
    type(q<HTMLInputElement>('input[type="search"]')!, 'foo');
    expect(railRows()).toEqual(['Foo bar']);
    expect(q('g.cmap-node[data-note="n3"]')!.classList.contains('is-faded')).toBe(false);
    expect(q('g.cmap-node[data-note="n1"]')!.classList.contains('is-faded')).toBe(true);
  });

  it('Escape closes the drawer', async () => {
    respond(200, payload());
    await render();
    act(() => railNote('Beta').click());
    expect(drawer()).not.toBeNull();
    act(() => void window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    // The drawer animates out; wait out its exit.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    expect(drawer()).toBeNull();
  });

  it('a 404 renders the not-found page and no map', async () => {
    respond(404, { error: 'not_found' });
    await render();
    expect(host!.textContent).toContain('This link doesn’t exist or was removed.');
    expect(q('svg.cmap-svg')).toBeNull();
    expect(q('.ob-rail')).toBeNull();
  });

  it('a failed fetch is treated as not found', async () => {
    fetchMock.mockRejectedValue(new TypeError('network'));
    await render();
    expect(host!.textContent).toContain('This link doesn’t exist or was removed.');
    expect(q('svg.cmap-svg')).toBeNull();
  });

  it('a 429 asks the visitor to wait', async () => {
    respond(429, { error: 'rate_limited' });
    await render();
    expect(host!.textContent).toMatch(/Too many tries/);
    expect(q('svg.cmap-svg')).toBeNull();
  });

  it('a path with no token is not found without fetching', async () => {
    window.history.replaceState(null, '', '/ob/');
    await render();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host!.textContent).toContain('This link doesn’t exist or was removed.');
  });

  it('zero vaults renders an empty state, not an error', async () => {
    respond(200, { label: 'Empty', permission: 'read', vaults: [], folders: [], notes: [] });
    await render();
    expect(q('.ob-empty')).not.toBeNull();
    expect(host!.textContent).not.toContain('doesn’t exist');
    expect(q('svg.cmap-svg')).toBeNull();
  });

  it('starts with the rail collapsed under 900px wide', async () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    respond(200, payload());
    await render();
    expect(q('.ob-rail')!.getAttribute('data-collapsed')).toBe('true');
    expect(qa('.ob-rail .ob-row-note')).toHaveLength(0);
    act(() => q<HTMLButtonElement>('.ob-rail-toggle')!.click());
    expect(q('.ob-rail')!.getAttribute('data-collapsed')).toBe('false');
  });
});

describe('VisitorPage on a write link', () => {
  const editor = () => drawer()!.querySelector<HTMLFormElement>('form.ob-editor');
  const titleInput = () => editor()!.querySelector<HTMLInputElement>('input.ob-editor-title')!;
  const bodyInput = () => editor()!.querySelector<HTMLTextAreaElement>('textarea.ob-editor-body')!;

  it('a read link offers no Edit and no New note', async () => {
    writeServer(payload('read'));
    await render();
    act(() => railNote('Alpha').click());
    expect(buttonIn(drawer()!, 'Edit')).toBeUndefined();
    expect(buttonIn(host!, 'New note')).toBeUndefined();
  });

  it('Edit opens the title and Markdown; Save PATCHes anonymously and shows the result', async () => {
    writeServer(payload('write'));
    await render();
    act(() => railNote('Alpha').click());
    await press(buttonIn(drawer()!, 'Edit'));
    expect(titleInput().value).toBe('Alpha');
    expect(bodyInput().value).toBe('## Alpha heading\n\nSee [[Beta]].');
    type(titleInput(), 'Alpha prime');
    type(bodyInput(), 'Rewritten **text**');
    await press(buttonIn(editor()!, 'Save'));

    const [[url, init]] = writes();
    expect(url).toBe('/api/ob/tok123/notes/n1');
    const req = init as RequestInit;
    expect(req.method).toBe('PATCH');
    expect(req.credentials).toBe('omit');
    expect((req.headers as Record<string, string>)['X-Inked']).toBe('1');
    expect(JSON.parse(String(req.body))).toEqual({ baseUpdatedAt: later, title: 'Alpha prime', body: 'Rewritten **text**' });

    expect(editor()).toBeNull();
    expect(drawer()!.querySelector('h1')!.textContent).toBe('Alpha prime');
    expect(drawer()!.querySelector('article strong')!.textContent).toBe('text');
    expect(drawer()!.querySelector('.ob-visitor-tag')).not.toBeNull();
    expect(railRows()).toContain('Alpha prime');
  });

  it('Cancel leaves the note unchanged and sends nothing', async () => {
    writeServer(payload('write'));
    await render();
    act(() => railNote('Alpha').click());
    await press(buttonIn(drawer()!, 'Edit'));
    type(bodyInput(), 'draft');
    await press(buttonIn(editor()!, 'Cancel'));
    expect(editor()).toBeNull();
    expect(drawer()!.querySelector('article h2')!.textContent).toBe('Alpha heading');
    expect(writes()).toHaveLength(0);
  });

  it('Escape in the editor does not close the drawer or drop the draft', async () => {
    writeServer(payload('write'));
    await render();
    act(() => railNote('Alpha').click());
    await press(buttonIn(drawer()!, 'Edit'));
    type(bodyInput(), 'draft');
    act(() => void bodyInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600));
    });
    expect(drawer()).not.toBeNull();
    expect(bodyInput().value).toBe('draft');
  });

  it('a stale save keeps the draft and says someone else changed the note', async () => {
    writeServer(payload('write'), [json(409, { error: 'stale' })]);
    await render();
    act(() => railNote('Alpha').click());
    await press(buttonIn(drawer()!, 'Edit'));
    type(bodyInput(), 'my draft');
    await press(buttonIn(editor()!, 'Save'));
    expect(editor()!.querySelector('[role="alert"]')!.textContent).toContain('Someone else changed this note');
    expect(bodyInput().value).toBe('my draft');
  });

  it('a link turned read-only says editing is off', async () => {
    writeServer(payload('write'), [json(403, { error: 'read_only' })]);
    await render();
    act(() => railNote('Alpha').click());
    await press(buttonIn(drawer()!, 'Edit'));
    await press(buttonIn(editor()!, 'Save'));
    expect(editor()!.querySelector('[role="alert"]')!.textContent).toContain('Editing is turned off for this link');
  });

  it('an Index note keeps its title: the title field is read-only and not sent', async () => {
    writeServer(payload('write'));
    await render();
    act(() => q('g.cmap-folder[data-folder="f1"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await press(buttonIn(drawer()!, 'Edit'));
    expect(titleInput().readOnly).toBe(true);
    type(bodyInput(), 'New hub text');
    await press(buttonIn(editor()!, 'Save'));
    expect(JSON.parse(String((writes()[0]![1] as RequestInit).body))).toEqual({ baseUpdatedAt: at, body: 'New hub text' });
  });

  it('New note defaults to the folder of the note being read, creates it and opens it for editing', async () => {
    writeServer(payload('write'));
    await render();
    act(() => railNote('Beta').click());
    await press(buttonIn(host!, 'New note'));
    const dlg = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog')).find((d) => d.hasAttribute('open'))!;
    const where = dlg.querySelector<HTMLSelectElement>('select')!;
    expect(where.value).toBe('v1:f1');
    expect(Array.from(where.options).map((o) => o.textContent)).toEqual(['Research', 'Research › Ops']);
    const create = buttonIn(dlg, 'Create')!;
    expect(create.disabled).toBe(true);
    type(dlg.querySelector<HTMLInputElement>('input[type="text"]')!, 'Gamma');
    await press(create);

    const [[url, init]] = writes();
    expect(url).toBe('/api/ob/tok123/notes');
    expect((init as RequestInit).credentials).toBe('omit');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ vaultId: 'v1', folderId: 'f1', title: 'Gamma', body: '' });
    expect(railRows()).toContain('Gamma');
    expect(titleInput().value).toBe('Gamma');
  });

  it('New note refuses the reserved Index title before sending', async () => {
    writeServer(payload('write'));
    await render();
    await press(buttonIn(host!, 'New note'));
    const dlg = Array.from(document.querySelectorAll<HTMLDialogElement>('dialog')).find((d) => d.hasAttribute('open'))!;
    expect(dlg.querySelector<HTMLSelectElement>('select')!.value).toBe('v1:');
    type(dlg.querySelector<HTMLInputElement>('input[type="text"]')!, 'Index');
    expect(buttonIn(dlg, 'Create')!.disabled).toBe(true);
    expect(dlg.textContent).toContain('folder pages');
  });
});
