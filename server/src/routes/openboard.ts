// Owner API for openboard: publish plaintext content, list it, unpublish it, manage links, preview.

import type { FastifyInstance } from 'fastify';
import { type AppContext, currentUser, requireUser } from '../context.js';
import { ApiError, notFound } from '../errors.js';
import { imageHeadersOnSend } from '../openboard/imageHeaders.js';
import {
  createLink,
  deleteFolder,
  deleteLink,
  deleteNote,
  deleteVault,
  getImage,
  listContent,
  listLinks,
  OB_IMAGE_MAX,
  ownsVault,
  previewContent,
  publish,
  putImage,
  updateLink,
} from '../openboard/store.js';
import type { ObPermission, PublishRequest } from '../openboard/types.js';
import { idParams, imageParams, uuid } from '../schemas.js';

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

/** Link label: 1-80 characters, not only whitespace. */
const label = { type: 'string', minLength: 1, maxLength: 80, pattern: '\\S' } as const;
const vaultIds = { type: 'array', maxItems: 1000, items: uuid } as const;
const permission = { type: 'string', enum: ['read', 'write'] } as const;

const createLinkSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['label', 'vaultIds'],
    properties: { label, vaultIds, permission },
  },
} as const;

const updateLinkSchema = {
  params: idParams,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: { label, vaultIds, permission },
  },
} as const;

const previewSchema = {
  querystring: {
    type: 'object',
    additionalProperties: false,
    properties: { linkId: uuid },
  },
} as const;

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

  app.get('/api/openboard/links', auth, async (request) => listLinks(db, currentUser(request).id));

  app.post<{ Body: { label: string; vaultIds: string[]; permission?: ObPermission } }>(
    '/api/openboard/links',
    { ...auth, schema: createLinkSchema },
    async (request, reply) => reply.code(201).send(createLink(db, currentUser(request).id, request.body)),
  );

  app.patch<IdParams & { Body: { label?: string; vaultIds?: string[]; permission?: ObPermission } }>(
    '/api/openboard/links/:id',
    { ...auth, schema: updateLinkSchema },
    async (request) => updateLink(db, currentUser(request).id, request.params.id, request.body ?? {}),
  );

  app.delete<IdParams>('/api/openboard/links/:id', { ...auth, schema: { params: idParams } }, async (request, reply) => {
    deleteLink(db, currentUser(request).id, request.params.id);
    return reply.code(204).send();
  });

  app.get<{ Querystring: { linkId?: string } }>('/api/openboard/preview', { ...auth, schema: previewSchema }, async (request) =>
    previewContent(db, currentUser(request).id, request.query.linkId),
  );

  // The owner reads their own published image (the editor's preview); same hardening as the public route.
  app.get<ObImageParams>(
    '/api/openboard/vaults/:vaultId/images/:imageId',
    { ...auth, onSend: imageHeadersOnSend, schema: { params: imageParams } },
    async (request, reply) => {
      const { vaultId, imageId } = request.params;
      if (!ownsVault(db, currentUser(request).id, vaultId)) throw notFound();
      const image = getImage(db, vaultId, imageId);
      if (!image) throw notFound();
      return reply.type(image.mime).send(image.data);
    },
  );
}

type ObImageParams = { Params: { vaultId: string; imageId: string } };

/**
 * Published image upload (raw plaintext bytes). Registered inside the octet-stream parser scope in app.ts,
 * so any other content type is rejected with 415 before the handler runs.
 */
export function openboardImageRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  app.post<ObImageParams & { Body: unknown }>(
    '/api/openboard/vaults/:vaultId/images/:imageId',
    { onRequest: requireUser(ctx), bodyLimit: OB_IMAGE_MAX, schema: { params: imageParams } },
    async (request, reply) => {
      const body = request.body;
      if (body !== undefined && !Buffer.isBuffer(body)) {
        throw new ApiError(415, 'unsupported_media_type', 'Send the image as application/octet-stream');
      }
      const { vaultId, imageId } = request.params;
      const saved = putImage(db, currentUser(request).id, vaultId, imageId, body ?? Buffer.alloc(0), ctx.imageQuotaBytes);
      return reply.code(201).send(saved);
    },
  );
}
