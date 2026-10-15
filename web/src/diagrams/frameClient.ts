import { isRenderResult, MAX_SVG_SIZE, type FailReason, type RenderRequest } from './protocol';

export interface FrameConnection {
  port: MessagePort;
  /** Close the port and remove the frame. */
  dispose(): void;
}

export type FrameOutcome = { ok: true; svg: string; css: string } | { ok: false; reason: FailReason | 'timeout'; message?: string };

export interface FrameClient {
  render(id: string, source: string): Promise<FrameOutcome>;
  /** Drop the frame (lock, sign-out). Pending renders fail as `load`; the next render reconnects. */
  reset(): void;
}

/**
 * Talks to the diagram frame over a port. The transport is injected so the request, timeout and restart logic
 * can be tested without a browser. A frame that stops answering is removed, which also kills a runaway script.
 */
export function createFrameClient(connect: () => Promise<FrameConnection>, opts: { renderTimeoutMs?: number } = {}): FrameClient {
  const renderTimeoutMs = opts.renderTimeoutMs ?? 30_000;
  let conn: Promise<FrameConnection> | null = null;
  const pending = new Map<string, (outcome: FrameOutcome) => void>();

  function open(): Promise<FrameConnection> {
    if (!conn) {
      const p = connect().then((c) => {
        c.port.onmessage = (e: MessageEvent) => {
          const d: unknown = e.data;
          if (!isRenderResult(d)) return;
          const settle = pending.get(d.id);
          if (!settle) return;
          if (!d.ok) settle({ ok: false, reason: d.reason, message: d.message });
          else if (d.svg.length + d.css.length > MAX_SVG_SIZE) settle({ ok: false, reason: 'oversized' });
          else settle({ ok: true, svg: d.svg, css: d.css });
        };
        return c;
      });
      conn = p;
      // A failed connect is not kept: the next render tries again.
      p.catch(() => {
        if (conn === p) conn = null;
      });
    }
    return conn;
  }

  function drop(outcome: FrameOutcome): void {
    const c = conn;
    conn = null;
    c?.then(
      (x) => x.dispose(),
      () => undefined,
    );
    for (const settle of Array.from(pending.values())) settle(outcome);
  }

  return {
    render(id, source) {
      return new Promise<FrameOutcome>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const settle = (outcome: FrameOutcome) => {
          if (!pending.delete(id)) return;
          clearTimeout(timer);
          resolve(outcome);
        };
        pending.set(id, settle);
        open().then(
          (c) => {
            if (pending.get(id) !== settle) return; // settled (or superseded by a newer request with the same id) while connecting
            timer = setTimeout(() => drop({ ok: false, reason: 'timeout' }), renderTimeoutMs);
            c.port.postMessage({ type: 'render', id, source } satisfies RenderRequest);
          },
          () => settle({ ok: false, reason: 'load' }),
        );
      });
    },
    reset() {
      drop({ ok: false, reason: 'load' });
    },
  };
}
