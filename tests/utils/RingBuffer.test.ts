/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {RingBuffer} from '../../src/utils/RingBuffer.js';

describe('RingBuffer', () => {
  it('assigns monotonic 1-based sequences and tracks dropped count', () => {
    const buffer = new RingBuffer<string>(3);

    const e1 = buffer.push('a', 100);
    const e2 = buffer.push('b', 200);
    const e3 = buffer.push('c', 300);
    const e4 = buffer.push('d', 400);

    assert.equal(e1.seq, 1);
    assert.equal(e2.seq, 2);
    assert.equal(e3.seq, 3);
    assert.equal(e4.seq, 4);
    assert.equal(buffer.size, 3);
    assert.equal(buffer.latestSeq, 4);
    assert.equal(buffer.droppedCount, 1);

    const all = buffer.query();
    assert.deepEqual(
      all.entries.map(item => [item.seq, item.data]),
      [
        [2, 'b'],
        [3, 'c'],
        [4, 'd'],
      ],
    );
    assert.equal(all.oldestSeq, 2);
    assert.equal(all.latestSeq, 4);
    assert.equal(all.droppedCount, 1);
  });

  it('supports sinceSeq, filter, and limit', () => {
    const buffer = new RingBuffer<number>(10);
    for (let i = 1; i <= 6; i++) {
      buffer.push(i * 10, i);
    }

    const res = buffer.query({
      sinceSeq: 2,
      filter: entry => entry.data % 20 === 0,
      limit: 1,
    });
    assert.equal(res.entries.length, 1);
    assert.equal(res.entries[0].seq, 4);
    assert.equal(res.entries[0].data, 40);
  });

  it('rejects non-positive or non-integer capacities', () => {
    assert.throws(() => new RingBuffer<number>(0), /positive integer/);
    assert.throws(() => new RingBuffer<number>(-2), /positive integer/);
    assert.throws(() => new RingBuffer<number>(1.5), /positive integer/);
  });

  it('clears items and resets droppedCount while keeping latestSeq monotonic', () => {
    const buffer = new RingBuffer<string>(2);
    buffer.push('x', 1);
    buffer.push('y', 2);
    buffer.push('z', 3);
    assert.equal(buffer.droppedCount, 1);

    buffer.clear();
    assert.equal(buffer.size, 0);
    assert.equal(buffer.droppedCount, 0);
    const next = buffer.push('w', 4);
    assert.equal(next.seq, 4);
  });
});
