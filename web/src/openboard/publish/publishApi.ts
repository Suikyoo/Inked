import type { PublishConflict, PublishRequest, PublishResult } from 'inked-core';
import { getRequestUser } from '../../api/client';
import { ObApiError } from '../api';
import type { PublishUnit } from './collect';

/** The account signed in in another tab owns the session cookie now; publishing would go to them. */
export class AccountChangedError extends Error {
  constructor() {
    super('Another account signed in in another tab. Reload this page to continue.');
    this.name = 'AccountChangedError';
  }
}

export type PublishOutcome = { status: 'ok'; result: PublishResult } | { status: 'conflict'; conflict: PublishConflict };

/**
 * Headers for a publish call. It names this tab's account (X-Inked-User) like the app's data routes, so a
 * session that changed account in another tab is refused instead of receiving this account's plaintext.
 */
function headers(contentType: string): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/json', 'Content-Type': contentType, 'X-Inked': '1' };
  const user = getRequestUser();
  if (user) h['X-Inked-User'] = user;
  return h;
}

async function send(path: string, init: { body: BodyInit; contentType: string }): Promise<{ res: Response; data: unknown }> {
  let res: Response;
  let data: unknown = null;
  try {
    res = await fetch(path, { method: 'POST', headers: headers(init.contentType), credentials: 'same-origin', cache: 'no-store', body: init.body });
    data = await res.json().catch(() => null);
  } catch {
    throw new ObApiError(0);
  }
  if (res.status === 409 && (data as { error?: string } | null)?.error === 'user_mismatch') throw new AccountChangedError();
  return { res, data };
}

/** POST /api/openboard/publish. A 409 conflict comes back as a result; any other failure throws ObApiError. */
export async function publishUnit(unit: PublishUnit, destPath: string[], vaultName: string, overwrite: boolean): Promise<PublishOutcome> {
  const request: PublishRequest = { ...unit.request, vaultName, destPath: unit.request.kind === 'vault' ? [] : destPath, overwrite };
  const { res, data } = await send('/api/openboard/publish', { body: JSON.stringify(request), contentType: 'application/json' });
  if (res.status === 409 && (data as { error?: string } | null)?.error === 'conflict') {
    return { status: 'conflict', conflict: data as PublishConflict };
  }
  if (!res.ok || !data || typeof (data as PublishResult).vaultId !== 'string' || !Array.isArray((data as PublishResult).imageRefs)) {
    throw new ObApiError(res.status, (data as { error?: string } | null)?.error);
  }
  return { status: 'ok', result: data as PublishResult };
}

/** Uploads one published image's plaintext bytes. Already stored (409 `exists`) counts as done: same id, same bytes. */
export async function uploadPublishedImage(vaultId: string, imageId: string, bytes: Uint8Array): Promise<void> {
  const path = `/api/openboard/vaults/${encodeURIComponent(vaultId)}/images/${encodeURIComponent(imageId)}`;
  const { res, data } = await send(path, { body: bytes as BodyInit, contentType: 'application/octet-stream' });
  if (res.ok) return;
  if (res.status === 409 && (data as { error?: string } | null)?.error === 'exists') return;
  throw new ObApiError(res.status);
}

/**
 * Decrypts and uploads every image the published bodies reference (the ids the server reported that this
 * unit can supply), a few at a time. A failure never stops the rest; returns how many failed.
 */
export async function uploadImages(result: PublishResult, images: PublishUnit['images'], concurrency = 3): Promise<number> {
  const queue = result.imageRefs.filter((id) => images.has(id));
  let failed = 0;
  const worker = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        await uploadPublishedImage(result.vaultId, id, await images.get(id)!());
      } catch {
        failed++;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  return failed;
}
