// Public openboard API: a visitor holding a link token reads the vaults granted to it, and their images.
// No session, no CSRF header (GET only). Every miss is the same 404, and failed token lookups are
// rate limited per IP.

import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { ApiError, notFound } from '../errors.js';
import { bumpViews, findLinkByToken, getImage, grantedPayload, isVaultGranted } from '../openboard/store.js';
import { LINK_TOKEN_RE } from '../openboard/token.js';
import type { ObPublicResponse } from '../openboard/types.js';
import { UUID_RE } from '../schemas.js';

const uuidRe = new RegExp(UUID_RE);

/**
 * Served image bytes must never render as a page (a GIF89a header followed by HTML sniffs as a gif), so
 * every image response carries its own locked-down policy. Set from a route-level onSend hook, which runs
 * after the app-wide one and so is not overwritten by the default security headers.
 */
const IMAGE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-disposition': 'inline',
  'content-security-policy': "default-src 'none'; sandbox",
  'cache-control': 'private, max-age=3600',
} as const;

type TokenParams = { Params: { token: string } };
type ImageParams = { Params: { token: string; vaultId: string; imageId: string } };

export function openboardPublicRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db, obLimiter } = ctx;

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

  app.get<TokenParams>('/api/ob/:token', async (request): Promise<ObPublicResponse> => {
    const link = linkFor(request, request.params.token);
    bumpViews(db, link.id);
    return { label: link.label, ...grantedPayload(db, link.id) };
  });

  app.get<ImageParams>(
    '/api/ob/:token/images/:vaultId/:imageId',
    {
      onSend: async (_request, reply, payload) => {
        if (reply.statusCode === 200) reply.headers(IMAGE_HEADERS);
        return payload;
      },
    },
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
