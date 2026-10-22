// Response hardening shared by every route that serves published image bytes (public and owner).

import type { onSendAsyncHookHandler } from 'fastify';

/**
 * Served image bytes must never render as a page (a GIF89a header followed by HTML sniffs as a gif), so
 * every image response carries its own locked-down policy.
 */
export const IMAGE_HEADERS = {
  'x-content-type-options': 'nosniff',
  'content-disposition': 'inline',
  'content-security-policy': "default-src 'none'; sandbox",
  'cache-control': 'private, max-age=3600',
} as const;

/**
 * Route-level onSend hook that sets IMAGE_HEADERS on a 200. Route hooks run after the app-wide one, so the
 * default security headers do not overwrite these.
 */
export const imageHeadersOnSend: onSendAsyncHookHandler = async (_request, reply, payload) => {
  if (reply.statusCode === 200) reply.headers(IMAGE_HEADERS);
  return payload;
};
