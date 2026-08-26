/**
 * A push-based AsyncIterable: producers `push()` events / `close()`, a single
 * consumer iterates. Used by every engine implementation to bridge
 * event-callback APIs (speechSynthesis handlers, runtime message streams)
 * into the AsyncIterable<EngineEvent> contract.
 */
export class EventStream<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiters: Array<(r: IteratorResult<T>) => void> = [];
  private closed = false;

  push(ev: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ done: false, value: ev });
    else this.queue.push(ev);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true, value: undefined as T });
  }

  /** Push a terminal `cancelled` event and close (used by preemption paths). */
  closeCancelled(ev: T): void {
    if (this.closed) return;
    this.push(ev);
    this.close();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      if (this.queue.length > 0) {
        yield this.queue.shift() as T;
      } else if (this.closed) {
        return;
      } else {
        const r = await new Promise<IteratorResult<T>>((res) => this.waiters.push(res));
        if (r.done) return;
        yield r.value;
      }
    }
  }
}