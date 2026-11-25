/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';
import {compileRegex, getErrorMessage} from '../utils/errorHandling.js';

import {ToolCategory} from './categories.js';
import {
  definePageTool,
  defineTool,
  type PageToolFactory,
  type ToolFactory,
} from './ToolDefinition.js';

const DEFAULT_WAIT_RESPONSE_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_INLINE_CHARS = 16_384;

function optionalRegexSchema(
  description: string,
): zod.ZodOptional<zod.ZodString> {
  return zod
    .string()
    .superRefine((value, ctx) => {
      try {
        compileRegex(value);
      } catch (error) {
        ctx.addIssue({
          code: 'custom',
          message: getErrorMessage(error),
        });
      }
    })
    .optional()
    .describe(description);
}

export const listWebsocketConnections: PageToolFactory = definePageTool(() => ({
  name: 'list_websocket_connections',
  description:
    'List active and recently tracked WebSocket connections captured via CDP on the selected page.',
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  schema: {
    status: zod
      .enum(['connecting', 'open', 'closed', 'error'])
      .optional()
      .describe('Filter WebSocket connections by current status.'),
    urlPattern: zod
      .string()
      .optional()
      .describe(
        'Optional URL filter (wildcard substring or /regex/flags) to narrow connections.',
      ),
  },
  blockedByDialog: false,
  concurrency: 'none',
  verifyFilesSchema: {},
  handler: async (request, response) => {
    const connections = request.page.listWebSocketConnections({
      status: request.params.status,
      urlPattern: request.params.urlPattern,
    });
    if (connections.length === 0) {
      response.appendResponseLine('No WebSocket connections recorded.');
      return;
    }
    response.appendResponseLine(
      `WebSocket connections (${connections.length}):`,
    );
    for (const conn of connections) {
      const errorPart = conn.lastError ? ` error=${conn.lastError}` : '';
      response.appendResponseLine(
        `- [${conn.requestId}] ${conn.status.toUpperCase()} ${conn.url} ` +
          `(sent=${conn.framesSent}, recv=${conn.framesReceived}, errors=${conn.errorCount}${errorPart})`,
      );
    }
  },
}));

export const pollWsFrames: PageToolFactory = definePageTool(() => ({
  name: 'poll_ws_frames',
  description:
    'Poll captured WebSocket frames (sent/received/error) from the bounded CDP ring buffer on the selected page.',
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  schema: {
    requestId: zod
      .string()
      .optional()
      .describe('Filter frames by a specific WebSocket requestId.'),
    urlPattern: zod
      .string()
      .optional()
      .describe('Optional URL filter (wildcard substring or /regex/flags).'),
    direction: zod
      .enum(['sent', 'received', 'error', 'all'])
      .optional()
      .describe('Filter frames by direction. Defaults to "all".'),
    sinceSeq: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Return frames strictly after this sequence number.'),
    unreadOnly: zod
      .boolean()
      .optional()
      .describe(
        'When true, advance and read from the per-buffer unread cursor.',
      ),
    limit: zod
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe('Maximum number of frames to return (default: 50).'),
  },
  blockedByDialog: false,
  concurrency: 'page',
  verifyFilesSchema: {},
  handler: async (request, response) => {
    const result = request.page.pollWsFrames({
      requestId: request.params.requestId,
      urlPattern: request.params.urlPattern,
      direction: request.params.direction,
      sinceSeq: request.params.sinceSeq,
      unreadOnly: request.params.unreadOnly,
      limit: request.params.limit,
    });
    response.appendResponseLine(
      `WS frames: returned=${result.entries.length}, latestSeq=${result.latestSeq}, ` +
        `oldestSeq=${result.oldestSeq}, dropped=${result.droppedCount}`,
    );
    for (const entry of result.entries) {
      const frame = entry.data;
      const body = frame.errorMessage ?? frame.payload ?? '';
      const truncatedNote = frame.truncated ? ' [truncated]' : '';
      response.appendResponseLine(
        `#${entry.seq} [${frame.direction}] ${frame.requestId} ${frame.url} ` +
          `len=${frame.payloadLength}${truncatedNote}: ${body}`,
      );
    }
  },
}));

export const pollSseEvents: PageToolFactory = definePageTool(() => ({
  name: 'poll_sse_events',
  description:
    'Poll captured Server-Sent Events (EventSource messages) from the bounded CDP ring buffer on the selected page.',
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  schema: {
    requestId: zod
      .string()
      .optional()
      .describe('Filter SSE events by a specific CDP requestId.'),
    urlPattern: zod
      .string()
      .optional()
      .describe('Optional URL filter (wildcard substring or /regex/flags).'),
    eventName: zod
      .string()
      .optional()
      .describe('Filter by SSE eventName (e.g. "message", "update").'),
    sinceSeq: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Return events strictly after this sequence number.'),
    unreadOnly: zod
      .boolean()
      .optional()
      .describe(
        'When true, advance and read from the per-buffer unread cursor.',
      ),
    limit: zod
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe('Maximum number of SSE events to return (default: 50).'),
  },
  blockedByDialog: false,
  concurrency: 'page',
  verifyFilesSchema: {},
  handler: async (request, response) => {
    const result = request.page.pollSseEvents({
      requestId: request.params.requestId,
      urlPattern: request.params.urlPattern,
      eventName: request.params.eventName,
      sinceSeq: request.params.sinceSeq,
      unreadOnly: request.params.unreadOnly,
      limit: request.params.limit,
    });
    response.appendResponseLine(
      `SSE events: returned=${result.entries.length}, latestSeq=${result.latestSeq}, ` +
        `oldestSeq=${result.oldestSeq}, dropped=${result.droppedCount}`,
    );
    for (const entry of result.entries) {
      const evt = entry.data;
      const truncatedNote = evt.truncated ? ' [truncated]' : '';
      response.appendResponseLine(
        `#${entry.seq} [${evt.eventName}${evt.eventId ? ` id=${evt.eventId}` : ''}] ` +
          `${evt.requestId} ${evt.url} len=${evt.dataLength}${truncatedNote}: ${evt.data}`,
      );
    }
  },
}));

export const waitForNetworkResponse: PageToolFactory = definePageTool(() => ({
  name: 'wait_for_network_response',
  description:
    'Wait for an XHR/Fetch/network response matching urlRegex, method, and/or status, returning the body inline or saving large payloads to tmp/.',
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: false,
  },
  schema: {
    urlRegex: optionalRegexSchema(
      'Regular expression (raw or /pattern/flags) matched against the response URL. Defaults to matching all URLs.',
    ),
    method: zod
      .string()
      .optional()
      .describe('HTTP method filter (e.g. GET, POST). Case-insensitive.'),
    status: zod
      .number()
      .int()
      .min(100)
      .max(599)
      .optional()
      .describe('Expected HTTP status code (e.g. 200, 201, 404).'),
    resourceTypes: zod
      .array(zod.string().min(1))
      .optional()
      .describe('Optional resource types filter (e.g. ["xhr", "fetch"]).'),
    timeoutMs: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        `Timeout in milliseconds (default: ${DEFAULT_WAIT_RESPONSE_TIMEOUT_MS}).`,
      ),
    includeRecentMs: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Check recently received responses within this lookback window in ms before waiting for new traffic (default: 0).',
      ),
    filePath: zod
      .string()
      .optional()
      .describe(
        'Optional output file path (.json or .txt) inside an allowed root or tmp/ to save the full body.',
      ),
    saveToTempFile: zod
      .boolean()
      .optional()
      .describe(
        'Force writing the response body to a temporary file under tmp/ even when small.',
      ),
    maxInlineChars: zod
      .number()
      .int()
      .min(0)
      .max(200_000)
      .optional()
      .describe(
        `Maximum inline body characters before spilling to a tmp/ file (default: ${DEFAULT_MAX_INLINE_CHARS}).`,
      ),
  },
  blockedByDialog: false,
  concurrency: 'page',
  verifyFilesSchema: {
    filePath: true,
  },
  handler: async (request, response, context) => {
    const urlRegex = request.params.urlRegex
      ? compileRegex(request.params.urlRegex)
      : /.*/;
    const result = await request.page.waitForNetworkResponse({
      urlRegex,
      method: request.params.method,
      status: request.params.status,
      resourceTypes: request.params.resourceTypes,
      timeoutMs: request.params.timeoutMs ?? DEFAULT_WAIT_RESPONSE_TIMEOUT_MS,
      includeRecentMs: request.params.includeRecentMs,
    });

    const contentType = result.headers['content-type'] ?? 'unknown';
    response.appendResponseLine(
      `Matched ${result.method} ${result.status} ${result.statusText} ${result.url} ` +
        `(type=${result.resourceType}, contentType=${contentType}, elapsedMs=${result.elapsedMs})`,
    );

    if (result.bodyError) {
      response.appendResponseLine(`Response body error: ${result.bodyError}`);
      return;
    }

    const rawBytes =
      result.bodyBuffer ??
      (result.bodyText !== undefined
        ? Buffer.from(result.bodyText, 'utf8')
        : undefined);
    if (!rawBytes) {
      return;
    }

    const maxInlineChars =
      request.params.maxInlineChars ?? DEFAULT_MAX_INLINE_CHARS;

    if (request.params.filePath) {
      const ext = request.params.filePath.toLowerCase().endsWith('.json')
        ? '.json'
        : '.txt';
      const saved = await context.saveFile(
        rawBytes,
        request.params.filePath,
        ext,
      );
      response.appendResponseLine(
        `Saved full response body (${rawBytes.byteLength} bytes) to ${saved.filename}.`,
      );
      return;
    }

    const textLen = result.bodyText?.length ?? rawBytes.byteLength;
    if (
      request.params.saveToTempFile ||
      result.isBinary ||
      textLen > maxInlineChars
    ) {
      const ext = contentType.includes('json') ? 'json' : 'txt';
      const {filepath} = await context.saveTemporaryFile(
        rawBytes,
        `network-response-${Date.now()}.${ext}`,
      );
      response.appendResponseLine(
        `Saved response body (${rawBytes.byteLength} bytes${result.isBinary ? ', binary' : ''}) to ${filepath}.`,
      );
      if (!result.isBinary && result.bodyText && maxInlineChars > 0) {
        const previewLen = Math.min(
          result.bodyText.length,
          Math.min(maxInlineChars, 2000),
        );
        response.appendResponseLine(
          `Preview (${previewLen}/${result.bodyText.length} chars):\n${result.bodyText.slice(0, previewLen)}`,
        );
      }
      return;
    }

    response.appendResponseLine(`Response body:\n${result.bodyText ?? ''}`);
  },
}));

export const pollNetworkAlerts: PageToolFactory = definePageTool(() => ({
  name: 'poll_network_alerts',
  description:
    'Poll captured network failures (Network.loadingFailed), HTTP 4xx/5xx responses, and DevTools CORS/CSP/MixedContent audit issues (Audits.issueAdded).',
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  schema: {
    kinds: zod
      .array(zod.enum(['loading_failed', 'http_error', 'audit_issue']))
      .optional()
      .describe('Filter alerts by alert kind.'),
    categories: zod
      .array(
        zod.enum([
          'cors',
          'csp',
          'http_4xx',
          'http_5xx',
          'auth',
          'rate_limit',
          'loading_failed',
          'mixed_content',
          'blocked',
          'audit_issue',
        ]),
      )
      .optional()
      .describe('Filter alerts by category (e.g. cors, csp, http_4xx, auth).'),
    urlPattern: zod
      .string()
      .optional()
      .describe('Optional URL filter (wildcard substring or /regex/flags).'),
    includeCanceled: zod
      .boolean()
      .optional()
      .describe(
        'Include canceled Network.loadingFailed alerts (default: true).',
      ),
    sinceSeq: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Return alerts strictly after this sequence number.'),
    unreadOnly: zod
      .boolean()
      .optional()
      .describe(
        'When true, advance and read from the per-buffer unread cursor.',
      ),
    limit: zod
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe('Maximum number of alerts to return (default: 50).'),
  },
  blockedByDialog: false,
  concurrency: 'page',
  verifyFilesSchema: {},
  handler: async (request, response) => {
    const result = request.page.pollNetworkAlerts({
      kinds: request.params.kinds,
      categories: request.params.categories,
      urlPattern: request.params.urlPattern,
      includeCanceled: request.params.includeCanceled,
      sinceSeq: request.params.sinceSeq,
      unreadOnly: request.params.unreadOnly,
      limit: request.params.limit,
    });
    response.appendResponseLine(
      `Network alerts: returned=${result.entries.length}, latestSeq=${result.latestSeq}, ` +
        `oldestSeq=${result.oldestSeq}, dropped=${result.droppedCount}`,
    );
    for (const entry of result.entries) {
      const alert = entry.data;
      const statusPart =
        alert.status !== undefined ? ` status=${alert.status}` : '';
      const urlPart = alert.url ? ` ${alert.url}` : '';
      const details =
        alert.errorText ??
        alert.corsError ??
        alert.blockedReason ??
        alert.issueCode ??
        alert.statusText ??
        alert.detailsSummary?.join('; ') ??
        '';
      const detailPart = details ? ` — ${details}` : '';
      response.appendResponseLine(
        `#${entry.seq} [${alert.kind}/${alert.category}]${statusPart}${urlPart}${detailPart}`,
      );
    }
  },
}));

export const handleAuthChallenge: PageToolFactory = definePageTool(() => ({
  name: 'handle_auth_challenge',
  description:
    'Inspect, respond to, or configure runtime policy for HTTP 401/407 authentication challenges captured via CDP Fetch.authRequired.',
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: false,
  },
  schema: {
    action: zod
      .enum(['provide', 'cancel', 'default', 'list', 'set_policy'])
      .describe(
        'Action: provide credentials, cancel auth, use browser default, list pending/history, or set runtime default/rule policy.',
      ),
    challengeId: zod
      .string()
      .optional()
      .describe('Target challenge ID (defaults to oldest pending challenge).'),
    username: zod
      .string()
      .optional()
      .describe('Username for action="provide" or runtime provide rule.'),
    password: zod
      .string()
      .optional()
      .describe('Password for action="provide" or runtime provide rule.'),
    defaultAction: zod
      .enum(['cancel', 'default', 'queue'])
      .optional()
      .describe('Default runtime auth policy when action="set_policy".'),
    originRegex: optionalRegexSchema(
      'Optional regex matching auth origin when action="set_policy".',
    ),
    urlRegex: optionalRegexSchema(
      'Optional regex matching request URL when action="set_policy".',
    ),
    realmRegex: optionalRegexSchema(
      'Optional regex matching auth realm when action="set_policy".',
    ),
    source: zod
      .enum(['Server', 'Proxy'])
      .optional()
      .describe('Auth source filter when action="set_policy".'),
    queueTimeoutMs: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Timeout ms for queued challenges before auto-canceling.'),
  },
  blockedByDialog: false,
  concurrency: 'page',
  verifyFilesSchema: {},
  handler: async (request, response) => {
    const result = await request.page.handleAuthChallenge({
      action: request.params.action,
      challengeId: request.params.challengeId,
      username: request.params.username,
      password: request.params.password,
      defaultAction: request.params.defaultAction,
      originRegex: request.params.originRegex
        ? compileRegex(request.params.originRegex)
        : undefined,
      urlRegex: request.params.urlRegex
        ? compileRegex(request.params.urlRegex)
        : undefined,
      realmRegex: request.params.realmRegex
        ? compileRegex(request.params.realmRegex)
        : undefined,
      source: request.params.source,
      queueTimeoutMs: request.params.queueTimeoutMs,
    });

    if (result.resolved) {
      response.appendResponseLine(
        `Resolved auth challenge ${result.resolved.challengeId} ` +
          `(${result.resolved.status}) for ${result.resolved.url} ` +
          `[${result.resolved.source} ${result.resolved.scheme} realm="${result.resolved.realm}"].`,
      );
    } else if (result.action === 'set_policy') {
      response.appendResponseLine(
        `Updated runtime auth policy (defaultAction=${result.defaultAction}).`,
      );
    }

    response.appendResponseLine(
      `Auth state: pending=${result.pending.length}, history=${result.history.length}, defaultAction=${result.defaultAction}`,
    );
    for (const item of result.pending) {
      response.appendResponseLine(
        `- pending ${item.challengeId}: ${item.method} ${item.url} (${item.source} ${item.scheme} realm="${item.realm}")`,
      );
    }
    response.setIncludePages(true);
  },
}));

export const pollMonitorEvents: ToolFactory = defineTool(() => ({
  name: 'poll_monitor_events',
  description:
    'Inspect status and poll events matched by hot-reloaded ~/.config/cua-ycwang/network_monitors.json rules.',
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  schema: {
    monitorId: zod
      .string()
      .optional()
      .describe('Filter buffered events by monitor rule id.'),
    type: zod
      .enum(['xhr', 'fetch', 'ws', 'sse'])
      .optional()
      .describe('Filter buffered events by source type.'),
    urlPattern: zod
      .string()
      .optional()
      .describe('Optional URL filter (wildcard substring or /regex/flags).'),
    sinceSeq: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Return events strictly after this sequence number.'),
    limit: zod
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe('Maximum number of monitor events to return (default: 50).'),
    flush: zod
      .boolean()
      .optional()
      .describe('Flush pending JSONL file writes before returning results.'),
  },
  blockedByDialog: false,
  concurrency: 'exclusive',
  verifyFilesSchema: {},
  handler: async (request, response, context) => {
    const manager = context.getNetworkMonitorsManager();
    if (request.params.flush) {
      await manager.flush();
    }
    const status = manager.getStatus();
    const polled = manager.pollEvents({
      monitorId: request.params.monitorId,
      type: request.params.type,
      urlPattern: request.params.urlPattern,
      sinceSeq: request.params.sinceSeq,
      limit: request.params.limit,
    });
    response.appendResponseLine(
      `Network monitors: config=${status.configPath} (loaded=${status.loaded}, ` +
        `enabledMonitors=${status.monitorCount}, autoDialog=${status.hasAutoDialogPolicy}, ` +
        `autoAuth=${status.hasAutoAuthPolicy}${status.lastError ? `, lastError=${status.lastError}` : ''})`,
    );
    response.appendResponseLine(
      `Monitor events: returned=${polled.entries.length}, latestSeq=${polled.latestSeq}, ` +
        `oldestSeq=${polled.oldestSeq}, dropped=${polled.droppedCount}`,
    );
    for (const entry of polled.entries) {
      const ev = entry.data;
      const meta =
        ev.status !== undefined
          ? `status=${ev.status}`
          : ev.wsDirection
            ? `ws=${ev.wsDirection}`
            : ev.sseEventName
              ? `sse=${ev.sseEventName}`
              : '';
      const payload = ev.body ? ` body=${ev.body}` : '';
      response.appendResponseLine(
        `#${entry.seq} [${ev.monitorId}/${ev.type}] ${meta} ${ev.url}${payload}`,
      );
    }
  },
}));
