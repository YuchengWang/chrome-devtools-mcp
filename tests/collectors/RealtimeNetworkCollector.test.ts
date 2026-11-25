/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import {describe, it} from 'node:test';

import sinon from 'sinon';

import {RealtimeNetworkCollector} from '../../src/collectors/RealtimeNetworkCollector.js';
import {NetworkMonitorsManager} from '../../src/config/NetworkMonitorsConfig.js';
import type {HTTPResponse} from '../../src/third_party/browser.js';
import {createMockHTTPRequest, createMockPuppeteerPage} from '../mocks.js';
import {createTempDir} from '../utils.js';

function createMockResponse(options: {
  url: string;
  method?: string;
  status?: number;
  statusText?: string;
  resourceType?: 'xhr' | 'fetch' | 'document';
  headers?: Record<string, string>;
  content?: Buffer;
}): HTTPResponse {
  const req = createMockHTTPRequest({
    url: options.url,
    method: options.method ?? 'GET',
    resourceType: options.resourceType ?? 'fetch',
    headers: {},
  });
  const body = options.content ?? Buffer.from('ok', 'utf8');
  return {
    url: () => options.url,
    status: () => options.status ?? 200,
    statusText: () => options.statusText ?? 'OK',
    headers: () => options.headers ?? {'content-type': 'application/json'},
    request: () => req,
    buffer: sinon.stub().resolves(body),
    content: sinon.stub().resolves(body),
  } as unknown as HTTPResponse;
}

describe('RealtimeNetworkCollector', () => {
  it('captures WebSocket lifecycle and frames with unread cursor', () => {
    const page = createMockPuppeteerPage();
    using collector = new RealtimeNetworkCollector(page);

    page.cdpSession.emit('Network.webSocketCreated', {
      requestId: 'ws-1',
      url: 'wss://stream.example.com/feed',
      initiator: {type: 'script'},
    });
    page.cdpSession.emit('Network.webSocketHandshakeResponseReceived', {
      requestId: 'ws-1',
      timestamp: 100.1,
      response: {status: 101},
    });
    page.cdpSession.emit('Network.webSocketFrameSent', {
      requestId: 'ws-1',
      timestamp: 100.2,
      response: {opcode: 1, mask: true, payloadData: '{"op":"subscribe"}'},
    });
    page.cdpSession.emit('Network.webSocketFrameReceived', {
      requestId: 'ws-1',
      timestamp: 100.3,
      response: {opcode: 1, mask: false, payloadData: '{"price":101}'},
    });
    page.cdpSession.emit('Network.webSocketFrameError', {
      requestId: 'ws-1',
      timestamp: 100.4,
      errorMessage: 'Unexpected opcode',
    });
    page.cdpSession.emit('Network.webSocketClosed', {
      requestId: 'ws-1',
      timestamp: 100.5,
    });

    const conns = collector.listWebSocketConnections();
    assert.equal(conns.length, 1);
    assert.equal(conns[0].status, 'closed');
    assert.equal(conns[0].framesSent, 1);
    assert.equal(conns[0].framesReceived, 1);
    assert.equal(conns[0].errorCount, 1);
    assert.equal(conns[0].handshakeStatus, 101);

    const firstUnread = collector.pollWsFrames({unreadOnly: true, limit: 2});
    assert.equal(firstUnread.entries.length, 2);
    assert.deepEqual(
      firstUnread.entries.map(e => e.data.direction),
      ['sent', 'received'],
    );

    const nextUnread = collector.pollWsFrames({unreadOnly: true});
    assert.equal(nextUnread.entries.length, 1);
    assert.equal(nextUnread.entries[0].data.direction, 'error');
    assert.equal(nextUnread.entries[0].data.errorMessage, 'Unexpected opcode');
  });

  it('captures SSE EventSource messages with URL correlation', () => {
    const page = createMockPuppeteerPage();
    using collector = new RealtimeNetworkCollector(page);

    page.cdpSession.emit('Network.requestWillBeSent', {
      requestId: 'sse-1',
      timestamp: 200,
      type: 'EventSource',
      request: {url: 'https://events.example.com/stream', method: 'GET'},
    });
    page.cdpSession.emit('Network.eventSourceMessageReceived', {
      requestId: 'sse-1',
      timestamp: 201,
      eventName: 'tick',
      eventId: '42',
      data: '{"value":99}',
    });
    page.cdpSession.emit('Network.eventSourceMessageReceived', {
      requestId: 'sse-1',
      timestamp: 202,
      eventName: 'heartbeat',
      eventId: '43',
      data: 'ping',
    });

    const tickOnly = collector.pollSseEvents({eventName: 'tick'});
    assert.equal(tickOnly.entries.length, 1);
    assert.equal(
      tickOnly.entries[0].data.url,
      'https://events.example.com/stream',
    );
    assert.equal(tickOnly.entries[0].data.eventId, '42');
    assert.equal(tickOnly.entries[0].data.data, '{"value":99}');
  });

  it('captures Network.loadingFailed, HTTP 4xx/5xx, and Audits issues', () => {
    const page = createMockPuppeteerPage();
    using collector = new RealtimeNetworkCollector(page);

    page.cdpSession.emit('Network.requestWillBeSent', {
      requestId: 'req-fail',
      timestamp: 300,
      type: 'XHR',
      request: {url: 'https://api.example.com/fail', method: 'POST'},
    });
    page.cdpSession.emit('Network.loadingFailed', {
      requestId: 'req-fail',
      timestamp: 301,
      type: 'XHR',
      errorText: 'net::ERR_CONNECTION_RESET',
      canceled: false,
    });
    page.cdpSession.emit('Network.loadingFailed', {
      requestId: 'req-cancel',
      timestamp: 302,
      type: 'XHR',
      errorText: 'net::ERR_ABORTED',
      canceled: true,
    });
    page.cdpSession.emit('Network.responseReceived', {
      requestId: 'req-401',
      timestamp: 303,
      type: 'Fetch',
      response: {
        url: 'https://api.example.com/me',
        status: 401,
        statusText: 'Unauthorized',
      },
    });
    page.cdpSession.emit('Audits.issueAdded', {
      issue: {
        code: 'CorsIssue',
        details: {
          corsIssueDetails: {
            corsErrorStatus: {corsError: 'MissingAllowOriginHeader'},
            resourceIPAddressSpace: 'Public',
            request: {url: 'https://cors.example.com/data'},
          },
        },
      },
    });

    const nonCanceled = collector.pollNetworkAlerts({includeCanceled: false});
    assert.equal(nonCanceled.entries.length, 3);
    assert.deepEqual(
      nonCanceled.entries.map(e => e.data.category),
      ['loading_failed', 'auth', 'cors'],
    );
  });

  it('waits for matching XHR/Fetch responses and supports lookback', async () => {
    const page = createMockPuppeteerPage();
    using collector = new RealtimeNetworkCollector(page);

    const earlyResp = createMockResponse({
      url: 'https://api.example.com/items',
      method: 'POST',
      status: 201,
      content: Buffer.from('{"created":true}', 'utf8'),
    });
    page.emit('response', earlyResp);

    const recent = await collector.waitForNetworkResponse({
      urlRegex: /\/items$/,
      method: 'POST',
      status: 201,
      includeRecentMs: 5_000,
    });
    assert.equal(recent.status, 201);
    assert.equal(recent.bodyText, '{"created":true}');
    assert.equal(recent.isBinary, false);

    const futurePromise = collector.waitForNetworkResponse({
      urlRegex: /\/blob$/,
      timeoutMs: 2_000,
    });
    const binaryResp = createMockResponse({
      url: 'https://api.example.com/blob',
      content: Buffer.from([0xff, 0x00, 0xfe]),
    });
    page.emit('response', binaryResp);
    const future = await futurePromise;
    assert.equal(future.isBinary, true);
    assert.deepEqual(future.bodyBuffer, Buffer.from([0xff, 0x00, 0xfe]));
  });

  it('feeds matched WS/SSE/Fetch events into NetworkMonitorsManager', async () => {
    using dir = createTempDir();
    const configPath = path.join(dir.path, 'monitors.json');
    const fs = await import('node:fs');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        monitors: [
          {
            id: 'all-feed',
            types: ['fetch', 'ws', 'sse'],
            urlPattern: '*://feed.example.com/*',
            includeBody: true,
          },
        ],
      }),
      'utf8',
    );
    using manager = new NetworkMonitorsManager({
      configPath,
      cwd: dir.path,
      tmpDir: dir.path,
      skipDiscovery: false,
    });
    manager.start();

    const page = createMockPuppeteerPage();
    using collector = new RealtimeNetworkCollector(page, {
      monitorsManager: manager,
    });

    page.cdpSession.emit('Network.webSocketCreated', {
      requestId: 'ws-m1',
      url: 'wss://feed.example.com/ws',
    });
    page.cdpSession.emit('Network.webSocketFrameReceived', {
      requestId: 'ws-m1',
      timestamp: 10,
      response: {opcode: 1, mask: false, payloadData: 'hello-ws'},
    });
    page.cdpSession.emit('Network.requestWillBeSent', {
      requestId: 'sse-m1',
      timestamp: 11,
      type: 'EventSource',
      request: {url: 'https://feed.example.com/sse', method: 'GET'},
    });
    page.cdpSession.emit('Network.eventSourceMessageReceived', {
      requestId: 'sse-m1',
      timestamp: 12,
      eventName: 'msg',
      eventId: '1',
      data: 'hello-sse',
    });
    page.emit(
      'response',
      createMockResponse({
        url: 'https://feed.example.com/api',
        content: Buffer.from('hello-fetch', 'utf8'),
      }),
    );

    await new Promise(resolve => setTimeout(resolve, 20));
    const events = manager.pollEvents({monitorId: 'all-feed'});
    assert.equal(events.entries.length, 3);
    assert.deepEqual(
      events.entries.map(e => e.data.type),
      ['ws', 'sse', 'fetch'],
    );
    assert.equal(collector.listWebSocketConnections().length, 1);
  });

  it('truncates multi-byte UTF-8 response bodies by byte limit and clears maps on dispose()', async () => {
    using dir = createTempDir();
    const configPath = path.join(dir.path, 'monitors.json');
    const fs = await import('node:fs');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        monitors: [
          {
            id: 'utf8-cap',
            types: ['fetch'],
            urlPattern: '*://utf8.example.com/*',
            includeBody: true,
            maxBodyBytes: 10,
          },
        ],
      }),
      'utf8',
    );
    using manager = new NetworkMonitorsManager({
      configPath,
      cwd: dir.path,
      tmpDir: dir.path,
      skipDiscovery: false,
    });
    manager.start();

    const page = createMockPuppeteerPage();
    const collector = new RealtimeNetworkCollector(page, {
      monitorsManager: manager,
    });

    page.cdpSession.emit('Network.webSocketCreated', {
      requestId: 'ws-disp',
      url: 'wss://utf8.example.com/ws',
    });
    assert.equal(collector.listWebSocketConnections().length, 1);

    const multiByteBody = Buffer.from('中'.repeat(20), 'utf8'); // 60 UTF-8 bytes
    page.emit(
      'response',
      createMockResponse({
        url: 'https://utf8.example.com/data',
        content: multiByteBody,
      }),
    );

    await new Promise(resolve => setTimeout(resolve, 25));
    const events = manager.pollEvents({monitorId: 'utf8-cap'});
    assert.equal(events.entries.length, 1);
    assert.equal(events.entries[0].data.body, '中中中');
    assert.equal(
      Buffer.byteLength(events.entries[0].data.body ?? '', 'utf8'),
      9,
    );
    assert.equal(events.entries[0].data.bodyTruncated, true);

    collector.dispose();
    assert.equal(collector.listWebSocketConnections().length, 0);
    await assert.rejects(
      collector.waitForNetworkResponse({urlRegex: /.*/}),
      /already been disposed/,
    );
  });
});
