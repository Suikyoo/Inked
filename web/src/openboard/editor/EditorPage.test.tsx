// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ObLink, ObPayload } from 'inked-core';
import { EditorPage } from './EditorPage';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const at = '2026-10-20T10:00:00.000Z';
const V1 = '11111111-1111-4111-8111-111111111111';
const V2 = '22222222-2222-4222-8222-222222222222';

function full(): ObPayload {
  return {
    vaults: [
      { id: V1, name: 'Research', color: '#7452e0', updatedAt: at , origin: 'published' },
      { id: V2, name: 'Recipes', color: '#45a89e', updatedAt: at , origin: 'published' },
    ],
    folders: [{ id: 'f1', vaultId: V1, parentId: null, name: 'Ops' }],
    notes: [
      { id: 'n1', vaultId: V1, folderId: null, title: 'Alpha', body: 'Alpha body', createdAt: at, updatedAt: at },
      { id: 'n2', vaultId: V1, folderId: 'f1', title: 'Beta', body: 'Beta body', createdAt: at, updatedAt: at, visitorEdited: true },
      { id: 'n3', vaultId: V2, folderId: null, title: 'Soup', body: 'Soup body', createdAt: at, updatedAt: at },
    ],
  };
}
const withoutBodies = (p: ObPayload): ObPayload => ({ ...p, notes: p.notes.map((n) => ({ ...n, body: '' })) });
const onlyVault = (p: ObPayload, id: string): ObPayload => ({
  vaults: p.vaults.filter((v) => v.id === id),
  folders: p.folders.filter((f) => f.vaultId === id),
  notes: p.notes.filter((n) => n.vaultId === id),
});

const links = (): ObLink[] => [
  { id: 'l1', label: 'Reading group', token: 'tok-aaa', vaultIds: [V1], views: 3, permission: 'read', createdAt: at },
  { id: 'l2', label: 'Family', token: 'tok-bbb', vaultIds: [V2], views: 1, permission: 'write', createdAt: at },
];

interface Server {
  me: number;
  content: ObPayload;
  contentStatus: number;
  links: ObLink[];
}
let server: Server;
let fetchMock: ReturnType<typeof vi.fn>;

const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function route(url: string, init: RequestInit = {}): Response {
  const method = (init.method ?? 'GET').toUpperCase();
  const u = new URL(url, 'http://localhost');
  if (u.pathname === '/api/me') return server.me === 200 ? json(200, { user: { id: 'u1', username: 'alice' } }) : json(server.me, { error: 'unauthorized' });
  if (u.pathname === '/api/openboard/links' && method === 'GET') return json(200, server.links);
  if (u.pathname === '/api/openboard/links' && method === 'POST') {
    const body = JSON.parse(String(init.body)) as { label: string; vaultIds: string[]; permission?: ObLink['permission'] };
    const link: ObLink = { id: 'l3', label: body.label, token: 'tok-new', vaultIds: body.vaultIds, views: 0, permission: body.permission ?? 'read', createdAt: at };
    server.links = [...server.links, link];
    return json(201, link);
  }
  const linkM = u.pathname.match(/^\/api\/openboard\/links\/([^/]+)$/);
  if (linkM && method === 'DELETE') {
    server.links = server.links.filter((l) => l.id !== linkM[1]);
    return json(204, null);
  }
  if (linkM && method === 'PATCH') {
    const patch = JSON.parse(String(init.body)) as Partial<ObLink>;
    const link = { ...server.links.find((l) => l.id === linkM[1])!, ...patch };
    server.links = server.links.map((l) => (l.id === link.id ? link : l));
    return json(200, link);
  }
  if (u.pathname === '/api/openboard/content') return server.contentStatus === 200 ? json(200, withoutBodies(server.content)) : json(server.contentStatus, {});
  if (u.pathname === '/api/openboard/preview') {
    const linkId = u.searchParams.get('linkId');
    if (!linkId) return json(200, server.content);
    const link = server.links.find((l) => l.id === linkId)!;
    return json(200, { ...server.content, ...onlyVault(server.content, link.vaultIds[0]!) });
  }
  if (u.pathname === '/api/openboard/vaults' && method === 'POST') {
    const body = JSON.parse(String(init.body)) as { name: string; color: string };
    if (server.content.vaults.some((v) => v.name === body.name)) return json(409, { error: 'name_taken' });
    const vault = { id: 'vn', name: body.name, color: body.color, updatedAt: at, origin: 'native' as const };
    server.content = { ...server.content, vaults: [...server.content.vaults, vault] };
    return json(201, vault);
  }
  if (u.pathname === '/api/openboard/folders' && method === 'POST') {
    const body = JSON.parse(String(init.body)) as { vaultId: string; parentId: string | null; name: string };
    const folder = { id: 'fn', ...body };
    server.content = { ...server.content, folders: [...server.content.folders, folder] };
    return json(201, folder);
  }
  if (u.pathname === '/api/openboard/notes' && method === 'POST') {
    const body = JSON.parse(String(init.body)) as { vaultId: string; folderId: string | null; title: string; body: string };
    const note = { id: 'nn', ...body, createdAt: at, updatedAt: at };
    server.content = { ...server.content, notes: [...server.content.notes, note] };
    return json(201, note);
  }
  const patchNote = u.pathname.match(/^\/api\/openboard\/notes\/([^/]+)$/);
  if (patchNote && method === 'PATCH') {
    const body = JSON.parse(String(init.body)) as { title?: string; body?: string; baseUpdatedAt: string };
    const old = server.content.notes.find((n) => n.id === patchNote[1])!;
    const next = { ...old, ...(body.title === undefined ? {} : { title: body.title }), ...(body.body === undefined ? {} : { body: body.body }), updatedAt: '2026-10-25T10:00:00.000Z', ownerEdited: true };
    server.content = { ...server.content, notes: server.content.notes.map((n) => (n.id === next.id ? next : n)) };
    return json(200, next);
  }
  const del = u.pathname.match(/^\/api\/openboard\/(vaults|folders|notes)\/([^/]+)$/);
  if (del && method === 'DELETE') {
    const id = del[2];
    if (del[1] === 'notes') server.content = { ...server.content, notes: server.content.notes.filter((n) => n.id !== id) };
    return json(204, null);
  }
  return json(404, { error: 'not_found' });
}

let root: Root | null = null;
let host: HTMLElement | null = null;

async function flush() {
  for (let i = 0; i < 6; i++) await act(async () => {});
}
async function render() {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root!.render(<EditorPage />));
  await flush();
}

const q = <T extends Element = HTMLElement>(sel: string) => host!.querySelector<T>(sel);
const qa = <T extends Element = HTMLElement>(sel: string) => Array.from(host!.querySelectorAll<T>(sel));
const button = (text: string, scope: ParentNode = host!) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent?.trim() === text)!;
const openDialog = () => qa<HTMLDialogElement>('dialog').find((d) => d.hasAttribute('open') && d.querySelector('.dialog-body'))!;
const rows = () => qa('.obe-link');
const rowFor = (label: string) => rows().find((r) => r.textContent?.includes(label))!;
const calls = (pred: (url: string, method: string) => boolean) =>
  fetchMock.mock.calls.filter(([url, init]) => pred(String(url), ((init as RequestInit | undefined)?.method ?? 'GET').toUpperCase()));

async function click(el: Element) {
  await act(async () => (el as HTMLElement).click());
  await flush();
}
function type(input: HTMLInputElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function select(el: HTMLSelectElement, value: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
  await act(async () => {
    set.call(el, value);
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await flush();
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  window.history.replaceState(null, '', '/openboard');
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  server = { me: 200, content: full(), contentStatus: 200, links: links() };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => route(url, init));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  vi.unstubAllGlobals();
});

describe('EditorPage', () => {
  it('lists links with their URL, label, vault chips and view counts', async () => {
    await render();
    expect(rows()).toHaveLength(2);
    const r1 = rowFor('Reading group');
    expect(r1.querySelector<HTMLInputElement>('.obe-url')!.value).toBe(`${location.origin}/ob/tok-aaa`);
    expect(r1.querySelector('.obe-chips')!.textContent).toContain('Research');
    expect(r1.textContent).toContain('3 views');
    expect(rowFor('Family').textContent).toContain('1 view');
    // Same-origin session calls only; the editor never touches the counting visitor endpoint.
    for (const [url, init] of fetchMock.mock.calls) {
      expect(String(url)).not.toMatch(/^\/api\/ob\//);
      expect((init as RequestInit).credentials).toBe('same-origin');
    }
  });

  it('keeps Create disabled until a label is entered and a vault is chosen, then creates the link', async () => {
    await render();
    await click(button('+ New link'));
    const dlg = openDialog();
    const create = button('Create', dlg);
    expect(create.disabled).toBe(true);
    type(dlg.querySelector<HTMLInputElement>('input[type="text"]')!, 'Class notes');
    expect(create.disabled).toBe(true);
    const box = Array.from(dlg.querySelectorAll<HTMLLabelElement>('label')).find((l) => l.textContent?.includes('Recipes'))!.querySelector('input')!;
    await click(box);
    expect(create.disabled).toBe(false);
    type(dlg.querySelector<HTMLInputElement>('input[type="text"]')!, '   ');
    expect(create.disabled).toBe(true);
    type(dlg.querySelector<HTMLInputElement>('input[type="text"]')!, 'Class notes');
    await click(create);
    const [post] = calls((u, m) => u === '/api/openboard/links' && m === 'POST');
    expect(post).toBeDefined();
    const init = post![1] as RequestInit;
    expect((init.headers as Record<string, string>)['X-Inked']).toBe('1');
    expect(JSON.parse(String(init.body))).toEqual({ label: 'Class notes', vaultIds: [V2], permission: 'read' });
    expect(rowFor('Class notes')).toBeDefined();
  });

  it('new links default to Read; choosing Write creates an edit link', async () => {
    await render();
    await click(button('+ New link'));
    const dlg = openDialog();
    const radio = (value: string) => dlg.querySelector<HTMLInputElement>(`input[type="radio"][value="${value}"]`)!;
    expect(radio('read').checked).toBe(true);
    expect(radio('write').checked).toBe(false);
    type(dlg.querySelector<HTMLInputElement>('input[type="text"]')!, 'Editors');
    await click(Array.from(dlg.querySelectorAll<HTMLLabelElement>('label')).find((l) => l.textContent?.includes('Recipes'))!.querySelector('input')!);
    await click(radio('write'));
    expect(dlg.textContent).toContain('Republishing replaces their changes');
    await click(button('Create', dlg));
    const [post] = calls((u, m) => u === '/api/openboard/links' && m === 'POST');
    expect(JSON.parse(String((post![1] as RequestInit).body))).toMatchObject({ label: 'Editors', permission: 'write' });
    expect(rowFor('Editors').querySelector('.obe-perm-badge')!.textContent).toBe('Can edit');
  });

  it('shows each link\x27s permission', async () => {
    await render();
    expect(rowFor('Reading group').querySelector('.obe-perm-badge')!.textContent).toBe('Read only');
    expect(rowFor('Family').querySelector('.obe-perm-badge')!.textContent).toBe('Can edit');
  });

  it('shows how to publish instead of the form when nothing is published', async () => {
    server.content = { vaults: [], folders: [], notes: [] };
    server.links = [];
    await render();
    await click(button('+ New link'));
    const dlg = openDialog();
    expect(dlg.textContent).toContain('Publish to openboard');
    expect(button('Create', dlg)).toBeUndefined();
  });

  it('Copy writes the full URL to the clipboard and confirms', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await render();
    await click(button('Copy', rowFor('Family')));
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/ob/tok-bbb`);
    expect(rowFor('Family').textContent).toContain('Copied');
  });

  it('Copy falls back to selecting the address when the clipboard is unavailable', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    await render();
    await click(button('Copy', rowFor('Family')));
    const input = rowFor('Family').querySelector<HTMLInputElement>('.obe-url')!;
    expect(document.activeElement).toBe(input);
    expect(rowFor('Family').textContent).toMatch(/Ctrl\+C/);
  });

  it('Delete asks first: cancel keeps the row, confirm deletes it', async () => {
    await render();
    await click(button('Delete', rowFor('Reading group')));
    await click(button('Cancel', openDialog()));
    expect(calls((_u, m) => m === 'DELETE')).toHaveLength(0);
    expect(rows()).toHaveLength(2);

    await click(button('Delete', rowFor('Reading group')));
    await click(button('Delete', openDialog()));
    const del = calls((u, m) => u === '/api/openboard/links/l1' && m === 'DELETE');
    expect(del).toHaveLength(1);
    expect(((del[0]![1] as RequestInit).headers as Record<string, string>)['X-Inked']).toBe('1');
    expect(rows()).toHaveLength(1);
    expect(rows().some((r) => r.textContent?.includes('Reading group'))).toBe(false);
  });

  it('Edit saves the checked vaults and the permission through PATCH', async () => {
    await render();
    await click(button('Edit', rowFor('Reading group')));
    const dlg = openDialog();
    const box = Array.from(dlg.querySelectorAll<HTMLLabelElement>('label')).find((l) => l.textContent?.includes('Recipes'))!.querySelector('input')!;
    await click(box);
    await click(button('Save', dlg));
    const [patch] = calls((u, m) => u === '/api/openboard/links/l1' && m === 'PATCH');
    expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({ vaultIds: [V1, V2], permission: 'read' });
    expect(rowFor('Reading group').querySelector('.obe-chips')!.textContent).toContain('Recipes');
  });

  it('Edit changes a write link back to read', async () => {
    await render();
    await click(button('Edit', rowFor('Family')));
    const dlg = openDialog();
    const read = dlg.querySelector<HTMLInputElement>('input[type="radio"][value="read"]')!;
    expect(dlg.querySelector<HTMLInputElement>('input[type="radio"][value="write"]')!.checked).toBe(true);
    await click(read);
    await click(button('Save', dlg));
    const [patch] = calls((u, m) => u === '/api/openboard/links/l2' && m === 'PATCH');
    expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({ vaultIds: [V2], permission: 'read' });
    expect(rowFor('Family').querySelector('.obe-perm-badge')!.textContent).toBe('Read only');
  });

  it('marks notes visitors edited in the published tree', async () => {
    await render();
    await click(button('Published content'));
    const row = (title: string) => qa('.obe-tree-row').find((r) => r.textContent?.includes(title))!;
    expect(row('Beta').querySelector('.obe-visitor-tag')!.textContent).toBe('Edited by a visitor');
    expect(row('Alpha').querySelector('.obe-visitor-tag')).toBeNull();
  });

  it('Unpublish confirms, calls DELETE and refreshes the published content', async () => {
    await render();
    await click(button('Published content'));
    const before = calls((u) => u === '/api/openboard/content').length;
    const soup = qa('.obe-tree-row').find((r) => r.textContent?.includes('Soup'))!;
    await click(button('Unpublish', soup));
    const dlg = openDialog();
    expect(dlg.textContent).toContain('Soup');
    expect(dlg.textContent).toMatch(/links/i);
    await click(button('Unpublish', dlg));
    const del = calls((u, m) => u === '/api/openboard/notes/n3' && m === 'DELETE');
    expect(del).toHaveLength(1);
    expect(((del[0]![1] as RequestInit).headers as Record<string, string>)['X-Inked']).toBe('1');
    expect(calls((u) => u === '/api/openboard/content').length).toBeGreaterThan(before);
    expect(qa('.obe-tree-row').some((r) => r.textContent?.includes('Soup'))).toBe(false);
  });

  it('"Preview as" a link refetches its preview and the map shows only its vaults', async () => {
    await render();
    await click(button('Published content'));
    const nodes = () => qa<SVGGElement>('g.cmap-node').map((n) => n.dataset.note).sort();
    expect(nodes()).toEqual(['n1', 'n2', 'n3']);
    const sel = q<HTMLSelectElement>('select#obe-preview-as')!;
    expect(Array.from(sel.options).map((o) => o.textContent)).toEqual(['All published', 'Reading group', 'Family']);
    await select(sel, 'l1');
    expect(calls((u) => u === '/api/openboard/preview?linkId=l1')).toHaveLength(1);
    expect(nodes()).toEqual(['n1', 'n2']);
  });

  it('opens a note from the tree in the reader drawer', async () => {
    await render();
    await click(button('Published content'));
    const beta = qa('.obe-tree-row').find((r) => r.textContent?.includes('Beta'))!;
    await click(beta.querySelector('.obe-tree-open')!);
    expect(q('.ob-drawer')!.textContent).toContain('Beta body');
  });

  it('shows a sign-in prompt when the session check is 401', async () => {
    server.me = 401;
    await render();
    const a = q<HTMLAnchorElement>('a[href="/login"]')!;
    expect(a.textContent).toContain('Sign in to Inked');
    expect(rows()).toHaveLength(0);
  });

  it('shows the sign-in prompt when the content call is 401', async () => {
    server.contentStatus = 401;
    await render();
    expect(q<HTMLAnchorElement>('a[href="/login"]')!.textContent).toContain('Sign in to Inked');
  });

  it('shows an inline alert when a call fails', async () => {
    server.contentStatus = 500;
    await render();
    expect(q('[role="alert"]')).not.toBeNull();
  });
});

describe('authoring in the openboard control', () => {
  /** Opens the Content tab with the given payload already published. */
  async function content(payload = full()) {
    server.content = payload;
    await render();
    await click(button('Published content'));
  }

  const nativePayload = (): ObPayload => ({
    vaults: [{ id: 'vn', name: 'Scratch', color: '#45a89e', updatedAt: at, origin: 'native' }],
    folders: [],
    notes: [{ id: 'nn', vaultId: 'vn', folderId: null, title: 'Only copy', body: 'written here', createdAt: at, updatedAt: at }],
  });

  it('edits a published note through the owner route', async () => {
    await content();
    await click(q('.obe-side .ob-row-note')!);
    await click(button('Edit', q('.ob-drawer')!));

    const body = q<HTMLTextAreaElement>('.ob-editor-body')!;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      set.call(body, 'fixed in openboard');
      body.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('Save', q('.ob-editor')!));

    expect(calls((url, m) => m === 'PATCH' && url.startsWith('/api/openboard/notes/'))).toHaveLength(1);
  });

  it('asks before dropping an unsaved edit, and keeps it when refused', async () => {
    await content();
    await click(q('.obe-side .ob-row-note')!);
    await click(button('Edit', q('.ob-drawer')!));

    const body = q<HTMLTextAreaElement>('.ob-editor-body')!;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      set.call(body, 'unsaved work');
      body.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      await click(q('.ob-drawer .ibtn')!);
      expect(confirmSpy).toHaveBeenCalled();
      // Refused: the editor and the draft are still there.
      expect(q<HTMLTextAreaElement>('.ob-editor-body')?.value).toBe('unsaved work');
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('drops the edit when the owner agrees', async () => {
    await content();
    await click(q('.obe-side .ob-row-note')!);
    await click(button('Edit', q('.ob-drawer')!));
    const body = q<HTMLTextAreaElement>('.ob-editor-body')!;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    act(() => {
      set.call(body, 'unsaved work');
      body.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      await click(q('.ob-drawer .ibtn')!);
      expect(q('.ob-editor')).toBeNull();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('creates a native vault, and says its content is unencrypted', async () => {
    await content({ vaults: [], folders: [], notes: [] });
    const form = q('.obe-new-vault')!;
    expect(form.textContent?.toLowerCase()).toContain('unencrypted');

    type(form.querySelector('input')!, 'Scratch');
    await click(button('Create vault', form));
    expect(calls((url, m) => m === 'POST' && url === '/api/openboard/vaults')).toHaveLength(1);
  });

  it('shows the name_taken refusal when the name is already in use', async () => {
    await content();
    const form = q('.obe-new-vault')!;
    type(form.querySelector('input')!, 'Research');
    await click(button('Create vault', form));
    expect(q('.obe-new-vault .form-error')?.textContent).toMatch(/already/i);
  });

  it('badges a native vault in the tree', async () => {
    await content(nativePayload());
    expect(q('.obe-side')!.textContent).toContain('Openboard-only');
  });

  it('offers New folder and New note only inside a native vault', async () => {
    await content();
    expect(button('New note', q('.obe-side')!)).toBeUndefined();
    await content(nativePayload());
    expect(button('New note', q('.obe-side')!)).toBeDefined();
    expect(button('New folder', q('.obe-side')!)).toBeDefined();
  });

  it('creates a note in a native vault', async () => {
    await content(nativePayload());
    await click(button('New note', q('.obe-side')!));
    type(openDialog().querySelector('input')!, 'Second');
    await click(button('Create', openDialog()));
    expect(calls((url, m) => m === 'POST' && url === '/api/openboard/notes')).toHaveLength(1);
  });

  it('warns that deleting a native vault destroys the only copy', async () => {
    await content(nativePayload());
    await click(button('Delete', q('.obe-side')!));
    expect(openDialog().textContent).toMatch(/only copy|for good/i);
    expect(openDialog().textContent).not.toContain('Your notes in Inked don’t change.');
  });

  it('keeps the unpublish wording for a published vault', async () => {
    await content();
    await click(button('Unpublish', q('.obe-side')!));
    expect(openDialog().textContent).toContain('Your notes in Inked don’t change.');
  });
});
