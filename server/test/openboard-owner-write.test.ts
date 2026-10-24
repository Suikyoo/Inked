import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OB_WRITE_BODY_MAX } from '../src/openboard/write.js';
import { type Account, call, inviteUser, makeApp, setupAdmin, type TestApp } from './helpers.js';

let t: TestApp;
let alice: Account;
let bob: Account;
beforeEach(async () => {
  t = await makeApp();
  alice = await setupAdmin(t.app, 'alice');
  bob = await inviteUser(t.app, alice, 'bob');
});
afterEach(async () => {
  await t.close();
});

const COLOR = '#45A89E';

interface Note {
  id: string;
  title: string;
  body: string;
  updatedAt: string;
  visitorEdited: boolean;
  ownerEdited: boolean;
}

/** Publishes a vault holding an Index note and "Alpha", and returns its notes by title. */
async function publishVault(name = 'Docs') {
  const res = await call(t.app, 'POST', '/api/openboard/publish', {
    cookie: alice.cookie,
    body: {
      kind: 'vault',
      vaultName: name,
      color: COLOR,
      destPath: [],
      rootName: name,
      folders: [],
      notes: [
        { folderKey: null, title: 'Index', body: 'hub' },
        { folderKey: null, title: 'Alpha', body: 'alpha body' },
      ],
      overwrite: false,
    },
  });
  expect(res.statusCode).toBe(201);
  return { vaultId: res.json().vaultId as string, notes: await notesByTitle() };
}

async function notesByTitle(): Promise<Record<string, Note>> {
  const res = await call(t.app, 'GET', '/api/openboard/preview', { cookie: alice.cookie });
  expect(res.statusCode).toBe(200);
  const out: Record<string, Note> = {};
  for (const n of res.json().notes as Note[]) out[n.title] = n;
  return out;
}

const editNote = (who: Account, noteId: string, body: unknown) =>
  call(t.app, 'PATCH', `/api/openboard/notes/${noteId}`, { cookie: who.cookie, body });

describe('owner note edits', () => {
  it('edits a published note and records it as an owner edit', async () => {
    const { notes } = await publishVault();
    const res = await editNote(alice, notes.Alpha.id, { baseUpdatedAt: notes.Alpha.updatedAt, body: 'fixed in openboard' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ body: 'fixed in openboard', ownerEdited: true, visitorEdited: false });

    const after = await notesByTitle();
    expect(after.Alpha.body).toBe('fixed in openboard');
    expect(after.Alpha.ownerEdited).toBe(true);
    expect(after.Alpha.visitorEdited).toBe(false);
  });

  it('retitles a published note', async () => {
    const { notes } = await publishVault();
    const res = await editNote(alice, notes.Alpha.id, { baseUpdatedAt: notes.Alpha.updatedAt, title: 'Renamed' });
    expect(res.statusCode).toBe(200);
    expect(res.json().title).toBe('Renamed');
  });

  it('refuses a stale baseUpdatedAt rather than overwriting', async () => {
    const { notes } = await publishVault();
    const first = await editNote(alice, notes.Alpha.id, { baseUpdatedAt: notes.Alpha.updatedAt, body: 'one' });
    expect(first.statusCode).toBe(200);
    // A second tab still holding the original timestamp.
    const second = await editNote(alice, notes.Alpha.id, { baseUpdatedAt: notes.Alpha.updatedAt, body: 'two' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('stale');
    expect((await notesByTitle()).Alpha.body).toBe('one');
  });

  it("404s on another user's note", async () => {
    const { notes } = await publishVault();
    const res = await editNote(bob, notes.Alpha.id, { baseUpdatedAt: notes.Alpha.updatedAt, body: 'mine now' });
    expect(res.statusCode).toBe(404);
  });

  it('needs a session', async () => {
    const { notes } = await publishVault();
    const res = await call(t.app, 'PATCH', `/api/openboard/notes/${notes.Alpha.id}`, {
      body: { baseUpdatedAt: notes.Alpha.updatedAt, body: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('keeps an Index note title, and keeps Index for folder pages', async () => {
    const { notes } = await publishVault();
    expect((await editNote(alice, notes.Index.id, { baseUpdatedAt: notes.Index.updatedAt, title: 'Home' })).statusCode).toBe(400);
    expect((await editNote(alice, notes.Alpha.id, { baseUpdatedAt: notes.Alpha.updatedAt, title: 'Index' })).statusCode).toBe(400);
  });

  it('refuses a body past the cap', async () => {
    const { notes } = await publishVault();
    const res = await editNote(alice, notes.Alpha.id, { baseUpdatedAt: notes.Alpha.updatedAt, body: 'x'.repeat(OB_WRITE_BODY_MAX + 1) });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toBe('too_large');
  });

  it('leaves a visitor edit flagged when the owner then edits the same note', async () => {
    const { vaultId, notes } = await publishVault();
    const link = await call(t.app, 'POST', '/api/openboard/links', {
      cookie: alice.cookie,
      body: { label: 'W', vaultIds: [vaultId], permission: 'write' },
    });
    expect(link.statusCode).toBe(201);
    const token = link.json().token as string;

    const visitor = await call(t.app, 'PATCH', `/api/ob/${token}/notes/${notes.Alpha.id}`, {
      headers: { 'X-Inked': '1' },
      body: { baseUpdatedAt: notes.Alpha.updatedAt, body: 'visitor text' },
    });
    expect(visitor.statusCode).toBe(200);

    const owner = await editNote(alice, notes.Alpha.id, { baseUpdatedAt: visitor.json().updatedAt, body: 'owner text' });
    expect(owner.statusCode).toBe(200);
    expect(owner.json()).toMatchObject({ visitorEdited: true, ownerEdited: true });
  });
});
