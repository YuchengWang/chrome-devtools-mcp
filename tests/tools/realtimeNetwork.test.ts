/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import {describe, it} from 'node:test';

import sinon from 'sinon';

import {NetworkMonitorsManager} from '../../src/config/NetworkMonitorsConfig.js';
import {
  handleAuthChallenge,
  listWebsocketConnections,
  pollMonitorEvents,
  pollNetworkAlerts,
  pollSseEvents,
  pollWsFrames,
  waitForNetworkResponse,
} from '../../src/tools/realtimeNetwork.js';
import {createHandlerMocks} from '../mocks.js';
import {createTempDir} from '../utils.js';

describe('realtimeNetwork tools', () => {
  it('lists WebSocket connections and polls WS/SSE/alert buffers', async () => {
    const {page, response, context, args} = createHandlerMocks();
    page.listWebSocketConnections.returns([
      {
        requestId: 'ws-1',
        url: 'wss://example.com/ws',
        status: 'open',
        createdAt: 1,
        lastActivityAt: 2,
        framesSent: 1,
        framesReceived: 3,
        errorCount: 0,
      },
    ]);
    page.pollWsFrames.returns({
      entries: [
        {
          seq: 5,
          timestamp: 10,
          data: {
            requestId: 'ws-1',
            url: 'wss://example.com/ws',
            direction: 'received',
            cdpTimestamp: 10,
            payload: '{"ok":true}',
            payloadLength: 11,
            truncated: false,
          },
        },
      ],
      latestSeq: 5,
      oldestSeq: 5,
      droppedCount: 0,
    });
    page.pollSseEvents.returns({
      entries: [
        {
          seq: 2,
          timestamp: 20,
          data: {
            requestId: 'sse-1',
            url: 'https://example.com/sse',
            cdpTimestamp: 20,
            eventName: 'delta',
            eventId: 'e-1',
            data: 'chunk',
            dataLength: 5,
            truncated: false,
          },
        },
      ],
      latestSeq: 2,
      oldestSeq: 2,
      droppedCount: 0,
    });
    page.pollNetworkAlerts.returns({
      entries: [
        {
          seq: 1,
          timestamp: 30,
          data: {
            kind: 'http_error',
            category: 'http_5xx',
            url: 'https://example.com/500',
            status: 502,
            statusText: 'Bad Gateway',
          },
        },
      ],
      latestSeq: 1,
      oldestSeq: 1,
      droppedCount: 0,
    });

    await listWebsocketConnections(args).handler(
      {params: {}, page},
      response,
      context,
    );
    await pollWsFrames(args).handler(
      {params: {unreadOnly: true}, page},
      response,
      context,
    );
    await pollSseEvents(args).handler(
      {params: {eventName: 'delta'}, page},
      response,
      context,
    );
    await pollNetworkAlerts(args).handler(
      {params: {categories: ['http_5xx']}, page},
      response,
      context,
    );

    const lines = response.appendResponseLine
      .getCalls()
      .map(c => c.args[0])
      .join('\n');
    assert.match(lines, /wss:\/\/example\.com\/ws/);
    assert.match(lines, /#5 \[received\].*\{"ok":true\}/);
    assert.match(lines, /#2 \[delta id=e-1\].*chunk/);
    assert.match(lines, /#1 \[http_error\/http_5xx\] status=502/);
  });

  it('returns wait_for_network_response inline or spills large responses to tmp/', async () => {
    const {page, response, context, args} = createHandlerMocks();
    page.waitForNetworkResponse.resolves({
      url: 'https://api.example.com/small',
      status: 200,
      statusText: 'OK',
      method: 'GET',
      resourceType: 'fetch',
      headers: {'content-type': 'application/json'},
      bodyBuffer: Buffer.from('{"a":1}', 'utf8'),
      bodyText: '{"a":1}',
      isBinary: false,
      elapsedMs: 12,
    });

    await waitForNetworkResponse(args).handler(
      {params: {urlRegex: '/small', status: 200}, page},
      response,
      context,
    );
    assert.match(
      response.appendResponseLine
        .getCalls()
        .map(c => c.args[0])
        .join('\n'),
      /\{"a":1\}/,
    );

    const {
      page: bigPage,
      response: bigResp,
      context: bigCtx,
    } = createHandlerMocks();
    const longJson = JSON.stringify({payload: 'x'.repeat(200)});
    bigPage.waitForNetworkResponse.resolves({
      url: 'https://api.example.com/big',
      status: 200,
      statusText: 'OK',
      method: 'GET',
      resourceType: 'xhr',
      headers: {'content-type': 'application/json'},
      bodyBuffer: Buffer.from(longJson, 'utf8'),
      bodyText: longJson,
      isBinary: false,
      elapsedMs: 30,
    });

    await waitForNetworkResponse(args).handler(
      {params: {maxInlineChars: 50}, page: bigPage},
      bigResp,
      bigCtx,
    );
    sinon.assert.calledOnce(bigCtx.saveTemporaryFile);
    assert.match(
      bigResp.appendResponseLine
        .getCalls()
        .map(c => c.args[0])
        .join('\n'),
      /Saved response body.*to \/tmp\/network-response-/,
    );
  });

  it('forwards handle_auth_challenge without leaking passwords', async () => {
    const {page, response, context, args} = createHandlerMocks();
    page.handleAuthChallenge.resolves({
      action: 'provide',
      resolved: {
        challengeId: 'auth-1',
        requestId: 'req-1',
        url: 'https://secure.example.com',
        method: 'GET',
        resourceType: 'Document',
        frameId: 'f1',
        source: 'Server',
        origin: 'https://secure.example.com',
        scheme: 'Basic',
        realm: 'Admin',
        createdAt: 100,
        status: 'provided',
        resolvedAt: 120,
      },
      pending: [],
      history: [],
      defaultAction: 'cancel',
    });

    await handleAuthChallenge(args).handler(
      {
        params: {
          action: 'provide',
          challengeId: 'auth-1',
          username: 'alice',
          password: 'top-secret-password',
        },
        page,
      },
      response,
      context,
    );

    const output = response.appendResponseLine
      .getCalls()
      .map(c => c.args[0])
      .join('\n');
    assert.match(output, /Resolved auth challenge auth-1 \(provided\)/);
    assert.doesNotMatch(output, /top-secret-password/);
  });

  it('polls monitor events from NetworkMonitorsManager', async () => {
    using dir = createTempDir();
    using manager = new NetworkMonitorsManager({
      configPath: path.join(dir.path, 'missing.json'),
      cwd: dir.path,
      tmpDir: dir.path,
      skipDiscovery: true,
    });
    const {response, context, args} = createHandlerMocks();
    context.getNetworkMonitorsManager.returns(manager);

    await pollMonitorEvents(args).handler(
      {params: {flush: true}},
      response,
      context,
    );

    const lines = response.appendResponseLine
      .getCalls()
      .map(c => c.args[0])
      .join('\n');
    assert.match(lines, /Network monitors:/);
    assert.match(lines, /Monitor events: returned=0/);
  });
});
