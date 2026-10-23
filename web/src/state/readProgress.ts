/** One reading checkpoint for a note: only the id, the checkpoint and the ciphertext size ever leave the browser. */
export interface ReadProgressItem {
  noteId: string;
  pct: number;
  size: number;
}

const MAX_BATCH = 200;

type Send = (items: ReadProgressItem[], opts: { keepalive: boolean }) => Promise<void>;

/** Collects checkpoints (one per note) and sends them in batches: on a timer while non-empty, or on demand. */
export class ReadProgressQueue {
  private items = new Map<string, ReadProgressItem>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<void> | null = null;
  /** Bumped by clear(): a flush that started earlier must neither re-queue nor keep sending. */
  private generation = 0;

  constructor(
    private readonly send: Send,
    private readonly intervalMs = 10_000,
  ) {}

  get size(): number {
    return this.items.size;
  }

  enqueue(item: ReadProgressItem): void {
    const prev = this.items.get(item.noteId);
    if (!(prev && prev.size === item.size && item.pct < prev.pct)) this.items.set(item.noteId, { ...item });
    this.startTimer();
  }

  flush(opts: { keepalive?: boolean } = {}): Promise<void> {
    if (this.running) return this.running;
    if (this.items.size === 0) return Promise.resolve();
    const run = this.drain(opts.keepalive ?? false).finally(() => {
      this.running = null;
      if (this.items.size === 0) this.stopTimer();
    });
    this.running = run;
    return run;
  }

  clear(): void {
    this.generation++;
    this.items.clear();
    this.stopTimer();
  }

  private async drain(keepalive: boolean): Promise<void> {
    const gen = this.generation;
    const all = [...this.items.values()];
    this.items.clear();
    for (let i = 0; i < all.length; i += MAX_BATCH) {
      if (gen !== this.generation) return;
      const batch = all.slice(i, i + MAX_BATCH);
      try {
        await this.send(batch, { keepalive });
      } catch {
        if (gen !== this.generation) return;
        // Keep this and every unsent batch; a newer entry for the note arrived meanwhile merges like enqueue does.
        for (const it of all.slice(i)) {
          const cur = this.items.get(it.noteId);
          if (!cur || (cur.size === it.size && it.pct > cur.pct)) this.items.set(it.noteId, it);
        }
        return;
      }
    }
  }

  private startTimer(): void {
    if (this.timer === null) this.timer = setInterval(() => void this.flush(), this.intervalMs);
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }
}
