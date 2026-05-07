// ============================================================================
// dispatcher/async-queue.ts — Minimal generic async queue.
//
// Used as the streaming bridge between the worker (push) and the SSE route
// (consume via async iteration). One producer, one consumer.
//
// Plan ref: 2026-05-07-phase2-dispatcher.md Task 3.1.
// ============================================================================

/**
 * Single-producer, single-consumer async queue. Items pushed before a
 * consumer attaches are buffered. `close()` signals end-of-stream;
 * `for await` returns done once the buffer drains.
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    this.buffer.push(item);
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.waiter) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.buffer.length > 0) {
        yield this.buffer.shift()!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}
