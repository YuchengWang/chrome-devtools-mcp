/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import sinon from 'sinon';

import {listDownloads, waitForDownload} from '../../src/tools/downloads.js';
import {createHandlerMocks} from '../mocks.js';

describe('downloads tools', () => {
  it('lists recorded downloads and directory', async () => {
    const {response, context, args} = createHandlerMocks();
    context.getDownloadDirectory.returns('/tmp/chrome-dl');
    context.getDownloads.returns([
      {
        guid: 'dl-1',
        url: 'https://example.com/report.csv',
        suggestedFilename: 'report.csv',
        filePath: '/tmp/chrome-dl/dl-1',
        state: 'completed',
        totalBytes: 128,
        receivedBytes: 128,
        createdAt: 100,
        updatedAt: 200,
        completedAt: 200,
      },
    ]);

    await listDownloads(args).handler(
      {params: {state: 'completed', limit: 10}},
      response,
      context,
    );

    sinon.assert.calledOnce(context.enableDownloads);
    sinon.assert.calledOnceWithExactly(context.getDownloads, {
      state: 'completed',
      limit: 10,
    });
    const output = response.appendResponseLine
      .getCalls()
      .map(c => c.args[0])
      .join('\n');
    assert.match(output, /downloadDir=\/tmp\/chrome-dl/);
    assert.match(
      output,
      /\[dl-1\] COMPLETED "report\.csv".*filePath=\/tmp\/chrome-dl\/dl-1/,
    );
  });

  it('waits for matching download with compiled regexes', async () => {
    const {response, context, args} = createHandlerMocks();
    context.waitForDownload.resolves({
      guid: 'dl-2',
      url: 'https://example.com/files/export.pdf',
      suggestedFilename: 'export.pdf',
      filePath: '/tmp/dl-2',
      state: 'completed',
      totalBytes: 4096,
      receivedBytes: 4096,
      createdAt: 100,
      updatedAt: 300,
      completedAt: 300,
    });

    await waitForDownload(args).handler(
      {
        params: {
          filenameRegex: '\\.pdf$',
          timeoutMs: 5000,
        },
      },
      response,
      context,
    );

    const callArg = context.waitForDownload.firstCall.args[0];
    assert.ok(callArg?.filenameRegex instanceof RegExp);
    assert.equal(callArg.timeoutMs, 5000);
    assert.match(
      response.appendResponseLine
        .getCalls()
        .map(c => c.args[0])
        .join('\n'),
      /Download completed: guid=dl-2, suggestedFilename="export\.pdf"/,
    );
  });
});
