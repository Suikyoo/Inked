import type { FastifyInstance } from 'fastify';
import { type AppContext, currentUser, requireUser } from '../context.js';
import { bumpTimestamp, type FolderRow, type NoteRow, nowIso } from '../db.js';
import { ApiError } from '../errors.js';
import { encMeta, idParams, uuid, wrappedKey } from '../schemas.js';
import { folderJson, listVaults, type NoteHeadRow, noteHeadJson, ownedVault, ownedVaultWithCounts, vaultJson } from './access.js';

const createSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'encMeta', 'wrappedKey'],
    properties: { id: uuid, encMeta, wrappedKey },
  },
} as const;

const patchSchema = {
  params: idParams,
  body: { type: 'object', additionalProperties: false, required: ['encMeta'], properties: { encMeta } },
} as const;

type IdParams = { Params: { id: string } };

export function vaultRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const auth = { onRequest: requireUser(ctx) };

  app.get('/api/vaults', auth, async (request) => ({
    vaults: listVaults(db, currentUser(request).id).map(vaultJson),
  }));

  app.post<{ Body: { id: string; encMeta: string; wrappedKey: string } }>(
    '/api/vaults',
    { ...auth, schema: createSchema },
    async (request) => {
      const user = currentUser(request);
      const { id, encMeta: meta, wrappedKey: key } = request.body;
      if (db.prepare('SELECT 1 FROM vaults WHERE id = ?').get(id)) throw new ApiError(409, 'exists');
      const now = nowIso();
      db.prepare(
        'INSERT INTO vaults (id, user_id, enc_meta, wrapped_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, user.id, meta, key, now, now);
      return { vault: vaultJson(ownedVaultWithCounts(db, user.id, id)) };
    },
  );

  app.patch<IdParams & { Body: { encMeta: string } }>(
    '/api/vaults/:id',
    { ...auth, schema: patchSchema },
    async (request) => {
      const user = currentUser(request);
      const vault = ownedVault(db, user.id, request.params.id);
      db.prepare('UPDATE vaults SET enc_meta = ?, updated_at = ? WHERE id = ?').run(
        request.body.encMeta,
        bumpTimestamp(vault.updated_at),
        vault.id,
      );
      return { vault: vaultJson(ownedVaultWithCounts(db, user.id, vault.id)) };
    },
  );

  // Folders and notes go with it via ON DELETE CASCADE.
  app.delete<IdParams>('/api/vaults/:id', { ...auth, schema: { params: idParams } }, async (request) => {
    const vault = ownedVault(db, currentUser(request).id, request.params.id);
    db.prepare('DELETE FROM vaults WHERE id = ?').run(vault.id);
    return { ok: true };
  });

  app.get<IdParams>('/api/vaults/:id/tree', { ...auth, schema: { params: idParams } }, async (request) => {
    const vault = ownedVault(db, currentUser(request).id, request.params.id);
    const folders = db
      .prepare('SELECT * FROM folders WHERE vault_id = ? ORDER BY created_at, id')
      .all(vault.id) as unknown as FolderRow[];
    const notes = db
      .prepare(
        `SELECT n.id, n.vault_id, n.folder_id, n.enc_meta, n.size, n.created_at, n.updated_at,
                rp.pct AS read_pct, rp.read_size AS read_size
         FROM notes n LEFT JOIN read_progress rp ON rp.note_id = n.id AND rp.user_id = ?
         WHERE n.vault_id = ? ORDER BY n.created_at, n.id`,
      )
      .all(currentUser(request).id, vault.id) as unknown as NoteHeadRow[];
    return { folders: folders.map(folderJson), notes: notes.map(noteHeadJson) };
  });

  app.get<IdParams>('/api/vaults/:id/bodies', { ...auth, schema: { params: idParams } }, async (request) => {
    const vault = ownedVault(db, currentUser(request).id, request.params.id);
    const notes = db
      .prepare('SELECT id, enc_body, updated_at FROM notes WHERE vault_id = ? ORDER BY created_at, id')
      .all(vault.id) as unknown as Pick<NoteRow, 'id' | 'enc_body' | 'updated_at'>[];
    return { notes: notes.map((n) => ({ id: n.id, encBody: n.enc_body, updatedAt: n.updated_at })) };
  });
}
