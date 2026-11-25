/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface RingBufferEntry<T> {
  seq: number;
  timestamp: number;
  data: T;
}

export interface RingBufferQueryOptions<T> {
  sinceSeq?: number;
  limit?: number;
  filter?: (entry: RingBufferEntry<T>) => boolean;
}

export interface RingBufferQueryResult<T> {
  entries: Array<RingBufferEntry<T>>;
  latestSeq: number;
  oldestSeq: number;
  droppedCount: number;
}

/**
 * Bounded FIFO ring buffer that assigns monotonically increasing 1-based
 * sequence numbers so callers can poll incrementally without missing events.
 */
export class RingBuffer<T> {
  readonly #capacity: number;
  #items: Array<RingBufferEntry<T>> = [];
  #nextSeq = 1;
  #droppedCount = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(
        `RingBuffer capacity must be a positive integer (got ${capacity}).`,
      );
    }
    this.#capacity = capacity;
  }

  get capacity(): number {
    return this.#capacity;
  }

  get size(): number {
    return this.#items.length;
  }

  get latestSeq(): number {
    return this.#nextSeq - 1;
  }

  get droppedCount(): number {
    return this.#droppedCount;
  }

  push(data: T, timestamp: number = Date.now()): RingBufferEntry<T> {
    const entry: RingBufferEntry<T> = {
      seq: this.#nextSeq++,
      timestamp,
      data,
    };
    this.#items.push(entry);
    if (this.#items.length > this.#capacity) {
      const overflow = this.#items.length - this.#capacity;
      this.#items.splice(0, overflow);
      this.#droppedCount += overflow;
    }
    return entry;
  }

  query(options: RingBufferQueryOptions<T> = {}): RingBufferQueryResult<T> {
    const {sinceSeq, limit, filter} = options;
    const matched: Array<RingBufferEntry<T>> = [];
    for (const entry of this.#items) {
      if (sinceSeq !== undefined && entry.seq <= sinceSeq) {
        continue;
      }
      if (filter && !filter(entry)) {
        continue;
      }
      matched.push(entry);
    }
    const entries =
      limit !== undefined && limit >= 0 && matched.length > limit
        ? sinceSeq !== undefined
          ? matched.slice(0, limit)
          : matched.slice(matched.length - limit)
        : matched;
    return {
      entries,
      latestSeq: this.latestSeq,
      oldestSeq: this.#items[0]?.seq ?? 0,
      droppedCount: this.#droppedCount,
    };
  }

  clear(): void {
    this.#items = [];
    this.#droppedCount = 0;
  }
}
