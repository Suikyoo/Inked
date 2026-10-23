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
    this.items.clear();
    this.stopTimer();
  }

  private async drain(keepalive: boolean): Promise<void> {
    const all = [...this.items.values()];
    this.items.clear();
    for (let i = 0; i < all.length; i += MAX_BATCH) {
      const batch = all.slice(i, i + MAX_BATCH);
      try {
        await this.send(batch, { keepalive });
      } catch {
        // Keep this and every unsent batch, unless a newer entry for the note arrived meanwhile.
        for (const it of all.slice(i)) if (!this.items.has(it.noteId)) this.items.set(it.noteId, it);
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
