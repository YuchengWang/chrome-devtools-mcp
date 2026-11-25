/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isUtf8} from 'node:buffer';

import {
  matchesUrlPattern,
  type MonitorEventType,
  type NetworkMonitorsManager,
} from '../config/NetworkMonitorsConfig.js';
import {RESPONSE_BODY_TIMEOUT_MS} from '../formatters/NetworkFormatter.js';
import {
  DevTools,
  type HTTPResponse,
  type Page,
} from '../third_party/browser.js';
import {getErrorMessage} from '../utils/errorHandling.js';
import {logger} from '../utils/logger.js';
import {
  RingBuffer,
  type RingBufferEntry,
  type RingBufferQueryResult,
} from '../utils/RingBuffer.js';
import {sliceUtf8Head, truncateText} from '../utils/text.js';

export interface CdpSessionLike {
  on(event: string, listener: (payload: unknown) => void): unknown;
  off(event: string, listener: (payload: unknown) => void): unknown;
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export function isCdpSessionLike(val: unknown): val is CdpSessionLike {
  return (
    typeof val === 'object' &&
    val !== null &&
    'on' in val &&
    typeof val.on === 'function' &&
    'off' in val &&
    typeof val.off === 'function' &&
    'send' in val &&
    typeof val.send === 'function'
  );
}

export function getPageCdpSession(page: Page): CdpSessionLike | undefined {
  if ('_client' in page && typeof page._client === 'function') {
    const client: unknown = page._client();
    return isCdpSessionLike(client) ? client : undefined;
  }
  return undefined;
}

export type WebSocketStatus = 'connecting' | 'open' | 'closed' | 'error';

export interface WebSocketConnectionInfo {
  requestId: string;
  url: string;
  status: WebSocketStatus;
  createdAt: number;
  closedAt?: number;
  lastActivityAt: number;
  framesSent: number;
  framesReceived: number;
  errorCount: number;
  lastError?: string;
  handshakeStatus?: number;
  initiatorType?: string;
}

export interface WsFrameData {
  requestId: string;
  url: string;
  direction: 'sent' | 'received' | 'error';
  cdpTimestamp: number;
  opcode?: number;
  mask?: boolean;
  payload?: string;
  payloadLength: number;
  truncated: boolean;
  errorMessage?: string;
}

export interface SseEventData {
  requestId: string;
  url: string;
  cdpTimestamp: number;
  eventName: string;
  eventId: string;
  data: string;
  dataLength: number;
  truncated: boolean;
}

export type NetworkAlertKind = 'loading_failed' | 'http_error' | 'audit_issue';

export type NetworkAlertCategory =
  | 'cors'
  | 'csp'
  | 'http_4xx'
  | 'http_5xx'
  | 'auth'
  | 'rate_limit'
  | 'loading_failed'
  | 'mixed_content'
  | 'blocked'
  | 'audit_issue';

export interface NetworkAlertData {
  kind: NetworkAlertKind;
  category: NetworkAlertCategory;
  requestId?: string;
  url: string;
  method?: string;
  resourceType?: string;
  status?: number;
  statusText?: string;
  errorText?: string;
  canceled?: boolean;
  blockedReason?: string;
  corsError?: string;
  issueCode?: string;
  detailsSummary?: string[];
}

export interface WaitForNetworkResponseOptions {
  urlRegex: RegExp;
  method?: string;
  status?: number;
  resourceTypes?: string[];
  timeoutMs?: number;
  includeRecentMs?: number;
}

export interface WaitForNetworkResponseResult {
  url: string;
  status: number;
  statusText: string;
  method: string;
  resourceType: string;
  headers: Record<string, string>;
  bodyBuffer?: Uint8Array;
  bodyText?: string;
  isBinary: boolean;
  bodyError?: string;
  elapsedMs: number;
}

interface RequestMetadata {
  url: string;
  method: string;
  resourceType: string;
  timestamp: number;
}

interface RecentResponseEntry {
  response: HTTPResponse;
  receivedAt: number;
}

interface PendingResponseWaiter {
  options: WaitForNetworkResponseOptions;
  match: (response: HTTPResponse) => boolean;
  resolve: (response: HTTPResponse) => void;
  reject: (error: Error) => void;
}

const MAX_WS_CONNECTIONS = 200;
const MAX_WS_FRAMES = 1_000;
const MAX_SSE_EVENTS = 1_000;
const MAX_NETWORK_ALERTS = 500;
const MAX_REQUEST_META = 2_000;
const MAX_RECENT_RESPONSES = 100;
const MAX_CAPTURED_FRAME_CHARS = 65_536;
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function truncatePayload(
  text: string,
  limit: number,
): {
  value: string;
  length: number;
  truncated: boolean;
} {
  if (text.length <= limit) {
    return {value: text, length: text.length, truncated: false};
  }
  return {
    value: truncateText(text, limit, {ellipsis: '... <truncated>'}),
    length: text.length,
    truncated: true,
  };
}

function redactHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const headersList = Object.entries(headers).map(([name, value]) => ({
    name,
    value,
  }));
  const redacted =
    DevTools.NetworkRequestFormatter.sanitizeHeaders(headersList);
  const result: Record<string, string> = {};
  for (const item of redacted) {
    result[item.name] = item.value;
  }
  return result;
}

function extractAuditIssueInfo(issue: Record<string, unknown>): {
  code: string;
  urls: string[];
  detailsSummary: string[];
  corsError?: string;
} {
  const code = asString(issue['code']) ?? 'UnknownIssue';
  const urls: string[] = [];
  const detailsSummary: string[] = [];
  let corsError: string | undefined;

  const details = issue['details'];
  if (isRecord(details)) {
    for (const subDetails of Object.values(details)) {
      if (!isRecord(subDetails)) {
        continue;
      }
      const req = subDetails['request'];
      if (isRecord(req)) {
        const reqUrl = asString(req['url']);
        if (reqUrl) {
          urls.push(reqUrl);
        }
      }
      const blockedUrl =
        asString(subDetails['blockedURL']) ??
        asString(subDetails['insecureURL']);
      if (blockedUrl) {
        urls.push(blockedUrl);
      }
      const directive = asString(subDetails['violatedDirective']);
      if (directive) {
        detailsSummary.push(`directive: ${directive}`);
      }
      const corsStatus = subDetails['corsErrorStatus'];
      if (isRecord(corsStatus)) {
        const errCode = asString(corsStatus['corsError']);
        if (errCode) {
          corsError = errCode;
          detailsSummary.push(`corsError: ${errCode}`);
        }
      }
      const blockedReason = asString(subDetails['reason']);
      if (blockedReason) {
        detailsSummary.push(`reason: ${blockedReason}`);
      }
    }
  }

  return {code, urls, detailsSummary, corsError};
}

function classifyAuditCategory(code: string): NetworkAlertCategory {
  if (code.includes('CorsIssue')) {
    return 'cors';
  }
  if (code.includes('ContentSecurityPolicyIssue')) {
    return 'csp';
  }
  if (code.includes('MixedContentIssue')) {
    return 'mixed_content';
  }
  if (code.includes('BlockedByResponseIssue')) {
    return 'blocked';
  }
  return 'audit_issue';
}

export interface RealtimeNetworkCollectorOptions {
  monitorsManager?: NetworkMonitorsManager;
  redactNetworkHeaders?: () => boolean;
}

/**
 * Captures real-time CDP WebSocket, SSE, loading failure, 4xx/5xx, and
 * Audits.issueAdded events per page into bounded ring buffers, feeds matched
 * events to {@link NetworkMonitorsManager}, and serves `waitForNetworkResponse`.
 */
export class RealtimeNetworkCollector implements Disposable {
  readonly #page: Page;
  readonly #monitorsManager?: NetworkMonitorsManager;
  readonly #redactNetworkHeaders: () => boolean;

  #cdpSession?: CdpSessionLike;
  #disposed = false;

  #wsConnections = new Map<string, WebSocketConnectionInfo>();
  #wsFrames = new RingBuffer<WsFrameData>(MAX_WS_FRAMES);
  #sseEvents = new RingBuffer<SseEventData>(MAX_SSE_EVENTS);
  #alerts = new RingBuffer<NetworkAlertData>(MAX_NETWORK_ALERTS);
  #requestMeta = new Map<string, RequestMetadata>();
  #recentResponses: RecentResponseEntry[] = [];
  #responseWaiters = new Set<PendingResponseWaiter>();

  #wsReadCursor = 0;
  #sseReadCursor = 0;
  #alertReadCursor = 0;

  constructor(page: Page, options: RealtimeNetworkCollectorOptions = {}) {
    this.#page = page;
    this.#monitorsManager = options.monitorsManager;
    this.#redactNetworkHeaders = options.redactNetworkHeaders ?? (() => false);
    this.#attachPageListeners();
    this.syncCdpSession();
  }

  syncCdpSession(): void {
    if (this.#disposed) {
      return;
    }
    const nextSession = getPageCdpSession(this.#page);
    if (nextSession === this.#cdpSession) {
      return;
    }
    this.#detachCdpListeners();
    this.#cdpSession = nextSession;
    if (!nextSession) {
      return;
    }
    for (const [eventName, handler] of this.#cdpHandlers()) {
      nextSession.on(eventName, handler);
    }
  }

  #attachPageListeners(): void {
    this.#page.on('response', this.#onPuppeteerResponse);
    this.#page.on('framenavigated', this.#onFrameNavigated);
  }

  #detachPageListeners(): void {
    this.#page.off('response', this.#onPuppeteerResponse);
    this.#page.off('framenavigated', this.#onFrameNavigated);
  }

  #detachCdpListeners(): void {
    if (!this.#cdpSession) {
      return;
    }
    for (const [eventName, handler] of this.#cdpHandlers()) {
      this.#cdpSession.off(eventName, handler);
    }
    this.#cdpSession = undefined;
  }

  #cdpHandlers(): Array<[string, (payload: unknown) => void]> {
    return [
      ['Network.requestWillBeSent', this.#onRequestWillBeSent],
      ['Network.webSocketCreated', this.#onWebSocketCreated],
      [
        'Network.webSocketHandshakeResponseReceived',
        this.#onWebSocketHandshakeResponse,
      ],
      ['Network.webSocketFrameSent', this.#onWebSocketFrameSent],
      ['Network.webSocketFrameReceived', this.#onWebSocketFrameReceived],
      ['Network.webSocketFrameError', this.#onWebSocketFrameError],
      ['Network.webSocketClosed', this.#onWebSocketClosed],
      ['Network.eventSourceMessageReceived', this.#onEventSourceMessage],
      ['Network.loadingFailed', this.#onLoadingFailed],
      ['Network.responseReceived', this.#onResponseReceived],
      ['Audits.issueAdded', this.#onIssueAdded],
    ];
  }

  #onFrameNavigated = (): void => {
    this.syncCdpSession();
  };

  #recordRequestMeta(requestId: string, meta: RequestMetadata): void {
    if (this.#requestMeta.has(requestId)) {
      this.#requestMeta.delete(requestId);
    }
    this.#requestMeta.set(requestId, meta);
    if (this.#requestMeta.size > MAX_REQUEST_META) {
      const oldestKey = this.#requestMeta.keys().next().value;
      if (oldestKey !== undefined) {
        this.#requestMeta.delete(oldestKey);
      }
    }
  }

  #ensureWsConnection(
    requestId: string,
    fallbackUrl = '',
  ): WebSocketConnectionInfo {
    const existing = this.#wsConnections.get(requestId);
    if (existing) {
      return existing;
    }
    if (this.#wsConnections.size >= MAX_WS_CONNECTIONS) {
      let evictKey: string | undefined;
      for (const [key, conn] of this.#wsConnections) {
        if (conn.status === 'closed' || conn.status === 'error') {
          evictKey = key;
          break;
        }
      }
      evictKey ??= this.#wsConnections.keys().next().value;
      if (evictKey !== undefined) {
        this.#wsConnections.delete(evictKey);
      }
    }
    const now = Date.now();
    const created: WebSocketConnectionInfo = {
      requestId,
      url: fallbackUrl,
      status: 'open',
      createdAt: now,
      lastActivityAt: now,
      framesSent: 0,
      framesReceived: 0,
      errorCount: 0,
    };
    this.#wsConnections.set(requestId, created);
    return created;
  }

  #onRequestWillBeSent = (payload: unknown): void => {
    if (!isRecord(payload)) {
      return;
    }
    const requestId = asString(payload['requestId']);
    const request = payload['request'];
    if (!requestId || !isRecord(request)) {
      return;
    }
    const url = asString(request['url']);
    if (!url) {
      return;
    }
    this.#recordRequestMeta(requestId, {
      url,
      method: asString(request['method']) ?? 'GET',
      resourceType: (asString(payload['type']) ?? 'other').toLowerCase(),
      timestamp: Date.now(),
    });
  };

  #onWebSocketCreated = (payload: unknown): void => {
    if (!isRecord(payload)) {
      return;
    }
    const requestId = asString(payload['requestId']);
    const url = asString(payload['url']) ?? '';
    if (!requestId) {
      return;
    }
    const initiator = payload['initiator'];
    const initiatorType = isRecord(initiator)
      ? asString(initiator['type'])
      : undefined;
    const now = Date.now();
    const entry: WebSocketConnectionInfo = {
      requestId,
      url,
      status: 'connecting',
      createdAt: now,
      lastActivityAt: now,
      framesSent: 0,
      framesReceived: 0,
      errorCount: 0,
      initiatorType,
    };
    if (this.#wsConnections.has(requestId)) {
      this.#wsConnections.delete(requestId);
    }
    if (this.#wsConnections.size >= MAX_WS_CONNECTIONS) {
      const oldestKey = this.#wsConnections.keys().next().value;
      if (oldestKey !== undefined) {
        this.#wsConnections.delete(oldestKey);
      }
    }
    this.#wsConnections.set(requestId, entry);
  };

  #onWebSocketHandshakeResponse = (payload: unknown): void => {
    if (!isRecord(payload)) {
      return;
    }
    const requestId = asString(payload['requestId']);
    if (!requestId) {
      return;
    }
    const conn = this.#ensureWsConnection(requestId);
    const response = payload['response'];
    const status = isRecord(response)
      ? asNumber(response['status'])
      : undefined;
    if (status !== undefined) {
      conn.handshakeStatus = status;
    }
    if (conn.status === 'connecting') {
      conn.status = 'open';
    }
    conn.lastActivityAt = Date.now();
  };

  #handleWsFrame(direction: 'sent' | 'received', payload: unknown): void {
    if (!isRecord(payload)) {
      return;
    }
    const requestId = asString(payload['requestId']);
    const response = payload['response'];
    if (!requestId || !isRecord(response)) {
      return;
    }
    const conn = this.#ensureWsConnection(requestId);
    if (conn.status === 'connecting') {
      conn.status = 'open';
    }
    const now = Date.now();
    conn.lastActivityAt = now;
    if (direction === 'sent') {
      conn.framesSent++;
    } else {
      conn.framesReceived++;
    }
    const rawPayload = asString(response['payloadData']) ?? '';
    const truncated = truncatePayload(rawPayload, MAX_CAPTURED_FRAME_CHARS);
    const opcode = asNumber(response['opcode']);
    const mask = asBoolean(response['mask']);
    const cdpTimestamp = asNumber(payload['timestamp']) ?? 0;

    this.#wsFrames.push(
      {
        requestId,
        url: conn.url,
        direction,
        cdpTimestamp,
        opcode,
        mask,
        payload: truncated.value,
        payloadLength: truncated.length,
        truncated: truncated.truncated,
      },
      now,
    );

    this.#monitorsManager?.recordEvent({
      type: 'ws',
      url: conn.url,
      timestamp: now,
      requestId,
      wsDirection: direction,
      wsOpcode: opcode,
      wsPayload: rawPayload,
    });
  }

  #onWebSocketFrameSent = (payload: unknown): void => {
    this.#handleWsFrame('sent', payload);
  };

  #onWebSocketFrameReceived = (payload: unknown): void => {
    this.#handleWsFrame('received', payload);
  };

  #onWebSocketFrameError = (payload: unknown): void => {
    if (!isRecord(payload)) {
      return;
    }
    const requestId = asString(payload['requestId']);
    if (!requestId) {
      return;
    }
    const conn = this.#ensureWsConnection(requestId);
    const errorMessage =
      asString(payload['errorMessage']) ?? 'WebSocket frame error';
    const now = Date.now();
    conn.errorCount++;
    conn.lastError = errorMessage;
    conn.status = 'error';
    conn.lastActivityAt = now;
    const cdpTimestamp = asNumber(payload['timestamp']) ?? 0;

    this.#wsFrames.push(
      {
        requestId,
        url: conn.url,
        direction: 'error',
        cdpTimestamp,
        payloadLength: 0,
        truncated: false,
        errorMessage,
      },
      now,
    );

    this.#monitorsManager?.recordEvent({
      type: 'ws',
      url: conn.url,
      timestamp: now,
      requestId,
      wsDirection: 'error',
      wsError: errorMessage,
    });
  };

  #onWebSocketClosed = (payload: unknown): void => {
    if (!isRecord(payload)) {
      return;
    }
    const requestId = asString(payload['requestId']);
    if (!requestId) {
      return;
    }
    const conn = this.#ensureWsConnection(requestId);
    const now = Date.now();
    conn.status = 'closed';
    conn.closedAt = now;
    conn.lastActivityAt = now;
  };

  #onEventSourceMessage = (payload: unknown): void => {
    if (!isRecord(payload)) {
      return;
    }
    const requestId = asString(payload['requestId']);
    if (!requestId) {
      return;
    }
    const meta = this.#requestMeta.get(requestId);
    const url = meta?.url ?? '';
    const eventName = asString(payload['eventName']) ?? 'message';
    const eventId = asString(payload['eventId']) ?? '';
    const rawData = asString(payload['data']) ?? '';
    const truncated = truncatePayload(rawData, MAX_CAPTURED_FRAME_CHARS);
    const cdpTimestamp = asNumber(payload['timestamp']) ?? 0;
    const now = Date.now();

    this.#sseEvents.push(
      {
        requestId,
        url,
        cdpTimestamp,
        eventName,
        eventId,
        data: truncated.value,
        dataLength: truncated.length,
        truncated: truncated.truncated,
      },
      now,
    );

    this.#monitorsManager?.recordEvent({
      type: 'sse',
      url,
      timestamp: now,
      requestId,
      sseEventName: eventName,
      sseEventId: eventId,
      sseData: rawData,
    });
  };

  #onLoadingFailed = (payload: unknown): void => {
    if (!isRecord(payload)) {
      return;
    }
    const requestId = asString(payload['requestId']) ?? '';
    const meta = this.#requestMeta.get(requestId);
    const errorText = asString(payload['errorText']) ?? 'Loading failed';
    const canceled = asBoolean(payload['canceled']) ?? false;
    const blockedReason = asString(payload['blockedReason']);
    const corsStatus = payload['corsErrorStatus'];
    const corsError = isRecord(corsStatus)
      ? asString(corsStatus['corsError'])
      : undefined;
    const resourceType = (
      asString(payload['type']) ??
      meta?.resourceType ??
      'other'
    ).toLowerCase();

    let category: NetworkAlertCategory = 'loading_failed';
    if (
      corsError ||
      blockedReason === 'cors' ||
      errorText.includes('ERR_BLOCKED_BY_RESPONSE')
    ) {
      category = 'cors';
    } else if (blockedReason === 'csp') {
      category = 'csp';
    } else if (blockedReason || errorText.includes('ERR_BLOCKED_BY_CLIENT')) {
      category = 'blocked';
    }

    this.#alerts.push({
      kind: 'loading_failed',
      category,
      requestId,
      url: meta?.url ?? '',
      method: meta?.method,
      resourceType,
      errorText,
      canceled,
      blockedReason,
      corsError,
    });
  };

  #onResponseReceived = (payload: unknown): void => {
    if (!isRecord(payload)) {
      return;
    }
    const requestId = asString(payload['requestId']) ?? '';
    const response = payload['response'];
    if (!isRecord(response)) {
      return;
    }
    const status = asNumber(response['status']);
    if (status === undefined || status < 400) {
      return;
    }
    const meta = this.#requestMeta.get(requestId);
    const url = asString(response['url']) ?? meta?.url ?? '';
    const statusText = asString(response['statusText']) ?? '';
    const resourceType = (
      asString(payload['type']) ??
      meta?.resourceType ??
      'other'
    ).toLowerCase();

    let category: NetworkAlertCategory;
    if (status === 401 || status === 403) {
      category = 'auth';
    } else if (status === 429) {
      category = 'rate_limit';
    } else if (status >= 500) {
      category = 'http_5xx';
    } else {
      category = 'http_4xx';
    }

    this.#alerts.push({
      kind: 'http_error',
      category,
      requestId,
      url,
      method: meta?.method,
      resourceType,
      status,
      statusText,
    });
  };

  #onIssueAdded = (payload: unknown): void => {
    if (!isRecord(payload)) {
      return;
    }
    const issue = payload['issue'];
    if (!isRecord(issue)) {
      return;
    }
    const info = extractAuditIssueInfo(issue);
    this.#alerts.push({
      kind: 'audit_issue',
      category: classifyAuditCategory(info.code),
      url: info.urls[0] ?? '',
      issueCode: info.code,
      corsError: info.corsError,
      detailsSummary:
        info.detailsSummary.length > 0 ? info.detailsSummary : undefined,
    });
  };

  recordAuthChallengeAlert(info: {
    requestId: string;
    url: string;
    method: string;
    resourceType: string;
    source: string;
    realm: string;
  }): void {
    this.#alerts.push({
      kind: 'http_error',
      category: 'auth',
      requestId: info.requestId,
      url: info.url,
      method: info.method,
      resourceType: info.resourceType.toLowerCase(),
      status: info.source === 'Proxy' ? 407 : 401,
      statusText: `${info.source} auth challenge (${info.realm || 'default'})`,
    });
  }

  #onPuppeteerResponse = (response: HTTPResponse): void => {
    const now = Date.now();
    this.#recentResponses.push({response, receivedAt: now});
    if (this.#recentResponses.length > MAX_RECENT_RESPONSES) {
      this.#recentResponses.splice(
        0,
        this.#recentResponses.length - MAX_RECENT_RESPONSES,
      );
    }

    for (const waiter of this.#responseWaiters) {
      if (waiter.match(response)) {
        this.#responseWaiters.delete(waiter);
        waiter.resolve(response);
      }
    }

    void this.#forwardResponseToMonitors(response, now);
  };

  async #forwardResponseToMonitors(
    response: HTTPResponse,
    timestamp: number,
  ): Promise<void> {
    if (!this.#monitorsManager) {
      return;
    }
    const request = response.request();
    const resourceType = request.resourceType().toLowerCase();
    const monitorType: MonitorEventType | undefined =
      resourceType === 'xhr'
        ? 'xhr'
        : resourceType === 'fetch'
          ? 'fetch'
          : undefined;
    if (!monitorType) {
      return;
    }
    const url = response.url();
    const method = request.method();
    const status = response.status();
    const matched = this.#monitorsManager.matchingMonitorsFor(
      monitorType,
      url,
      {
        method,
        status,
      },
    );
    if (matched.length === 0) {
      return;
    }

    const needsBody = matched.some(rule => rule.includeBody);
    const maxBodyBytes = matched.reduce(
      (max, rule) => Math.max(max, rule.maxBodyBytes),
      0,
    );
    let bodyText: string | undefined;
    let bodyTruncated = false;
    if (
      needsBody &&
      status !== 204 &&
      status !== 304 &&
      (status < 300 || status >= 400)
    ) {
      const bodyResult = await this.#readResponseBodySafe(
        response,
        RESPONSE_BODY_TIMEOUT_MS,
      );
      if (bodyResult.bodyBuffer) {
        if (isUtf8(bodyResult.bodyBuffer)) {
          const buf = Buffer.from(bodyResult.bodyBuffer);
          if (buf.byteLength > maxBodyBytes) {
            bodyText = sliceUtf8Head(buf, maxBodyBytes);
            bodyTruncated = true;
          } else {
            bodyText = buf.toString('utf8');
          }
        } else {
          bodyText = `<binary ${bodyResult.bodyBuffer.byteLength} bytes>`;
        }
      }
    }

    const reqHeaders = request.headers();
    const respHeaders = response.headers();
    const shouldRedact = this.#redactNetworkHeaders();
    this.#monitorsManager.recordEvent({
      type: monitorType,
      url,
      timestamp,
      method,
      status,
      statusText: response.statusText(),
      requestHeaders: shouldRedact ? redactHeaders(reqHeaders) : reqHeaders,
      responseHeaders: shouldRedact ? redactHeaders(respHeaders) : respHeaders,
      body: bodyText,
      bodyTruncated,
    });
  }

  async #readResponseBodySafe(
    response: HTTPResponse,
    timeoutMs: number,
  ): Promise<{bodyBuffer?: Uint8Array; bodyError?: string}> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const buffer = await Promise.race([
        response.buffer(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(
              new Error(`Timed out reading response body after ${timeoutMs}ms`),
            );
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);
      return {bodyBuffer: buffer};
    } catch (error) {
      return {bodyError: getErrorMessage(error)};
    } finally {
      clearTimeout(timer);
    }
  }

  listWebSocketConnections(
    options: {status?: WebSocketStatus; urlPattern?: string} = {},
  ): WebSocketConnectionInfo[] {
    const result: WebSocketConnectionInfo[] = [];
    for (const conn of this.#wsConnections.values()) {
      if (options.status && conn.status !== options.status) {
        continue;
      }
      if (
        options.urlPattern &&
        !matchesUrlPattern(conn.url, options.urlPattern)
      ) {
        continue;
      }
      result.push({...conn});
    }
    return result;
  }

  pollWsFrames(
    options: {
      requestId?: string;
      urlPattern?: string;
      direction?: 'sent' | 'received' | 'error' | 'all';
      sinceSeq?: number;
      unreadOnly?: boolean;
      limit?: number;
    } = {},
  ): RingBufferQueryResult<WsFrameData> {
    const sinceSeq =
      options.sinceSeq ?? (options.unreadOnly ? this.#wsReadCursor : undefined);
    const result = this.#wsFrames.query({
      sinceSeq,
      limit: options.limit,
      filter: (entry: RingBufferEntry<WsFrameData>) => {
        if (options.requestId && entry.data.requestId !== options.requestId) {
          return false;
        }
        if (
          options.direction &&
          options.direction !== 'all' &&
          entry.data.direction !== options.direction
        ) {
          return false;
        }
        if (
          options.urlPattern &&
          !matchesUrlPattern(entry.data.url, options.urlPattern)
        ) {
          return false;
        }
        return true;
      },
    });
    if (options.unreadOnly && result.entries.length > 0) {
      this.#wsReadCursor = result.entries[result.entries.length - 1].seq;
    }
    return result;
  }

  pollSseEvents(
    options: {
      requestId?: string;
      urlPattern?: string;
      eventName?: string;
      sinceSeq?: number;
      unreadOnly?: boolean;
      limit?: number;
    } = {},
  ): RingBufferQueryResult<SseEventData> {
    const sinceSeq =
      options.sinceSeq ??
      (options.unreadOnly ? this.#sseReadCursor : undefined);
    const result = this.#sseEvents.query({
      sinceSeq,
      limit: options.limit,
      filter: (entry: RingBufferEntry<SseEventData>) => {
        if (options.requestId && entry.data.requestId !== options.requestId) {
          return false;
        }
        if (options.eventName && entry.data.eventName !== options.eventName) {
          return false;
        }
        if (
          options.urlPattern &&
          !matchesUrlPattern(entry.data.url, options.urlPattern)
        ) {
          return false;
        }
        return true;
      },
    });
    if (options.unreadOnly && result.entries.length > 0) {
      this.#sseReadCursor = result.entries[result.entries.length - 1].seq;
    }
    return result;
  }

  pollNetworkAlerts(
    options: {
      kinds?: NetworkAlertKind[];
      categories?: NetworkAlertCategory[];
      urlPattern?: string;
      includeCanceled?: boolean;
      sinceSeq?: number;
      unreadOnly?: boolean;
      limit?: number;
    } = {},
  ): RingBufferQueryResult<NetworkAlertData> {
    const sinceSeq =
      options.sinceSeq ??
      (options.unreadOnly ? this.#alertReadCursor : undefined);
    const includeCanceled = options.includeCanceled ?? true;
    const result = this.#alerts.query({
      sinceSeq,
      limit: options.limit,
      filter: (entry: RingBufferEntry<NetworkAlertData>) => {
        if (options.kinds?.length && !options.kinds.includes(entry.data.kind)) {
          return false;
        }
        if (
          options.categories?.length &&
          !options.categories.includes(entry.data.category)
        ) {
          return false;
        }
        if (!includeCanceled && entry.data.canceled) {
          return false;
        }
        if (
          options.urlPattern &&
          !matchesUrlPattern(entry.data.url, options.urlPattern)
        ) {
          return false;
        }
        return true;
      },
    });
    if (options.unreadOnly && result.entries.length > 0) {
      this.#alertReadCursor = result.entries[result.entries.length - 1].seq;
    }
    return result;
  }

  async waitForNetworkResponse(
    options: WaitForNetworkResponseOptions,
  ): Promise<WaitForNetworkResponseResult> {
    if (this.#disposed) {
      throw new Error('Page collector has already been disposed.');
    }
    const startedAt = Date.now();
    const timeoutMs = options.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    const deadline = startedAt + timeoutMs;
    const expectedMethod = options.method?.toUpperCase();
    const allowedResourceTypes = options.resourceTypes?.length
      ? new Set(options.resourceTypes.map(t => t.toLowerCase()))
      : undefined;

    const matches = (response: HTTPResponse): boolean => {
      const url = response.url();
      options.urlRegex.lastIndex = 0;
      if (!options.urlRegex.test(url)) {
        return false;
      }
      if (
        options.status !== undefined &&
        response.status() !== options.status
      ) {
        return false;
      }
      const req = response.request();
      if (expectedMethod && req.method().toUpperCase() !== expectedMethod) {
        return false;
      }
      if (
        allowedResourceTypes &&
        !allowedResourceTypes.has(req.resourceType().toLowerCase())
      ) {
        return false;
      }
      return true;
    };

    let matchedResponse: HTTPResponse | undefined;
    if (options.includeRecentMs !== undefined && options.includeRecentMs > 0) {
      const cutoff = startedAt - options.includeRecentMs;
      for (let i = this.#recentResponses.length - 1; i >= 0; i--) {
        const entry = this.#recentResponses[i];
        if (entry.receivedAt < cutoff) {
          break;
        }
        if (matches(entry.response)) {
          matchedResponse = entry.response;
          break;
        }
      }
    }

    if (!matchedResponse) {
      matchedResponse = await new Promise<HTTPResponse>((resolve, reject) => {
        const waiter: PendingResponseWaiter = {
          options,
          match: matches,
          resolve: resp => {
            clearTimeout(timer);
            resolve(resp);
          },
          reject: err => {
            clearTimeout(timer);
            reject(err);
          },
        };
        const timer = setTimeout(() => {
          this.#responseWaiters.delete(waiter);
          reject(
            new Error(
              `Timed out after ${timeoutMs}ms waiting for network response matching ${options.urlRegex.source}` +
                `${expectedMethod ? ` method=${expectedMethod}` : ''}` +
                `${options.status !== undefined ? ` status=${options.status}` : ''}.`,
            ),
          );
        }, timeoutMs);
        timer.unref?.();
        this.#responseWaiters.add(waiter);
      });
    }

    const request = matchedResponse.request();
    const status = matchedResponse.status();
    const remainingMs = Math.max(1_000, deadline - Date.now());
    const rawHeaders = matchedResponse.headers();
    const headers = this.#redactNetworkHeaders()
      ? redactHeaders(rawHeaders)
      : rawHeaders;

    let bodyBuffer: Uint8Array | undefined;
    let bodyText: string | undefined;
    let isBinary = false;
    let bodyError: string | undefined;

    if (status === 204 || status === 304 || (status >= 300 && status < 400)) {
      bodyText = '';
      bodyBuffer = new Uint8Array(0);
    } else {
      const read = await this.#readResponseBodySafe(
        matchedResponse,
        remainingMs,
      );
      if (read.bodyBuffer) {
        bodyBuffer = read.bodyBuffer;
        if (isUtf8(read.bodyBuffer)) {
          bodyText = Buffer.from(read.bodyBuffer).toString('utf8');
        } else {
          isBinary = true;
          bodyText = `<binary data (${read.bodyBuffer.byteLength} bytes)>`;
        }
      } else {
        bodyError = read.bodyError;
        logger?.('Failed reading matched response body', bodyError);
      }
    }

    return {
      url: matchedResponse.url(),
      status,
      statusText: matchedResponse.statusText(),
      method: request.method(),
      resourceType: request.resourceType(),
      headers,
      bodyBuffer,
      bodyText,
      isBinary,
      bodyError,
      elapsedMs: Date.now() - startedAt,
    };
  }

  dispose(): void {
    this.#disposed = true;
    this.#detachPageListeners();
    this.#detachCdpListeners();
    for (const waiter of this.#responseWaiters) {
      waiter.reject(
        new Error('Stopped waiting for network response because page closed.'),
      );
    }
    this.#responseWaiters.clear();
    this.#recentResponses = [];
    this.#requestMeta.clear();
    this.#wsConnections.clear();
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
