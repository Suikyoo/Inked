import type { ObLink, ObPayload, ObPublicResponse } from 'inked-core';

/**
 * Openboard API client. Deliberately standalone (bare `fetch`, no app client, store or crypto) so the visitor
 * bundles stay small and clean. The visitor calls are anonymous; the editor's owner calls use the session cookie.
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

// ---- Owner (editor) API: the signed-in session cookie, same origin. --------------------------------------

/**
 * One owner call. Every non-GET carries `X-Inked: 1` (the server's CSRF guard). No `X-Inked-User`: the
 * editor works for whoever holds the session. Throws ObApiError on any failure; a 204 resolves to undefined.
 */
async function owner<T>(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-Inked'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ObApiError(0);
  }
  if (!res.ok) throw new ObApiError(res.status);
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    throw new ObApiError(res.status);
  }
}

/** Whether a session is signed in: the same `GET /api/me` the notes app boots with. 401 -> false. */
export async function checkSession(): Promise<boolean> {
  try {
    await owner<unknown>('GET', '/api/me');
    return true;
  } catch (e) {
    if (e instanceof ObApiError && e.status === 401) return false;
    throw e;
  }
}

export const listLinks = (): Promise<ObLink[]> => owner('GET', '/api/openboard/links');

export const createLink = (label: string, vaultIds: string[]): Promise<ObLink> => owner('POST', '/api/openboard/links', { label, vaultIds });

export const updateLink = (id: string, patch: { label?: string; vaultIds?: string[] }): Promise<ObLink> =>
  owner('PATCH', `/api/openboard/links/${seg(id)}`, patch);

export const deleteLink = (id: string): Promise<void> => owner('DELETE', `/api/openboard/links/${seg(id)}`);

/** Everything the user has published, without note bodies. */
export const listContent = (): Promise<ObPayload> => owner('GET', '/api/openboard/content');

/** What a link's visitors would see (with bodies), or everything published. Never counts a view. */
export const previewPayload = (linkId?: string): Promise<ObPayload> =>
  owner('GET', linkId ? `/api/openboard/preview?linkId=${seg(linkId)}` : '/api/openboard/preview');

export const unpublish = (kind: 'vault' | 'folder' | 'note', id: string): Promise<void> => owner('DELETE', `/api/openboard/${kind}s/${seg(id)}`);

/** Where the owner reads a published image (the editor's preview). */
export function ownerImageUrl(vaultId: string, imageId: string): string {
  return `/api/openboard/vaults/${seg(vaultId)}/images/${seg(imageId)}`;
}

/** A short, human message for a failed call. */
export function errorText(e: unknown): string {
  if (e instanceof ObApiError) {
    if (e.status === 0) return 'Can’t reach the server. Check your connection and try again.';
    if (e.status === 401) return 'Your session ended. Sign in again.';
    if (e.status === 404) return 'That item no longer exists. Reload to see the latest.';
    if (e.status === 429) return 'Too many requests. Wait a moment and try again.';
    return `That didn’t work (error ${e.status}). Try again.`;
  }
  return 'That didn’t work. Try again.';
}
