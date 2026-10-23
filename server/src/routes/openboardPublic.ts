// Public openboard API: a visitor holding a link token reads the vaults granted to it, and their images.
// A write link also lets them edit and add notes in those vaults. No session; reads need no CSRF header,
// writes carry X-Inked like every other non-GET. Every miss is the same 404, failed token lookups are
// rate limited per IP, and so are writes.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { ApiError, notFound } from '../errors.js';
import { bumpViews, findLinkByToken, getImage, grantedPayload, isVaultGranted } from '../openboard/store.js';
import { imageHeadersOnSend } from '../openboard/imageHeaders.js';
import { LINK_TOKEN_RE } from '../openboard/token.js';
import type { ObNote, ObPublicResponse } from '../openboard/types.js';
import { createNoteAsVisitor, editNoteAsVisitor, OB_VISITOR_TITLE_MAX } from '../openboard/visitor.js';
import { nullableUuid, UUID_RE, uuid } from '../schemas.js';

const uuidRe = new RegExp(UUID_RE);

type TokenParams = { Params: { token: string } };
type ImageParams = { Params: { token: string; vaultId: string; imageId: string } };
type EditBody = { baseUpdatedAt: string; title?: string; body?: string };
type CreateBody = { vaultId: string; folderId: string | null; title: string; body: string };

/** A visitor-set title: 1-200 characters on one line, not only whitespace. */
const title = { type: 'string', minLength: 1, maxLength: OB_VISITOR_TITLE_MAX, pattern: '^[^\\r\\n]*\\S[^\\r\\n]*$' } as const;
// Body length is checked in the store, so an over-long body is 413 rather than a schema 400.
const body = { type: 'string' } as const;

const editSchema = {
  params: { type: 'object', required: ['token', 'noteId'], properties: { token: { type: 'string' }, noteId: uuid } },
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['baseUpdatedAt'],
    anyOf: [{ required: ['title'] }, { required: ['body'] }],
    properties: { baseUpdatedAt: { type: 'string', maxLength: 40 }, title, body },
  },
} as const;

const createSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['vaultId', 'folderId', 'title', 'body'],
    properties: { vaultId: uuid, folderId: nullableUuid, title, body },
  },
} as const;

export function openboardPublicRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, obLimiter, obWriteLimiter } = ctx;

  /** Resolves the token to its link, or throws 429 (IP locked) / 404 (counting the failure). */
  function linkFor(request: FastifyRequest, token: string) {
    const ip = request.ip;
    const retryAfter = obLimiter.retryAfter(ip);
    if (retryAfter > 0) {
      throw new ApiError(429, 'locked', 'Too many failed attempts', { retryAfter }, { 'retry-after': String(retryAfter) });
    }
    // A malformed token never reaches the database.
    const link = LINK_TOKEN_RE.test(token) ? findLinkByToken(db, token) : null;
    if (!link) {
      obLimiter.fail(ip);
      throw notFound();
    }
    return link;
  }

  /** The link, if it may write and this IP is under the write limit; else 403 `read_only` or 429 `locked`. */
  function writableLinkFor(request: FastifyRequest, token: string) {
    const link = linkFor(request, token);
    if (link.permission !== 'write') throw new ApiError(403, 'read_only', 'This link is read-only');
    const retryAfter = obWriteLimiter.attempt(request.ip);
    if (retryAfter > 0) {
      throw new ApiError(429, 'locked', 'Too many changes', { retryAfter }, { 'retry-after': String(retryAfter) });
    }
    return link;
  }

  app.get<TokenParams>('/api/ob/:token', async (request): Promise<ObPublicResponse> => {
    const link = linkFor(request, request.params.token);
    // Fastify answers HEAD through this GET handler; only a real GET counts as a view.
    if (request.method === 'GET') bumpViews(db, link.id);
    return { label: link.label, permission: link.permission, ...grantedPayload(db, link.id) };
  });

  app.patch<{ Params: { token: string; noteId: string }; Body: EditBody }>(
    '/api/ob/:token/notes/:noteId',
    { schema: editSchema },
    async (request): Promise<ObNote> => {
      const link = writableLinkFor(request, request.params.token);
      return editNoteAsVisitor(db, link.id, request.params.noteId, request.body);
    },
  );

  app.post<TokenParams & { Body: CreateBody }>('/api/ob/:token/notes', { schema: createSchema }, async (request, reply) => {
    const link = writableLinkFor(request, request.params.token);
    return reply.code(201).send(createNoteAsVisitor(db, link.id, request.body));
  });

  app.get<ImageParams>(
    '/api/ob/:token/images/:vaultId/:imageId',
    { onSend: imageHeadersOnSend },
    async (request, reply) => {
      const { token, vaultId, imageId } = request.params;
      const link = linkFor(request, token);
      if (!uuidRe.test(vaultId) || !uuidRe.test(imageId) || !isVaultGranted(db, link.id, vaultId)) throw notFound();
      const image = getImage(db, vaultId, imageId);
      if (!image) throw notFound();
      return reply.type(image.mime).send(image.data);
    },
  );
}
