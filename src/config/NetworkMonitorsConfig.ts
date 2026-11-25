/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {zod} from '../third_party/index.js';
import {compileRegex, getErrorMessage} from '../utils/errorHandling.js';
import {resolveCanonicalPath} from '../utils/files.js';
import {escapeForLog, logger} from '../utils/logger.js';
import {RingBuffer, type RingBufferQueryResult} from '../utils/RingBuffer.js';
import {truncateUtf8Bytes} from '../utils/text.js';

import {NO_CONFIG_DISCOVERY_ENV} from './ConfigLocator.js';
import {ConfigWatcher} from './ConfigWatcher.js';

export type MonitorEventType = 'xhr' | 'fetch' | 'ws' | 'sse';
export type DialogPolicyAction = 'queue' | 'accept' | 'dismiss';
export type DialogTypeName = 'alert' | 'confirm' | 'prompt' | 'beforeunload';
export type AuthPolicyAction = 'provide' | 'cancel' | 'default' | 'queue';
export type AuthDefaultAction = 'cancel' | 'default' | 'queue';
export type WsDirectionFilter = 'sent' | 'received' | 'error' | 'all';

export interface NetworkMonitorRule {
  id: string;
  enabled: boolean;
  types: MonitorEventType[];
  urlRegex?: RegExp;
  urlPattern?: string;
  methods?: string[];
  statuses?: number[];
  wsDirection: WsDirectionFilter;
  eventNames?: string[];
  includeBody: boolean;
  maxBodyBytes: number;
  bufferEvents: boolean;
  jsonlPath?: string;
}

export interface AutoDialogRule {
  type?: DialogTypeName;
  urlRegex?: RegExp;
  messageRegex?: RegExp;
  action: DialogPolicyAction;
  promptText?: string;
}

export interface AutoDialogPolicy {
  defaultAction: DialogPolicyAction;
  alert?: DialogPolicyAction;
  confirm?: DialogPolicyAction;
  prompt?: {
    action: DialogPolicyAction;
    promptText?: string;
  };
  beforeunload?: DialogPolicyAction;
  rules: AutoDialogRule[];
}

export interface AutoAuthRule {
  originRegex?: RegExp;
  urlRegex?: RegExp;
  realmRegex?: RegExp;
  source?: 'Server' | 'Proxy';
  action: AuthPolicyAction;
  username?: string;
  password?: string;
  usernameEnv?: string;
  passwordEnv?: string;
}

export interface AutoAuthPolicy {
  defaultAction: AuthDefaultAction;
  queueTimeoutMs: number;
  rules: AutoAuthRule[];
}

export interface NetworkMonitorsConfig {
  monitors: NetworkMonitorRule[];
  autoDialogPolicy?: AutoDialogPolicy;
  autoAuthPolicy?: AutoAuthPolicy;
  interceptDownloads?: boolean;
  interceptFileChooser?: boolean;
}

export interface MonitorMatchedEvent {
  monitorId: string;
  type: MonitorEventType;
  url: string;
  timestamp: number;
  method?: string;
  status?: number;
  statusText?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  body?: string;
  bodyTruncated?: boolean;
  wsDirection?: 'sent' | 'received' | 'error';
  wsOpcode?: number;
  wsPayload?: string;
  wsError?: string;
  sseEventName?: string;
  sseEventId?: string;
  sseData?: string;
  requestId?: string;
}

export interface NetworkMonitorsStatus {
  configPath: string;
  loaded: boolean;
  monitorCount: number;
  bufferedCount: number;
  droppedCount: number;
  lastError?: string;
  hasAutoDialogPolicy: boolean;
  hasAutoAuthPolicy: boolean;
}

const DEFAULT_MAX_BODY_BYTES = 262_144;
const DEFAULT_MAX_MONITOR_BUFFER = 1_000;
const DEFAULT_AUTH_QUEUE_TIMEOUT_MS = 15_000;

export function getDefaultNetworkMonitorsPath(
  homedir: string = os.homedir(),
): string {
  return path.join(homedir, '.config', 'cua-ycwang', 'network_monitors.json');
}

const regexStringSchema = zod.string().superRefine((value, ctx) => {
  try {
    compileRegex(value);
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: `Invalid regex "${value}": ${getErrorMessage(error)}`,
    });
  }
});

const monitorTypeSchema = zod.enum(['xhr', 'fetch', 'ws', 'sse']);
const dialogActionSchema = zod.enum(['queue', 'accept', 'dismiss']);
const dialogTypeSchema = zod.enum([
  'alert',
  'confirm',
  'prompt',
  'beforeunload',
]);
const authActionSchema = zod.enum(['provide', 'cancel', 'default', 'queue']);
const authDefaultActionSchema = zod.enum(['cancel', 'default', 'queue']);

const rawPromptObjectSchema = zod.object({
  action: dialogActionSchema,
  promptText: zod.string().optional(),
  prompt_text: zod.string().optional(),
});

const rawAutoDialogRuleSchema = zod.object({
  type: dialogTypeSchema.optional(),
  urlRegex: regexStringSchema.optional(),
  url_regex: regexStringSchema.optional(),
  messageRegex: regexStringSchema.optional(),
  message_regex: regexStringSchema.optional(),
  action: dialogActionSchema,
  promptText: zod.string().optional(),
  prompt_text: zod.string().optional(),
});

const rawAutoDialogObjectSchema = zod.object({
  default: dialogActionSchema.optional(),
  defaultAction: dialogActionSchema.optional(),
  alert: dialogActionSchema.optional(),
  confirm: dialogActionSchema.optional(),
  prompt: zod
    .unknown()
    .transform(
      (
        val,
        ctx,
      ):
        | zod.output<typeof dialogActionSchema>
        | zod.output<typeof rawPromptObjectSchema> => {
        if (typeof val === 'string') {
          const parsed = dialogActionSchema.safeParse(val);
          if (parsed.success) {
            return parsed.data;
          }
          for (const issue of parsed.error.issues) {
            ctx.addIssue({
              code: 'custom',
              message: issue.message,
              path: issue.path,
            });
          }
          return zod.NEVER;
        }
        const parsed = rawPromptObjectSchema.safeParse(val);
        if (parsed.success) {
          return parsed.data;
        }
        for (const issue of parsed.error.issues) {
          ctx.addIssue({
            code: 'custom',
            message: issue.message,
            path: issue.path,
          });
        }
        return zod.NEVER;
      },
    )
    .optional(),
  beforeunload: dialogActionSchema.optional(),
  rules: zod.array(rawAutoDialogRuleSchema).optional(),
});

const rawAutoDialogPolicySchema = zod
  .unknown()
  .transform(
    (
      val,
      ctx,
    ): DialogPolicyAction | zod.output<typeof rawAutoDialogObjectSchema> => {
      if (typeof val === 'string') {
        const parsed = dialogActionSchema.safeParse(val);
        if (parsed.success) {
          return parsed.data;
        }
        for (const issue of parsed.error.issues) {
          ctx.addIssue({
            code: 'custom',
            message: issue.message,
            path: issue.path,
          });
        }
        return zod.NEVER;
      }
      const parsed = rawAutoDialogObjectSchema.safeParse(val);
      if (parsed.success) {
        return parsed.data;
      }
      for (const issue of parsed.error.issues) {
        ctx.addIssue({
          code: 'custom',
          message: issue.message,
          path: issue.path,
        });
      }
      return zod.NEVER;
    },
  );

const rawAutoAuthRuleSchema = zod.object({
  originRegex: regexStringSchema.optional(),
  origin_regex: regexStringSchema.optional(),
  urlRegex: regexStringSchema.optional(),
  url_regex: regexStringSchema.optional(),
  realmRegex: regexStringSchema.optional(),
  realm_regex: regexStringSchema.optional(),
  source: zod.enum(['Server', 'Proxy']).optional(),
  action: authActionSchema,
  username: zod.string().optional(),
  password: zod.string().optional(),
  usernameEnv: zod.string().optional(),
  username_env: zod.string().optional(),
  passwordEnv: zod.string().optional(),
  password_env: zod.string().optional(),
});

const rawAutoAuthObjectSchema = zod.object({
  default: authDefaultActionSchema.optional(),
  defaultAction: authDefaultActionSchema.optional(),
  queueTimeoutMs: zod.number().int().positive().max(300_000).optional(),
  queue_timeout_ms: zod.number().int().positive().max(300_000).optional(),
  rules: zod.array(rawAutoAuthRuleSchema).optional(),
});

const rawAutoAuthPolicySchema = zod
  .unknown()
  .transform(
    (
      val,
      ctx,
    ): AuthDefaultAction | zod.output<typeof rawAutoAuthObjectSchema> => {
      if (typeof val === 'string') {
        const parsed = authDefaultActionSchema.safeParse(val);
        if (parsed.success) {
          return parsed.data;
        }
        for (const issue of parsed.error.issues) {
          ctx.addIssue({
            code: 'custom',
            message: issue.message,
            path: issue.path,
          });
        }
        return zod.NEVER;
      }
      const parsed = rawAutoAuthObjectSchema.safeParse(val);
      if (parsed.success) {
        return parsed.data;
      }
      for (const issue of parsed.error.issues) {
        ctx.addIssue({
          code: 'custom',
          message: issue.message,
          path: issue.path,
        });
      }
      return zod.NEVER;
    },
  );

const rawMonitorRuleSchema = zod.object({
  id: zod.string().min(1).optional(),
  enabled: zod.boolean().optional(),
  types: zod.array(monitorTypeSchema).min(1).optional(),
  urlRegex: regexStringSchema.optional(),
  url_regex: regexStringSchema.optional(),
  urlPattern: zod.string().min(1).optional(),
  url_pattern: zod.string().min(1).optional(),
  methods: zod.array(zod.string().min(1)).optional(),
  statuses: zod.array(zod.number().int().min(100).max(599)).optional(),
  wsDirection: zod.enum(['sent', 'received', 'error', 'all']).optional(),
  ws_direction: zod.enum(['sent', 'received', 'error', 'all']).optional(),
  eventNames: zod.array(zod.string()).optional(),
  event_names: zod.array(zod.string()).optional(),
  includeBody: zod.boolean().optional(),
  include_body: zod.boolean().optional(),
  maxBodyBytes: zod.number().int().positive().max(10_485_760).optional(),
  max_body_bytes: zod.number().int().positive().max(10_485_760).optional(),
  bufferEvents: zod.boolean().optional(),
  buffer_events: zod.boolean().optional(),
  jsonlPath: zod.string().min(1).optional(),
  jsonl_path: zod.string().min(1).optional(),
});

const rawNetworkMonitorsFileSchema = zod.object({
  monitors: zod.array(rawMonitorRuleSchema).optional(),
  auto_dialog_policy: rawAutoDialogPolicySchema.optional(),
  autoDialogPolicy: rawAutoDialogPolicySchema.optional(),
  auto_auth_policy: rawAutoAuthPolicySchema.optional(),
  autoAuthPolicy: rawAutoAuthPolicySchema.optional(),
  intercept_downloads: zod.boolean().optional(),
  interceptDownloads: zod.boolean().optional(),
  intercept_file_chooser: zod.boolean().optional(),
  interceptFileChooser: zod.boolean().optional(),
});

function parseAutoDialogPolicy(
  raw: zod.output<typeof rawAutoDialogPolicySchema> | undefined,
): AutoDialogPolicy | undefined {
  if (!raw) {
    return undefined;
  }
  if (typeof raw === 'string') {
    return {
      defaultAction: raw,
      rules: [],
    };
  }
  let promptPolicy: AutoDialogPolicy['prompt'];
  if (typeof raw.prompt === 'string') {
    promptPolicy = {action: raw.prompt};
  } else if (raw.prompt) {
    promptPolicy = {
      action: raw.prompt.action,
      promptText: raw.prompt.promptText ?? raw.prompt.prompt_text,
    };
  }
  const rules: AutoDialogRule[] = [];
  for (const rule of raw.rules ?? []) {
    const urlPattern = rule.urlRegex ?? rule.url_regex;
    const messagePattern = rule.messageRegex ?? rule.message_regex;
    rules.push({
      type: rule.type,
      urlRegex: urlPattern ? compileRegex(urlPattern) : undefined,
      messageRegex: messagePattern ? compileRegex(messagePattern) : undefined,
      action: rule.action,
      promptText: rule.promptText ?? rule.prompt_text,
    });
  }
  return {
    defaultAction: raw.defaultAction ?? raw.default ?? 'queue',
    alert: raw.alert,
    confirm: raw.confirm,
    prompt: promptPolicy,
    beforeunload: raw.beforeunload,
    rules,
  };
}

function parseAutoAuthPolicy(
  raw: zod.output<typeof rawAutoAuthPolicySchema> | undefined,
): AutoAuthPolicy | undefined {
  if (!raw) {
    return undefined;
  }
  if (typeof raw === 'string') {
    return {
      defaultAction: raw,
      queueTimeoutMs: DEFAULT_AUTH_QUEUE_TIMEOUT_MS,
      rules: [],
    };
  }
  const rules: AutoAuthRule[] = [];
  for (const rule of raw.rules ?? []) {
    const originPattern = rule.originRegex ?? rule.origin_regex;
    const urlPattern = rule.urlRegex ?? rule.url_regex;
    const realmPattern = rule.realmRegex ?? rule.realm_regex;
    rules.push({
      originRegex: originPattern ? compileRegex(originPattern) : undefined,
      urlRegex: urlPattern ? compileRegex(urlPattern) : undefined,
      realmRegex: realmPattern ? compileRegex(realmPattern) : undefined,
      source: rule.source,
      action: rule.action,
      username: rule.username,
      password: rule.password,
      usernameEnv: rule.usernameEnv ?? rule.username_env,
      passwordEnv: rule.passwordEnv ?? rule.password_env,
    });
  }
  return {
    defaultAction: raw.defaultAction ?? raw.default ?? 'default',
    queueTimeoutMs:
      raw.queueTimeoutMs ??
      raw.queue_timeout_ms ??
      DEFAULT_AUTH_QUEUE_TIMEOUT_MS,
    rules,
  };
}

export function parseNetworkMonitorsConfig(
  content: string,
): NetworkMonitorsConfig {
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(content);
  } catch (error) {
    throw new Error(`Invalid JSON: ${getErrorMessage(error)}`, {cause: error});
  }
  const parsed = rawNetworkMonitorsFileSchema.parse(rawJson);
  const monitors: NetworkMonitorRule[] = [];
  const rawMonitors = parsed.monitors ?? [];
  for (let i = 0; i < rawMonitors.length; i++) {
    const item = rawMonitors[i];
    const urlRegexStr = item.urlRegex ?? item.url_regex;
    const urlPattern = item.urlPattern ?? item.url_pattern;
    const methods = item.methods?.map(m => m.toUpperCase());
    monitors.push({
      id: item.id ?? `monitor-${i + 1}`,
      enabled: item.enabled ?? true,
      types: item.types ?? ['xhr', 'fetch', 'ws', 'sse'],
      urlRegex: urlRegexStr ? compileRegex(urlRegexStr) : undefined,
      urlPattern,
      methods,
      statuses: item.statuses,
      wsDirection: item.wsDirection ?? item.ws_direction ?? 'all',
      eventNames: item.eventNames ?? item.event_names,
      includeBody: item.includeBody ?? item.include_body ?? true,
      maxBodyBytes:
        item.maxBodyBytes ?? item.max_body_bytes ?? DEFAULT_MAX_BODY_BYTES,
      bufferEvents: item.bufferEvents ?? item.buffer_events ?? true,
      jsonlPath: item.jsonlPath ?? item.jsonl_path,
    });
  }
  return {
    monitors,
    autoDialogPolicy: parseAutoDialogPolicy(
      parsed.autoDialogPolicy ?? parsed.auto_dialog_policy,
    ),
    autoAuthPolicy: parseAutoAuthPolicy(
      parsed.autoAuthPolicy ?? parsed.auto_auth_policy,
    ),
    interceptDownloads: parsed.interceptDownloads ?? parsed.intercept_downloads,
    interceptFileChooser:
      parsed.interceptFileChooser ?? parsed.intercept_file_chooser,
  };
}

export function matchesUrlPattern(url: string, pattern?: string): boolean {
  if (!pattern) {
    return true;
  }
  const trimmed = pattern.trim();
  if (!trimmed) {
    return true;
  }
  if (!trimmed.includes('*')) {
    return url.toLowerCase().includes(trimmed.toLowerCase());
  }
  const escaped = trimmed
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(escaped, 'i').test(url);
}

export function ruleMatchesUrl(rule: NetworkMonitorRule, url: string): boolean {
  if (rule.urlRegex) {
    rule.urlRegex.lastIndex = 0;
    if (!rule.urlRegex.test(url)) {
      return false;
    }
  }
  if (rule.urlPattern && !matchesUrlPattern(url, rule.urlPattern)) {
    return false;
  }
  return true;
}

function hasPathTraversalSegment(rawPath: string): boolean {
  if (rawPath.includes('\0')) {
    return true;
  }
  return rawPath.split(/[/\\]/).some(segment => segment === '..');
}

function hasInvalidTerminalSegment(rawPath: string): boolean {
  if (!rawPath || rawPath.endsWith('/') || rawPath.endsWith('\\')) {
    return true;
  }
  const segments = rawPath.split(/[/\\]/);
  const last = segments[segments.length - 1];
  return !last || last === '.' || last === '..';
}

function isWithinDirectory(candidatePath: string, baseDir: string): boolean {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedBase = path.resolve(baseDir);
  const prefix = resolvedBase.endsWith(path.sep)
    ? resolvedBase
    : resolvedBase + path.sep;
  return (
    resolvedCandidate === resolvedBase || resolvedCandidate.startsWith(prefix)
  );
}

export interface NetworkMonitorsManagerOptions {
  configPath?: string;
  skipDiscovery?: boolean;
  debounceMs?: number;
  maxBufferedEvents?: number;
  cwd?: string;
  tmpDir?: string;
  validatePath?: (filePath: string) => Promise<string>;
  getAllowedRoots?: () => string[];
}

/**
 * Hot-loads `~/.config/cua-ycwang/network_monitors.json` (or an explicit path),
 * evaluates `auto_dialog_policy` and `auto_auth_policy`, and buffers or
 * appends matched XHR/Fetch/WS/SSE events to validated `tmp/` JSONL files.
 */
export class NetworkMonitorsManager implements Disposable {
  readonly #configPath: string;
  readonly #skipDiscovery: boolean;
  readonly #debounceMs?: number;
  readonly #cwd: string;
  readonly #tmpDir: string;
  readonly #validatePath?: (filePath: string) => Promise<string>;
  readonly #getAllowedRoots?: () => string[];
  readonly #buffer: RingBuffer<MonitorMatchedEvent>;
  #config: NetworkMonitorsConfig = {monitors: []};
  #loaded = false;
  #lastError?: string;
  #watcher?: ConfigWatcher;
  #started = false;
  #disposed = false;
  #writeQueues = new Map<string, Promise<void>>();
  #configChangeListeners = new Set<() => void>();

  constructor(options: NetworkMonitorsManagerOptions = {}) {
    this.#configPath = options.configPath ?? getDefaultNetworkMonitorsPath();
    this.#skipDiscovery =
      options.skipDiscovery ??
      (options.configPath === undefined &&
        Boolean(process.env[NO_CONFIG_DISCOVERY_ENV]));
    this.#debounceMs = options.debounceMs;
    this.#cwd = options.cwd ?? process.cwd();
    this.#tmpDir = options.tmpDir ?? os.tmpdir();
    this.#validatePath = options.validatePath;
    this.#getAllowedRoots = options.getAllowedRoots;
    this.#buffer = new RingBuffer<MonitorMatchedEvent>(
      options.maxBufferedEvents ?? DEFAULT_MAX_MONITOR_BUFFER,
    );
  }

  onConfigChange(listener: () => void): () => void {
    this.#configChangeListeners.add(listener);
    return () => {
      this.#configChangeListeners.delete(listener);
    };
  }

  #notifyConfigChange(): void {
    for (const listener of Array.from(this.#configChangeListeners)) {
      try {
        listener();
      } catch (error) {
        logger?.(
          `NetworkMonitorsManager listener failed: ${getErrorMessage(error)}`,
        );
      }
    }
  }

  start(): void {
    if (this.#started || this.#disposed || this.#skipDiscovery) {
      return;
    }
    this.#started = true;
    this.#loadInitialSync();
    const watcher = new ConfigWatcher(
      this.#configPath,
      async content => {
        this.#applyContent(content);
      },
      {
        debounceMs: this.#debounceMs,
        allowMissing: true,
        onDelete: () => {
          this.#config = {monitors: []};
          this.#loaded = false;
          this.#lastError = undefined;
          logger?.(
            `Cleared monitor config after removal of ${this.#configPath}`,
          );
          this.#notifyConfigChange();
        },
      },
    );
    try {
      watcher.start();
      this.#watcher = watcher;
    } catch (error) {
      watcher.dispose();
      logger?.(
        `Failed to watch ${escapeForLog(this.#configPath)}: ${getErrorMessage(error)}`,
      );
    }
  }

  #loadInitialSync(): void {
    try {
      const content = fs.readFileSync(this.#configPath, 'utf8');
      this.#applyContent(content);
    } catch (error) {
      if (
        error &&
        typeof error === 'object' &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        this.#config = {monitors: []};
        this.#loaded = false;
        this.#lastError = undefined;
        return;
      }
      this.#lastError = getErrorMessage(error);
      logger?.(
        `Failed to read ${escapeForLog(this.#configPath)}: ${this.#lastError}`,
      );
    }
  }

  #applyContent(content: string): void {
    try {
      this.#config = parseNetworkMonitorsConfig(content);
      this.#loaded = true;
      this.#lastError = undefined;
      logger?.(
        `Loaded ${this.#config.monitors.length} network monitor rule(s) from ${escapeForLog(this.#configPath)}`,
      );
      this.#notifyConfigChange();
    } catch (error) {
      this.#lastError = getErrorMessage(error);
      logger?.(
        `Keeping previous monitor config; failed to parse ${escapeForLog(this.#configPath)}: ${this.#lastError}`,
      );
    }
  }

  getConfig(): NetworkMonitorsConfig {
    return this.#config;
  }

  getStatus(): NetworkMonitorsStatus {
    return {
      configPath: this.#configPath,
      loaded: this.#loaded,
      monitorCount: this.#config.monitors.filter(m => m.enabled).length,
      bufferedCount: this.#buffer.size,
      droppedCount: this.#buffer.droppedCount,
      lastError: this.#lastError,
      hasAutoDialogPolicy: this.#config.autoDialogPolicy !== undefined,
      hasAutoAuthPolicy: this.#config.autoAuthPolicy !== undefined,
    };
  }

  hasActiveMonitorFor(
    type: MonitorEventType,
    url: string,
    options: {
      method?: string;
      status?: number;
      wsDirection?: 'sent' | 'received' | 'error';
      sseEventName?: string;
    } = {},
  ): boolean {
    return this.matchingMonitorsFor(type, url, options).length > 0;
  }

  matchingMonitorsFor(
    type: MonitorEventType,
    url: string,
    options: {
      method?: string;
      status?: number;
      wsDirection?: 'sent' | 'received' | 'error';
      sseEventName?: string;
    } = {},
  ): NetworkMonitorRule[] {
    const matched: NetworkMonitorRule[] = [];
    for (const rule of this.#config.monitors) {
      if (!rule.enabled) {
        continue;
      }
      if (!rule.types.includes(type)) {
        continue;
      }
      if (!ruleMatchesUrl(rule, url)) {
        continue;
      }
      if (
        (type === 'xhr' || type === 'fetch') &&
        rule.methods?.length &&
        options.method &&
        !rule.methods.includes(options.method.toUpperCase())
      ) {
        continue;
      }
      if (
        (type === 'xhr' || type === 'fetch') &&
        rule.statuses?.length &&
        options.status !== undefined &&
        !rule.statuses.includes(options.status)
      ) {
        continue;
      }
      if (
        type === 'ws' &&
        rule.wsDirection !== 'all' &&
        options.wsDirection &&
        rule.wsDirection !== options.wsDirection
      ) {
        continue;
      }
      if (
        type === 'sse' &&
        rule.eventNames?.length &&
        options.sseEventName !== undefined &&
        !rule.eventNames.includes(options.sseEventName)
      ) {
        continue;
      }
      matched.push(rule);
    }
    return matched;
  }

  recordEvent(
    event: Omit<MonitorMatchedEvent, 'monitorId'>,
  ): NetworkMonitorRule[] {
    const matched = this.matchingMonitorsFor(event.type, event.url, {
      method: event.method,
      status: event.status,
      wsDirection: event.wsDirection,
      sseEventName: event.sseEventName,
    });
    for (const rule of matched) {
      const fullEvent: MonitorMatchedEvent = {
        ...event,
        monitorId: rule.id,
      };
      if (!rule.includeBody) {
        delete fullEvent.body;
        delete fullEvent.bodyTruncated;
        delete fullEvent.wsPayload;
        delete fullEvent.sseData;
      } else {
        for (const field of ['body', 'wsPayload', 'sseData'] as const) {
          const val = fullEvent[field];
          if (val !== undefined) {
            const truncated = truncateUtf8Bytes(val, rule.maxBodyBytes);
            fullEvent[field] = truncated.value;
            if (truncated.truncated) {
              fullEvent.bodyTruncated = true;
            }
          }
        }
      }
      if (rule.bufferEvents) {
        this.#buffer.push(fullEvent, event.timestamp);
      }
      if (rule.jsonlPath) {
        this.#enqueueJsonlWrite(rule.jsonlPath, fullEvent);
      }
    }
    return matched;
  }

  pollEvents(
    options: {
      monitorId?: string;
      type?: MonitorEventType;
      urlPattern?: string;
      sinceSeq?: number;
      limit?: number;
    } = {},
  ): RingBufferQueryResult<MonitorMatchedEvent> {
    return this.#buffer.query({
      sinceSeq: options.sinceSeq,
      limit: options.limit,
      filter: entry => {
        if (options.monitorId && entry.data.monitorId !== options.monitorId) {
          return false;
        }
        if (options.type && entry.data.type !== options.type) {
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
  }

  resolveDialogAction(info: {
    type: DialogTypeName;
    message: string;
    url: string;
    defaultValue?: string;
  }): {action: DialogPolicyAction; promptText?: string} {
    const policy = this.#config.autoDialogPolicy;
    if (!policy) {
      return {action: 'queue'};
    }
    for (const rule of policy.rules) {
      if (rule.type && rule.type !== info.type) {
        continue;
      }
      if (rule.urlRegex) {
        rule.urlRegex.lastIndex = 0;
        if (!rule.urlRegex.test(info.url)) {
          continue;
        }
      }
      if (rule.messageRegex) {
        rule.messageRegex.lastIndex = 0;
        if (!rule.messageRegex.test(info.message)) {
          continue;
        }
      }
      return {
        action: rule.action,
        promptText: rule.promptText ?? info.defaultValue,
      };
    }
    if (info.type === 'prompt' && policy.prompt) {
      return {
        action: policy.prompt.action,
        promptText: policy.prompt.promptText ?? info.defaultValue,
      };
    }
    const typeAction =
      info.type === 'alert'
        ? policy.alert
        : info.type === 'confirm'
          ? policy.confirm
          : info.type === 'beforeunload'
            ? policy.beforeunload
            : undefined;
    return {
      action: typeAction ?? policy.defaultAction,
      promptText: info.defaultValue,
    };
  }

  resolveAuthAction(info: {
    url: string;
    origin: string;
    realm: string;
    source: string;
  }): {
    action: AuthPolicyAction;
    username?: string;
    password?: string;
    queueTimeoutMs: number;
  } {
    const policy = this.#config.autoAuthPolicy;
    if (!policy) {
      return {
        action: 'default',
        queueTimeoutMs: DEFAULT_AUTH_QUEUE_TIMEOUT_MS,
      };
    }
    for (const rule of policy.rules) {
      if (rule.source && rule.source !== info.source) {
        continue;
      }
      if (rule.originRegex) {
        rule.originRegex.lastIndex = 0;
        if (!rule.originRegex.test(info.origin)) {
          continue;
        }
      }
      if (rule.urlRegex) {
        rule.urlRegex.lastIndex = 0;
        if (!rule.urlRegex.test(info.url)) {
          continue;
        }
      }
      if (rule.realmRegex) {
        rule.realmRegex.lastIndex = 0;
        if (!rule.realmRegex.test(info.realm)) {
          continue;
        }
      }
      const username = rule.usernameEnv
        ? process.env[rule.usernameEnv]
        : rule.username;
      const password = rule.passwordEnv
        ? process.env[rule.passwordEnv]
        : rule.password;
      return {
        action: rule.action,
        username,
        password,
        queueTimeoutMs: policy.queueTimeoutMs,
      };
    }
    return {
      action: policy.defaultAction,
      queueTimeoutMs: policy.queueTimeoutMs,
    };
  }

  async #getCanonicalAllowedDirs(): Promise<string[]> {
    const dirs: string[] = [];
    const canonicalTmp = await resolveCanonicalPath(this.#tmpDir);
    dirs.push(canonicalTmp);

    const cwdTmpDir = path.resolve(this.#cwd, 'tmp');
    try {
      const canonicalCwd = await resolveCanonicalPath(this.#cwd);
      const canonicalCwdTmp = await resolveCanonicalPath(cwdTmpDir);
      if (
        isWithinDirectory(canonicalCwdTmp, canonicalCwd) ||
        isWithinDirectory(canonicalCwdTmp, canonicalTmp)
      ) {
        dirs.push(canonicalCwdTmp);
      }
    } catch {
      // Ignore unresolvable cwd/tmp.
    }

    if (this.#getAllowedRoots) {
      for (const rootDir of this.#getAllowedRoots()) {
        try {
          dirs.push(await fsPromises.realpath(path.resolve(rootDir)));
        } catch {
          // Skip unresolvable root.
        }
      }
    }
    return dirs;
  }

  async #assertCanonicalParentAllowed(
    realParentDir: string,
    fileName: string,
    rawPath: string,
  ): Promise<string> {
    const enforceAllowedDirs =
      !this.#validatePath || Boolean(this.#getAllowedRoots);
    if (enforceAllowedDirs) {
      const allowedDirs = await this.#getCanonicalAllowedDirs();
      const withinAllowed = allowedDirs.some(dir =>
        isWithinDirectory(realParentDir, dir),
      );
      if (!withinAllowed) {
        throw new Error(
          `Monitor jsonlPath "${escapeForLog(rawPath)}" must reside under tmp/ or an allowed workspace root.`,
        );
      }
    }

    const candidate = path.join(realParentDir, fileName);
    if (this.#validatePath) {
      return await this.#validatePath(candidate);
    }
    return candidate;
  }

  async resolveJsonlPath(rawPath: string): Promise<string> {
    if (!rawPath || hasPathTraversalSegment(rawPath)) {
      throw new Error(
        `Invalid monitor jsonlPath "${escapeForLog(rawPath)}": path traversal is not allowed.`,
      );
    }
    if (hasInvalidTerminalSegment(rawPath)) {
      throw new Error(
        `Invalid monitor jsonlPath "${escapeForLog(rawPath)}": must name a file inside tmp/.`,
      );
    }

    const normalizedSlashes = rawPath.replaceAll('\\', '/');
    if (path.isAbsolute(rawPath)) {
      const canonicalTarget = await resolveCanonicalPath(rawPath);
      return await this.#assertCanonicalParentAllowed(
        path.dirname(canonicalTarget),
        path.basename(canonicalTarget),
        rawPath,
      );
    }

    const strippedTmpPrefix = normalizedSlashes.startsWith('tmp/')
      ? normalizedSlashes.slice('tmp/'.length)
      : normalizedSlashes;
    if (!strippedTmpPrefix || strippedTmpPrefix === '.') {
      throw new Error(
        `Invalid monitor jsonlPath "${escapeForLog(rawPath)}": must name a file inside tmp/.`,
      );
    }

    const tmpFallback = path.resolve(
      this.#tmpDir,
      'chrome-devtools-mcp-monitors',
      strippedTmpPrefix,
    );

    if (normalizedSlashes.startsWith('tmp/')) {
      const cwdCandidate = path.resolve(this.#cwd, normalizedSlashes);
      const canonicalCwd = await resolveCanonicalPath(this.#cwd);
      const canonicalTmp = await resolveCanonicalPath(this.#tmpDir);
      const canonicalCwdTmp = await resolveCanonicalPath(
        path.resolve(this.#cwd, 'tmp'),
      );
      const cwdTmpIsSafe =
        isWithinDirectory(canonicalCwdTmp, canonicalCwd) ||
        isWithinDirectory(canonicalCwdTmp, canonicalTmp);
      const canonicalCwdCandidate = await resolveCanonicalPath(cwdCandidate);
      if (
        !cwdTmpIsSafe ||
        !isWithinDirectory(path.dirname(canonicalCwdCandidate), canonicalCwdTmp)
      ) {
        throw new Error(
          `Monitor jsonlPath "${escapeForLog(rawPath)}" must reside under tmp/ or an allowed workspace root.`,
        );
      }
      try {
        return await this.#assertCanonicalParentAllowed(
          path.dirname(canonicalCwdCandidate),
          path.basename(canonicalCwdCandidate),
          rawPath,
        );
      } catch (error) {
        if (!this.#validatePath) {
          throw error;
        }
        const canonicalFallback = await resolveCanonicalPath(tmpFallback);
        return await this.#assertCanonicalParentAllowed(
          path.dirname(canonicalFallback),
          path.basename(canonicalFallback),
          rawPath,
        );
      }
    }

    const canonicalFallback = await resolveCanonicalPath(tmpFallback);
    return await this.#assertCanonicalParentAllowed(
      path.dirname(canonicalFallback),
      path.basename(canonicalFallback),
      rawPath,
    );
  }

  #enqueueJsonlWrite(rawPath: string, event: MonitorMatchedEvent): void {
    if (this.#disposed) {
      return;
    }
    const previous = this.#writeQueues.get(rawPath) ?? Promise.resolve();
    const next: Promise<void> = previous
      .then(async () => {
        if (this.#disposed) {
          return;
        }
        const targetPath = await this.resolveJsonlPath(rawPath);
        const parentDir = path.dirname(targetPath);
        await fsPromises.mkdir(parentDir, {recursive: true});
        const realParentDir = await fsPromises.realpath(parentDir);
        await this.#assertCanonicalParentAllowed(
          realParentDir,
          path.basename(targetPath),
          rawPath,
        );
        const safeTargetPath = path.join(
          realParentDir,
          path.basename(targetPath),
        );
        if (this.#disposed) {
          return;
        }
        const handle = await fsPromises.open(
          safeTargetPath,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_APPEND |
            fs.constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await handle.writeFile(`${JSON.stringify(event)}\n`, 'utf8');
        } finally {
          await handle.close();
        }
      })
      .catch(error => {
        logger?.(
          `Failed to write monitor event to ${escapeForLog(rawPath)}: ${getErrorMessage(error)}`,
        );
      })
      .finally(() => {
        if (this.#writeQueues.get(rawPath) === next) {
          this.#writeQueues.delete(rawPath);
        }
      });
    this.#writeQueues.set(rawPath, next);
  }

  async flush(): Promise<void> {
    await Promise.allSettled(Array.from(this.#writeQueues.values()));
  }

  get pendingWriteCount(): number {
    return this.#writeQueues.size;
  }

  dispose(): void {
    this.#disposed = true;
    this.#configChangeListeners.clear();
    this.#watcher?.dispose();
    this.#watcher = undefined;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
