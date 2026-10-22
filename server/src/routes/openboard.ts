// Owner API for openboard: publish plaintext content, list it, unpublish it.

import type { FastifyInstance } from 'fastify';
import { type AppContext, currentUser, requireUser } from '../context.js';
import { deleteFolder, deleteNote, deleteVault, listContent, publish } from '../openboard/store.js';
import type { PublishRequest } from '../openboard/types.js';
import { idParams } from '../schemas.js';

/** Largest published note body, in characters. */
export const OB_NOTE_BODY_MAX = 1024 * 1024;
export const OB_MAX_NOTES = 5000;
export const OB_MAX_FOLDERS = 2000;
/** A whole publish request (a vault with up to 5000 notes) may be large. */
export const OB_PUBLISH_BODY_LIMIT = 64 * 1024 * 1024;

const name = { type: 'string', minLength: 1, maxLength: 1000 } as const;
const key = { type: 'string', minLength: 1, maxLength: 200 } as const;
const nullableKey = { type: ['string', 'null'], minLength: 1, maxLength: 200 } as const;

const publishSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'vaultName', 'color', 'destPath', 'rootName', 'folders', 'notes', 'overwrite'],
    properties: {
      kind: { type: 'string', enum: ['vault', 'folder', 'note'] },
      vaultName: name,
      color: { type: 'string', pattern: '^#[0-9A-Fa-f]{6}$' },
      destPath: { type: 'array', maxItems: 100, items: name },
      rootName: name,
      folders: {
        type: 'array',
        maxItems: OB_MAX_FOLDERS,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['key', 'parentKey', 'name'],
          properties: { key, parentKey: nullableKey, name },
        },
      },
      notes: {
        type: 'array',
        maxItems: OB_MAX_NOTES,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['folderKey', 'title', 'body'],
          properties: { folderKey: nullableKey, title: name, body: { type: 'string', maxLength: OB_NOTE_BODY_MAX } },
        },
      },
      overwrite: { type: 'boolean' },
    },
  },
} as const;

type IdParams = { Params: { id: string } };

export function openboardRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const auth = { onRequest: requireUser(ctx) };

  app.post<{ Body: PublishRequest }>(
    '/api/openboard/publish',
    { ...auth, bodyLimit: OB_PUBLISH_BODY_LIMIT, schema: publishSchema },
    async (request, reply) => {
      // A destPath is meaningless for a vault publish.
      const body = request.body.kind === 'vault' ? { ...request.body, destPath: [] } : request.body;
      return reply.code(201).send(publish(db, currentUser(request).id, body));
    },
  );

  app.get('/api/openboard/content', auth, async (request) => listContent(db, currentUser(request).id));

  app.delete<IdParams>('/api/openboard/vaults/:id', { ...auth, schema: { params: idParams } }, async (request, reply) => {
    deleteVault(db, currentUser(request).id, request.params.id);
    return reply.code(204).send();
  });

  app.delete<IdParams>('/api/openboard/folders/:id', { ...auth, schema: { params: idParams } }, async (request, reply) => {
    deleteFolder(db, currentUser(request).id, request.params.id);
    return reply.code(204).send();
  });

  app.delete<IdParams>('/api/openboard/notes/:id', { ...auth, schema: { params: idParams } }, async (request, reply) => {
    deleteNote(db, currentUser(request).id, request.params.id);
    return reply.code(204).send();
  });
}
