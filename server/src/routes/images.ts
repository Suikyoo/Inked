import type { FastifyInstance } from 'fastify';
import { type AppContext, currentUser, requireUser } from '../context.js';
import { nowIso } from '../db.js';
import { ApiError, notFound } from '../errors.js';
import { imageBytesUsed } from '../openboard/store.js';
import { IMAGE_BLOB_MAX, IMAGE_BLOB_MIN, imageParams } from '../schemas.js';
import { ownedVault } from './access.js';

type ImageParams = { Params: { vaultId: string; imageId: string } };

export function imageRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const auth = { onRequest: requireUser(ctx) };

  app.post<ImageParams & { Body: unknown }>(
    '/api/vaults/:vaultId/images/:imageId',
    { ...auth, bodyLimit: IMAGE_BLOB_MAX, schema: { params: imageParams } },
    async (request, reply) => {
      const userId = currentUser(request).id;
      const vault = ownedVault(db, userId, request.params.vaultId);
      const body = request.body;
      if (body !== undefined && !Buffer.isBuffer(body)) {
        throw new ApiError(415, 'unsupported_media_type', 'Send the image as application/octet-stream');
      }
      if (body === undefined || body.length < IMAGE_BLOB_MIN) throw new ApiError(400, 'invalid_request', 'Image data is too short');
      const { imageId } = request.params;
      if (db.prepare('SELECT 1 FROM images WHERE id = ?').get(imageId)) throw new ApiError(409, 'exists');
      // Private and published image bytes share one per-user quota.
      if (imageBytesUsed(db, userId) + body.length > ctx.imageQuotaBytes) {
        throw new ApiError(413, 'quota_exceeded', 'Image storage is full');
      }
      const now = nowIso();
      db.prepare('INSERT INTO images (id, vault_id, size, enc_blob, created_at) VALUES (?, ?, ?, ?, ?)').run(
        imageId,
        vault.id,
        body.length,
        body,
        now,
      );
      return reply.code(201).send({ id: imageId, size: body.length, createdAt: now });
    },
  );

  app.get<ImageParams>(
    '/api/vaults/:vaultId/images/:imageId',
    { ...auth, schema: { params: imageParams } },
    async (request, reply) => {
      const { vaultId, imageId } = request.params;
      const row = db
        .prepare(
          `SELECT i.enc_blob FROM images i JOIN vaults v ON v.id = i.vault_id
           WHERE i.id = ? AND i.vault_id = ? AND v.user_id = ?`,
        )
        .get(imageId, vaultId, currentUser(request).id) as { enc_blob: Uint8Array } | undefined;
      if (!row) throw notFound();
      return reply
        .header('content-type', 'application/octet-stream')
        .header('cache-control', 'private, max-age=31536000, immutable')
        .send(Buffer.from(row.enc_blob));
    },
  );
}
