import type { ObPublicResponse } from 'inked-core';

/**
 * Openboard API client. Deliberately standalone (bare `fetch`, no app client, store or crypto) so the visitor
 * bundle stays small and clean. The editor's authenticated calls are added here later.
 */

/** A non-2xx answer from the openboard API. `status` 0 means the request never got an answer. */
export class ObApiError extends Error {
  constructor(readonly status: number) {
    super(`openboard request failed (${status})`);
    this.name = 'ObApiError';
  }
}

const seg = (s: string) => encodeURIComponent(s);

function isPayload(x: unknown): x is ObPublicResponse {
  if (!x || typeof x !== 'object') return false;
  const p = x as Record<string, unknown>;
  return typeof p.label === 'string' && Array.isArray(p.vaults) && Array.isArray(p.folders) && Array.isArray(p.notes);
}

/** GET /api/ob/:token. Anonymous: no cookies, no custom headers. Throws ObApiError on any failure. */
export async function fetchPublic(token: string): Promise<ObPublicResponse> {
  let res: Response;
  try {
    res = await fetch(`/api/ob/${seg(token)}`, { credentials: 'omit' });
  } catch {
    throw new ObApiError(0);
  }
  if (!res.ok) throw new ObApiError(res.status);
  const body: unknown = await res.json().catch(() => null);
  if (!isPayload(body)) throw new ObApiError(res.status);
  return body;
}

/** Where a published image is served for visitors of this link. */
export function publicImageUrl(token: string, vaultId: string, imageId: string): string {
  return `/api/ob/${seg(token)}/images/${seg(vaultId)}/${seg(imageId)}`;
}
