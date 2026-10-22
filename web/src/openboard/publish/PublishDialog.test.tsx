// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ObLink, ObPayload, PublishConflict } from 'inked-core';
import { folder, note, tree, vault } from '../../map/fixtures';
import type { AppState } from '../../state/store';
import type { CollectStore, PublishTarget } from './collect';
import { PublishDialog } from './PublishDialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IMG = '3f2b8c1e-5d4a-4b6c-9e7f-1a2b3c4d5e6f';
const IMG2 = '4a2b8c1e-5d4a-4b6c-9e7f-1a2b3c4d5e6f';
const OB_VAULT = '11111111-1111-4111-8111-111111111111';
const OB_VAULT2 = '33333333-3333-4333-8333-333333333333';

/** Private vault "Notes" with folder Deep (f2) holding a note that shows two images. */
function fakeStore(): CollectStore {
  const state = {
    vaults: { v1: { ...vault('v1', 'Notes'), color: '#7452e0' } },
    trees: { v1: tree([folder('f2', null, 'Deep')], [note('n2', 'f2', 'Graphs'), ...extraNotes]) },
    bodies: { n2: `![a](inked://${IMG}) ![b](inked://${IMG2})` },
    bodiesReady: { v1: true },
    bodiesFailed: { ...failedBodies },
  } as unknown as AppState;
  return {
    getState: () => state,
    loadTree: async () => undefined,
    loadBodies: async () => undefined,
    loadNote: (v, id) => loadNote(v, id),
    readImage: async () => new Uint8Array([137, 80, 78, 71]),
  };
}
/** Notes added to folder Deep for a test; their bodies are not loaded. */
let extraNotes: ReturnType<typeof note>[];
let failedBodies: Record<string, true>;
let loadNote: CollectStore['loadNote'];

/** What openboard already holds: vault Research with folder Papers. */
const content: ObPayload = {
  vaults: [{ id: OB_VAULT, name: 'Research', color: '#7452e0', updatedAt: '2026-10-01T00:00:00.000Z' }],
  folders: [{ id: '22222222-2222-4222-8222-222222222222', vaultId: OB_VAULT, parentId: null, name: 'Papers' }],
  notes: [],
};

const conflict: PublishConflict = {
  error: 'conflict',
  target: { kind: 'folder', name: 'Deep', path: ['Research', 'Papers'] },
  removes: { folders: 2, notes: 5 },
};

interface Call {
  method: string;
  url: string;
  body: unknown;
}
let calls: Call[];
let publishAnswers: { status: number; body: unknown }[];
let imageStatus: (id: string) => { status: number; body?: unknown };
let listed: ObPayload;
/** What GET /api/openboard/links answers; null makes it fail. */
let links: ObLink[] | null;
const obLink = (label: string, vaultIds: string[]): ObLink => ({
  id: `link-${label}`,
  label,
  token: 'x'.repeat(43),
  vaultIds,
  views: 0,
  createdAt: '2026-10-01T00:00:00.000Z',
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
  calls = [];
  extraNotes = [];
  failedBodies = {};
  loadNote = async () => ({ body: '' });
  listed = content;
  links = [];
  publishAnswers = [{ status: 201, body: { vaultId: OB_VAULT, imageRefs: [IMG, IMG2] } }];
  imageStatus = () => ({ status: 201, body: { id: 'x' } });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      const method = init.method ?? 'GET';
      const body = typeof init.body === 'string' ? JSON.parse(init.body) : init.body;
      calls.push({ method, url, body });
      if (url === '/api/openboard/content') return json(200, listed);
      if (url === '/api/openboard/links') return links ? json(200, links) : json(500, { error: 'internal' });
      if (url === '/api/openboard/publish') {
        const a = publishAnswers.shift() ?? { status: 500, body: { error: 'internal' } };
        return json(a.status, a.body);
      }
      const m = /^\/api\/openboard\/vaults\/[^/]+\/images\/([^/]+)$/.exec(url);
      if (m) {
        const a = imageStatus(m[1]);
        return json(a.status, a.body ?? {});
      }
      return json(404, { error: 'not_found' });
    }),
  );
});

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

let onClose: Mock<() => void>;
function mount(target: PublishTarget) {
  onClose = vi.fn();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<PublishDialog store={fakeStore()} vaultId="v1" target={target} onClose={onClose} />));
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)));
};
const button = (name: string) => [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === name);
const press = async (name: string) => {
  const b = button(name);
  if (!b) throw new Error(`no button ${name}: ${document.body.textContent}`);
  await act(async () => void b.dispatchEvent(new MouseEvent('click', { bubbles: true })));
  await flush();
};
const radio = (label: string) =>
  [...document.querySelectorAll<HTMLLabelElement>('label')].find((l) => l.textContent?.trim() === label)?.querySelector('input');
const text = () => document.body.textContent ?? '';
const publishCalls = () => calls.filter((c) => c.url === '/api/openboard/publish');
const imageCalls = () => calls.filter((c) => c.url.includes('/images/'));

async function toPicker() {
  mount({ kind: 'folder', id: 'f2' });
  expect(text()).toContain('Published content is stored readable by the server and anyone with a link.');
  await press('Continue');
}

async function publishIntoPapers() {
  await toPicker();
  const papers = radio('Papers');
  expect(papers).toBeTruthy();
  await act(async () => void papers!.click());
  await press('Publish');
}

describe('PublishDialog', () => {
  it('Cancel on the notice closes without any request', async () => {
    mount({ kind: 'folder', id: 'f2' });
    await press('Cancel');
    expect(onClose).toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('a folder publish shows the openboard tree as destinations', async () => {
    await toPicker();
    expect(calls.map((c) => c.url).sort()).toEqual(['/api/openboard/content', '/api/openboard/links']);
    expect(radio('Research')).toBeTruthy();
    expect(radio('Papers')).toBeTruthy();
    expect(text()).toContain('New vault on openboard');
    expect(publishCalls()).toHaveLength(0);
  });

  it('without published vaults the picker offers only a new vault, named after the private vault', async () => {
    listed = { vaults: [], folders: [], notes: [] };
    await toPicker();
    expect(radio('Research')).toBeFalsy();
    const name = document.querySelector<HTMLInputElement>('input[type=text]');
    expect(name?.value).toBe('Notes');
    await press('Publish');
    expect(publishCalls()[0]!.body).toMatchObject({ kind: 'folder', vaultName: 'Notes', destPath: [], color: '#7452e0', overwrite: false });
  });

  it('a default new-vault name equal to a published vault selects that vault and says it will be added to it', async () => {
    listed = { ...content, vaults: [...content.vaults, { id: OB_VAULT2, name: 'Notes', color: '#45A89E', updatedAt: '2026-10-01T00:00:00.000Z' }] };
    await toPicker();
    expect(radio('Notes')?.checked).toBe(true);
    expect(radio('+ New vault on openboard')?.checked).toBe(false);
    expect(text()).toContain('A vault named ‘Notes’ already exists on openboard — this will be added to it.');
    await press('Publish');
    expect(publishCalls()).toHaveLength(1);
    expect(publishCalls()[0]!.body).toMatchObject({ vaultName: 'Notes', destPath: [] });
  });

  it('a typed new-vault name equal to a published vault selects that vault instead of publishing', async () => {
    await toPicker();
    const input = document.querySelector<HTMLInputElement>('input[type=text]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, ' Research ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press('Publish');
    expect(publishCalls()).toHaveLength(0);
    expect(radio('Research')?.checked).toBe(true);
    expect(text()).toContain('A vault named ‘Research’ already exists on openboard — this will be added to it.');
    await press('Publish');
    expect(publishCalls()[0]!.body).toMatchObject({ vaultName: 'Research', destPath: [] });
  });

  it('a new-vault name that differs from every published vault stays a separate new vault', async () => {
    await toPicker();
    expect(radio('+ New vault on openboard')?.checked).toBe(true);
    expect(text()).not.toContain('already exists on openboard');
    await press('Publish');
    expect(publishCalls()[0]!.body).toMatchObject({ vaultName: 'Notes', destPath: [] });
  });

  it('shows which links see the chosen existing vault', async () => {
    links = [obLink('Friends', [OB_VAULT]), obLink('Team', [OB_VAULT]), obLink('Other', [OB_VAULT2])];
    await toPicker();
    expect(text()).not.toContain('Visible on links');
    await act(async () => void radio('Papers')!.click());
    expect(text()).toContain('Visible on links: Friends, Team');
    expect(text()).not.toContain('Other');
  });

  it('omits the link line when the links cannot be loaded, and the picker still publishes', async () => {
    links = null;
    await toPicker();
    await act(async () => void radio('Research')!.click());
    expect(text()).not.toContain('Visible on links');
    expect(document.querySelector('[role=alert]')).toBeNull();
    await press('Publish');
    expect(publishCalls()[0]!.body).toMatchObject({ vaultName: 'Research', destPath: [] });
  });

  it('picking "Papers" under "Research" publishes there: destPath is the folder names below the vault', async () => {
    await publishIntoPapers();
    const [p] = publishCalls();
    expect(p!.method).toBe('POST');
    expect(p!.body).toMatchObject({
      kind: 'folder',
      vaultName: 'Research',
      destPath: ['Papers'],
      rootName: 'Deep',
      overwrite: false,
      notes: [{ folderKey: null, title: 'Graphs', body: `![a](inked://${IMG}) ![b](inked://${IMG2})` }],
    });
    expect(text()).toContain('Published.');
    const link = [...document.querySelectorAll('a')].find((a) => a.getAttribute('href') === '/openboard');
    expect(link?.getAttribute('target')).toBe('_blank');
  });

  it('picking a vault root publishes at that vault’s root', async () => {
    await toPicker();
    await act(async () => void radio('Research')!.click());
    await press('Publish');
    expect(publishCalls()[0]!.body).toMatchObject({ vaultName: 'Research', destPath: [] });
  });

  it('uploads each referenced image only after the publish succeeded', async () => {
    await publishIntoPapers();
    const order = calls.map((c) => c.url);
    const publishAt = order.indexOf('/api/openboard/publish');
    expect(imageCalls().map((c) => c.url).sort()).toEqual(
      [`/api/openboard/vaults/${OB_VAULT}/images/${IMG}`, `/api/openboard/vaults/${OB_VAULT}/images/${IMG2}`].sort(),
    );
    for (const c of imageCalls()) {
      expect(order.indexOf(c.url)).toBeGreaterThan(publishAt);
      expect(c.method).toBe('POST');
      expect(c.body).toBeInstanceOf(Uint8Array);
    }
  });

  it('an image already stored (409 exists) counts as uploaded', async () => {
    imageStatus = (id) => (id === IMG ? { status: 409, body: { error: 'exists' } } : { status: 201 });
    await publishIntoPapers();
    expect(text()).toContain('Published.');
    expect(text()).not.toMatch(/couldn.t be uploaded/);
  });

  it('a failed image upload is reported but the publish still shows as done', async () => {
    imageStatus = (id) => (id === IMG ? { status: 500, body: { error: 'internal' } } : { status: 201 });
    await publishIntoPapers();
    expect(text()).toMatch(/Published, but 1 image couldn.t be uploaded\./);
  });

  it('a conflict shows the overwrite confirm with the counts; Cancel sends nothing more', async () => {
    publishAnswers = [{ status: 409, body: conflict }];
    await publishIntoPapers();
    expect(text()).toMatch(/Replace .Deep. on openboard\?/);
    expect(text()).toContain('5 notes');
    expect(text()).toContain('2 folders');
    expect(imageCalls()).toHaveLength(0);
    await press('Cancel');
    expect(onClose).toHaveBeenCalled();
    expect(publishCalls()).toHaveLength(1);
  });

  it('Overwrite resends the same publish with overwrite: true, then uploads the images', async () => {
    publishAnswers = [
      { status: 409, body: conflict },
      { status: 201, body: { vaultId: OB_VAULT, imageRefs: [IMG] } },
    ];
    await publishIntoPapers();
    await press('Overwrite');
    const [first, second] = publishCalls();
    expect(second!.body).toEqual({ ...(first!.body as object), overwrite: true });
    expect(imageCalls().map((c) => c.url)).toEqual([`/api/openboard/vaults/${OB_VAULT}/images/${IMG}`]);
    expect(text()).toContain('Published.');
  });

  it('a vault publish skips the picker and publishes under the vault name', async () => {
    mount({ kind: 'vault' });
    await press('Continue');
    expect(calls.map((c) => c.url)).not.toContain('/api/openboard/content');
    expect(publishCalls()[0]!.body).toMatchObject({ kind: 'vault', vaultName: 'Notes', rootName: 'Notes', destPath: [], overwrite: false });
    expect(text()).toContain('Published.');
  });

  it('a body that fails to load (not a decryption failure) stops the publish: error inline, no publish request', async () => {
    extraNotes = [note('n9', 'f2', 'Late')];
    loadNote = async () => {
      throw new Error('Can’t reach the server. Check your connection and try again.');
    };
    await publishIntoPapers();
    expect(document.querySelector('[role=alert]')?.textContent).toMatch(/Can’t reach the server/);
    expect(publishCalls()).toHaveLength(0);
    expect(button('Publish')).toBeTruthy();
  });

  it('unreadable notes are announced on the notice and on the overwrite confirm, before anything is replaced', async () => {
    extraNotes = [note('n9', 'f2', 'Broken body')];
    failedBodies = { n9: true };
    publishAnswers = [{ status: 409, body: conflict }];
    mount({ kind: 'folder', id: 'f2' });
    expect(text()).toMatch(/1 unreadable note won.t be included\./);
    await press('Continue');
    await act(async () => void radio('Papers')!.click());
    await press('Publish');
    expect(text()).toMatch(/Replace .Deep. on openboard\?/);
    expect(text()).toMatch(/1 unreadable note won.t be included, and its published copy will be removed\./);
    expect(publishCalls()[0]!.body).toMatchObject({ notes: [{ title: 'Graphs' }] });
  });

  it('a failed publish shows the error inline and keeps the dialog open', async () => {
    publishAnswers = [{ status: 500, body: { error: 'internal' } }];
    await publishIntoPapers();
    expect(document.querySelector('[role=alert]')?.textContent).toMatch(/didn.t work/);
    expect(onClose).not.toHaveBeenCalled();
    expect(button('Publish')).toBeTruthy();
  });
});
