import type { FastifyInstance } from 'fastify';
import { type AppContext, currentUser, requireUser } from '../context.js';
import { nowIso, transaction } from '../db.js';
import { uuid } from '../schemas.js';

interface Item {
  noteId: string;
  pct: 25 | 50 | 75 | 100;
  size: number;
}

const bodySchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        minItems: 1,
        maxItems: 200,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['noteId', 'pct', 'size'],
          properties: {
            noteId: uuid,
            pct: { type: 'integer', enum: [25, 50, 75, 100] },
            size: { type: 'integer', minimum: 0 },
          },
        },
      },
    },
  },
} as const;

/** How much of the note's current text a mark covers. Twin of readCoverage in core/src/readProgress.ts. */
const coverage = (pct: number, readSize: number, currentSize: number) => Math.min((pct / 100) * readSize, currentSize);

export function readProgressRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const auth = { onRequest: requireUser(ctx) };

  // Batched checkpoint writes. Unknown or foreign note ids are skipped so one stale id never fails the batch.
  app.post<{ Body: { items: Item[] } }>('/api/read-progress', { ...auth, schema: bodySchema }, async (request) => {
    const userId = currentUser(request).id;
    const findNote = db.prepare(
      'SELECT n.size FROM notes n JOIN vaults v ON v.id = n.vault_id WHERE n.id = ? AND v.user_id = ?',
    );
    const findStored = db.prepare('SELECT pct, read_size FROM read_progress WHERE user_id = ? AND note_id = ?');
    const upsert = db.prepare(
      `INSERT INTO read_progress (user_id, note_id, pct, read_size, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, note_id) DO UPDATE SET pct = excluded.pct, read_size = excluded.read_size,
         updated_at = excluded.updated_at`,
    );
    transaction(db, () => {
      const now = nowIso();
      for (const item of request.body.items) {
        const note = findNote.get(item.noteId, userId) as { size: number } | undefined;
        if (!note) continue;
        const stored = findStored.get(userId, item.noteId) as { pct: number; read_size: number } | undefined;
        // A new mark replaces the stored one when it covers at least as much of the current text.
        if (stored && coverage(item.pct, item.size, note.size) < coverage(stored.pct, stored.read_size, note.size)) continue;
        upsert.run(userId, item.noteId, item.pct, item.size, now);
      }
    });
    return { ok: true };
  });
}
