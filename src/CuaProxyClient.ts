/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  execSync,
  spawn,
  type ChildProcessWithoutNullStreams,
} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import {logger} from './utils/logger.js';
import {raceWithSignal} from './utils/raceWithSignal.js';
import {validateWsEndpoint} from './utils/url.js';
import {VERSION} from './version.js';

const DEFAULT_POLL_INTERVAL_MS = 250;
const DEFAULT_LAUNCH_WAIT_TIMEOUT_MS = 15_000;
const SHUTDOWN_WAIT_MS = 500;
const MAX_STDERR_LINES = 20;

export type ChromeChannel = 'canary' | 'dev' | 'beta' | 'stable';

export interface CuaProxyClientOptions {
  cuaCommand?: string;
  pollIntervalMs?: number;
  launchWaitTimeoutMs?: number;
}

export interface AcquireCuaWsEndpointOptions {
  forceRefresh?: boolean;
  staleWsEndpoint?: string;
  channel?: ChromeChannel;
  signal: AbortSignal;
}

interface ChromeWindow {
  pid: number;
  windowId: number;
  isOnScreen: boolean;
  zIndex: number | null;
}

interface PendingRpc {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

class CuaToolRefusalError extends Error {
  readonly code?: string;

  constructor(message: string, code?: string) {
    super(message);
    this.name = 'CuaToolRefusalError';
    this.code = code;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function chromeAppName(channel?: ChromeChannel): string {
  switch (channel) {
    case 'beta':
      return 'google-chrome-beta';
    case 'dev':
      return 'google-chrome-unstable';
    case 'canary':
      return 'google-chrome-canary';
    default:
      return 'google-chrome';
  }
}

export function resolveCuaCommand(configured?: string): string {
  const trimmed = configured?.trim();
  if (trimmed) {
    return trimmed;
  }
  const exeName =
    process.platform === 'win32' ? 'cua-ycwang.exe' : 'cua-ycwang';
  const localCandidate = path.join(os.homedir(), '.local', 'bin', exeName);
  if (fs.existsSync(localCandidate)) {
    return localCandidate;
  }
  return exeName;
}

function detectLinuxProcessEnvVar(name: string): string | undefined {
  try {
    const result = execSync(
      `ps -u $(id -u) -o pid= | xargs -I{} cat /proc/{}/environ 2>/dev/null | tr '\\0' '\\n' | grep -m1 '^${name}=' | cut -d= -f2-`,
    );
    const value = result.toString('utf8').trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

function buildCuaChildEnv(hasCustomCommand: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {...process.env};
  if (
    hasCustomCommand ||
    os.platform() === 'win32' ||
    os.platform() === 'darwin'
  ) {
    return env;
  }
  if (!env['DISPLAY']) {
    const display = detectLinuxProcessEnvVar('DISPLAY');
    if (display) {
      env['DISPLAY'] = display;
    }
  }
  if (!env['XAUTHORITY']) {
    const xauth = detectLinuxProcessEnvVar('XAUTHORITY');
    if (xauth) {
      env['XAUTHORITY'] = xauth;
    }
  }
  if (!env['DBUS_SESSION_BUS_ADDRESS']) {
    const uid = process.getuid?.();
    if (uid !== undefined) {
      const busPath = `/run/user/${uid}/bus`;
      if (fs.existsSync(busPath)) {
        env['DBUS_SESSION_BUS_ADDRESS'] = `unix:path=${busPath}`;
      }
    }
  }
  return env;
}

function pickChromeWindow(windowsRaw: unknown): ChromeWindow | undefined {
  if (!Array.isArray(windowsRaw)) {
    return undefined;
  }
  const candidates: ChromeWindow[] = [];
  for (const item of windowsRaw) {
    if (!isPlainObject(item)) {
      continue;
    }
    const pid = item['pid'];
    const windowId = item['window_id'];
    if (
      typeof pid !== 'number' ||
      !Number.isInteger(pid) ||
      pid <= 0 ||
      typeof windowId !== 'number' ||
      !Number.isInteger(windowId) ||
      windowId < 0
    ) {
      continue;
    }
    const isOnScreen = item['is_on_screen'] !== false;
    const rawZ = item['z_index'];
    const zIndex =
      typeof rawZ === 'number' && Number.isFinite(rawZ) ? rawZ : null;
    candidates.push({pid, windowId, isOnScreen, zIndex});
  }
  if (candidates.length === 0) {
    return undefined;
  }
  candidates.sort((a, b) => {
    if (a.isOnScreen !== b.isOnScreen) {
      return a.isOnScreen ? -1 : 1;
    }
    if (a.zIndex !== null && b.zIndex !== null && a.zIndex !== b.zIndex) {
      return b.zIndex - a.zIndex;
    }
    if (a.zIndex !== null && b.zIndex === null) {
      return -1;
    }
    if (a.zIndex === null && b.zIndex !== null) {
      return 1;
    }
    return 0;
  });
  return candidates[0];
}

function extractTextFromContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: string[] = [];
  for (const item of content) {
    if (
      isPlainObject(item) &&
      item['type'] === 'text' &&
      typeof item['text'] === 'string'
    ) {
      parts.push(item['text']);
    }
  }
  return parts.join('\n');
}

function extractWsEndpointFromToolResult(
  result: Record<string, unknown>,
): string | undefined {
  const structured = result['structuredContent'];
  if (isPlainObject(structured)) {
    const endpoint = structured['ws_endpoint'];
    if (typeof endpoint === 'string' && endpoint.trim()) {
      return validateWsEndpoint(endpoint.trim());
    }
  }
  const text = extractTextFromContent(result['content']);
  const match = text.match(/\bws_endpoint:\s*(wss?:\/\/\S+)/i);
  if (match?.[1]) {
    return validateWsEndpoint(match[1].trim());
  }
  return undefined;
}

function abortErrorFromSignal(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Connection attempt was abandoned before it completed.');
}

async function sleepWithSignal(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) {
    throw abortErrorFromSignal(signal);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const delay = new Promise<void>(resolve => {
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
  try {
    await raceWithSignal(delay, signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Manages a long-lived `cua-ycwang mcp --grant existing-profile` stdio child
 * process so the Rust `BrowserEngine` keeps its `SharedSocket` and loopback
 * `cdp_proxy` alive across Puppeteer connects/reconnects until
 * `chrome-devtools-mcp` exits.
 */
export class CuaProxyClient {
  #options: CuaProxyClientOptions;
  #child?: ChildProcessWithoutNullStreams;
  #rl?: readline.Interface;
  #stderrRl?: readline.Interface;
  #readyPromise?: Promise<void>;
  #nextId = 1;
  #pending = new Map<number, PendingRpc>();
  #stderrTail: string[] = [];
  #sessionCounter = 1;
  #sessionId = 'cua-proxy-1';
  #cachedWsEndpoint?: string;
  #closed = false;

  constructor(options: CuaProxyClientOptions = {}) {
    this.#options = options;
  }

  get activeSessionId(): string {
    return this.#sessionId;
  }

  invalidateEndpoint(): void {
    this.#cachedWsEndpoint = undefined;
  }

  #rotateSession(): string {
    this.#sessionCounter++;
    this.#sessionId = `cua-proxy-${this.#sessionCounter}`;
    this.#cachedWsEndpoint = undefined;
    return this.#sessionId;
  }

  #isChildAlive(): boolean {
    return Boolean(
      this.#child &&
      this.#child.exitCode === null &&
      this.#child.signalCode === null &&
      !this.#child.killed,
    );
  }

  #resetChildState(reason: Error): void {
    this.#readyPromise = undefined;
    this.#cachedWsEndpoint = undefined;
    this.#rl?.close();
    this.#rl = undefined;
    this.#stderrRl?.close();
    this.#stderrRl = undefined;
    this.#child = undefined;
    const pending = Array.from(this.#pending.values());
    this.#pending.clear();
    for (const entry of pending) {
      entry.reject(reason);
    }
  }

  #terminateChildSync(child: ChildProcessWithoutNullStreams): void {
    try {
      child.stdin.end();
    } catch {
      // Ignore already-closed stdin.
    }
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore already-exited child.
      }
    }
  }

  #abortHungChild(): void {
    const child = this.#child;
    this.#resetChildState(
      new Error('cua-ycwang connection attempt was abandoned.'),
    );
    if (child) {
      this.#terminateChildSync(child);
    }
  }

  async #ensureInitialized(signal: AbortSignal): Promise<void> {
    if (this.#closed) {
      throw new Error('CuaProxyClient has been closed.');
    }
    if (signal.aborted) {
      throw abortErrorFromSignal(signal);
    }
    if (this.#readyPromise && this.#isChildAlive()) {
      await raceWithSignal(this.#readyPromise, signal);
      return;
    }
    const initPromise = this.#spawnAndInitialize();
    this.#readyPromise = initPromise;
    try {
      await raceWithSignal(initPromise, signal);
    } catch (err) {
      if (this.#readyPromise === initPromise) {
        this.#readyPromise = undefined;
      }
      throw err;
    }
  }

  async #spawnAndInitialize(): Promise<void> {
    const hasCustomCommand = Boolean(this.#options.cuaCommand?.trim());
    const command = resolveCuaCommand(this.#options.cuaCommand);
    const env = buildCuaChildEnv(hasCustomCommand);

    logger?.(`Starting cua-ycwang stdio proxy host: ${command}`);
    this.#stderrTail = [];
    const child = spawn(command, ['mcp', '--grant', 'existing-profile'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    this.#child = child;

    child.stdin.on('error', err => {
      logger?.('cua-ycwang stdin error', err);
    });

    const stderrRl = readline.createInterface({
      input: child.stderr,
      crlfDelay: Infinity,
    });
    this.#stderrRl = stderrRl;
    stderrRl.on('line', line => {
      if (this.#stderrTail.length >= MAX_STDERR_LINES) {
        this.#stderrTail.shift();
      }
      this.#stderrTail.push(line);
      logger?.('[cua-ycwang stderr]', line);
    });

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    this.#rl = rl;
    rl.on('line', line => {
      this.#handleStdoutLine(line);
    });

    const onDisconnect = (detail: string): void => {
      if (this.#child !== child) {
        return;
      }
      const stderrSummary =
        this.#stderrTail.length > 0
          ? ` (stderr: ${this.#stderrTail.join(' | ')})`
          : '';
      this.#resetChildState(
        new Error(
          `cua-ycwang process ${detail}${stderrSummary}. Check that cua-ycwang is installed and accessible.`,
        ),
      );
    };

    child.once('error', err => {
      onDisconnect(`failed to start (${command}): ${err.message}`);
    });
    child.once('exit', (code, sig) => {
      const status =
        sig !== null
          ? `terminated by signal ${sig}`
          : `exited with code ${code}`;
      onDisconnect(status);
    });

    await this.#sendRequestOn(child, 'initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: {
        name: 'chrome-devtools-mcp',
        version: VERSION,
      },
    });
    this.#sendNotificationOn(child, 'notifications/initialized');
  }

  #handleStdoutLine(rawLine: string): void {
    const trimmed = rawLine.trim();
    if (!trimmed) {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch (err) {
      logger?.('Failed to parse JSON-RPC line from cua-ycwang:', trimmed, err);
      return;
    }
    if (!isPlainObject(parsed)) {
      return;
    }
    const id = parsed['id'];
    if (typeof id !== 'number') {
      return;
    }
    const pending = this.#pending.get(id);
    if (!pending) {
      return;
    }
    this.#pending.delete(id);
    const error = parsed['error'];
    if (isPlainObject(error)) {
      const message =
        typeof error['message'] === 'string'
          ? error['message']
          : JSON.stringify(error);
      const code =
        typeof error['code'] === 'number' ? String(error['code']) : undefined;
      pending.reject(new CuaToolRefusalError(message, code));
      return;
    }
    pending.resolve(parsed['result']);
  }

  #sendNotificationOn(
    child: ChildProcessWithoutNullStreams,
    method: string,
    params?: Record<string, unknown>,
  ): void {
    if (this.#child !== child || !child.stdin.writable) {
      return;
    }
    const payload = params
      ? {jsonrpc: '2.0', method, params}
      : {jsonrpc: '2.0', method};
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  async #sendRequestOn(
    child: ChildProcessWithoutNullStreams,
    method: string,
    params: Record<string, unknown>,
  ): Promise<unknown> {
    if (this.#child !== child || !this.#isChildAlive()) {
      throw new Error('cua-ycwang process is not running.');
    }
    const id = this.#nextId++;
    const payload = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };
    return await new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, {resolve, reject});
      try {
        child.stdin.write(`${JSON.stringify(payload)}\n`, err => {
          if (err && this.#pending.has(id)) {
            this.#pending.delete(id);
            reject(
              new Error(`Failed writing to cua-ycwang stdin: ${err.message}`),
            );
          }
        });
      } catch (err) {
        this.#pending.delete(id);
        reject(
          err instanceof Error
            ? err
            : new Error(`Failed writing to cua-ycwang stdin: ${String(err)}`),
        );
      }
    });
  }

  async #callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    await this.#ensureInitialized(signal);
    const child = this.#child;
    if (!child) {
      throw new Error('cua-ycwang process is not running.');
    }
    const rawResult = await raceWithSignal(
      this.#sendRequestOn(child, 'tools/call', {
        name,
        arguments: args,
      }),
      signal,
    );
    if (!isPlainObject(rawResult)) {
      throw new Error(`Unexpected response from cua-ycwang tool "${name}".`);
    }
    const structured = isPlainObject(rawResult['structuredContent'])
      ? rawResult['structuredContent']
      : undefined;
    const isError = rawResult['isError'] === true;
    const isRefused = structured?.['status'] === 'refused';
    if (isError || isRefused) {
      const refusal = isPlainObject(structured?.['refusal'])
        ? structured['refusal']
        : undefined;
      const code =
        (typeof refusal?.['code'] === 'string' ? refusal['code'] : undefined) ??
        (typeof structured?.['code'] === 'string'
          ? structured['code']
          : undefined);
      const message =
        (typeof refusal?.['message'] === 'string'
          ? refusal['message']
          : undefined) ??
        (extractTextFromContent(rawResult['content']) ||
          `cua-ycwang tool "${name}" failed.`);
      throw new CuaToolRefusalError(message, code);
    }
    return rawResult;
  }

  async #findChromeWindow(
    signal: AbortSignal,
  ): Promise<ChromeWindow | undefined> {
    const result = await this.#callTool(
      'list_windows',
      {app: 'chrome'},
      signal,
    );
    const structured = isPlainObject(result['structuredContent'])
      ? result['structuredContent']
      : undefined;
    return pickChromeWindow(structured?.['windows']);
  }

  async #launchChromeAndWait(
    channel: ChromeChannel | undefined,
    signal: AbortSignal,
  ): Promise<ChromeWindow> {
    const appName = chromeAppName(channel);
    logger?.(`No running Chrome window found; launching ${appName} via cua`);
    const launchResult = await this.#callTool(
      'launch_app',
      {name: appName},
      signal,
    );
    const launchStructured = isPlainObject(launchResult['structuredContent'])
      ? launchResult['structuredContent']
      : undefined;
    const immediateWindow = pickChromeWindow(launchStructured?.['windows']);
    if (immediateWindow) {
      return immediateWindow;
    }

    const pollIntervalMs =
      this.#options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const waitTimeoutMs =
      this.#options.launchWaitTimeoutMs ?? DEFAULT_LAUNCH_WAIT_TIMEOUT_MS;
    const deadline = Date.now() + waitTimeoutMs;
    while (Date.now() < deadline) {
      await sleepWithSignal(pollIntervalMs, signal);
      const found = await this.#findChromeWindow(signal);
      if (found) {
        return found;
      }
    }
    throw new Error(
      `Launched ${appName} via cua-ycwang, but no Chrome window appeared within ${waitTimeoutMs}ms.`,
    );
  }

  async #prepareExistingProfile(
    win: ChromeWindow,
    signal: AbortSignal,
  ): Promise<string> {
    const result = await this.#callTool(
      'browser_prepare',
      {
        pid: win.pid,
        window_id: win.windowId,
        strategy: {kind: 'existing_profile'},
        session: this.#sessionId,
      },
      signal,
    );
    const wsEndpoint = extractWsEndpointFromToolResult(result);
    if (!wsEndpoint) {
      throw new Error(
        'cua-ycwang browser_prepare succeeded but did not return a valid ws_endpoint.',
      );
    }
    return wsEndpoint;
  }

  /**
   * Obtains a restricted loopback `ws_endpoint` for the user's running Chrome
   * profile, launching Chrome if no window is currently open.
   */
  async acquireWsEndpoint(
    options: AcquireCuaWsEndpointOptions,
  ): Promise<string> {
    const {signal} = options;
    if (signal.aborted) {
      throw abortErrorFromSignal(signal);
    }
    if (
      !options.forceRefresh &&
      this.#cachedWsEndpoint &&
      this.#isChildAlive()
    ) {
      return this.#cachedWsEndpoint;
    }
    if (options.forceRefresh) {
      this.#cachedWsEndpoint = undefined;
    }

    const onAbort = (): void => {
      this.#abortHungChild();
    };
    signal.addEventListener('abort', onAbort, {once: true});
    try {
      let win = await this.#findChromeWindow(signal);
      if (!win) {
        win = await this.#launchChromeAndWait(options.channel, signal);
      }

      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          let wsEndpoint = await this.#prepareExistingProfile(win, signal);
          if (
            options.staleWsEndpoint &&
            wsEndpoint === options.staleWsEndpoint
          ) {
            this.#rotateSession();
            wsEndpoint = await this.#prepareExistingProfile(win, signal);
          }
          this.#cachedWsEndpoint = wsEndpoint;
          return wsEndpoint;
        } catch (err) {
          if (signal.aborted) {
            throw err;
          }
          if (err instanceof CuaToolRefusalError) {
            if (
              err.code === 'session_ended' ||
              err.message.includes('has ended')
            ) {
              this.#rotateSession();
              continue;
            }
            if (
              err.code === 'browser_binding_stale' ||
              err.code === 'browser_wrong_target_refused'
            ) {
              win =
                (await this.#findChromeWindow(signal)) ??
                (await this.#launchChromeAndWait(options.channel, signal));
              continue;
            }
            if (
              err.code === 'browser_consent_required' ||
              err.message.includes('browser_consent_required')
            ) {
              this.#rotateSession();
              throw new CuaToolRefusalError(
                `Existing-profile authorization is required or expired for Chrome (pid=${win.pid}, window_id=${win.windowId}; 30m idle / 8h absolute TTL): ${err.message}. ` +
                  `Approve the "Allow remote debugging?" dialog via cua-ycwang:approve_browser_consent(pid=${win.pid}, window_id=${win.windowId}, wait_ms=15000) and retry.`,
                'browser_consent_required',
              );
            }
          }
          throw err;
        }
      }
      throw new Error(
        'Failed to obtain existing_profile ws_endpoint from cua-ycwang after retries.',
      );
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    const child = this.#child;
    this.#resetChildState(new Error('CuaProxyClient closed.'));
    if (!child) {
      return;
    }
    const exited = new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
    });
    try {
      child.stdin.end();
    } catch {
      // Ignore already-closed stdin.
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>(resolve => {
      timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGTERM');
          } catch {
            // Ignore exit race.
          }
        }
        resolve();
      }, SHUTDOWN_WAIT_MS);
      timer.unref?.();
    });
    await Promise.race([exited, timeout]);
    clearTimeout(timer);
    if (child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGKILL');
      } catch {
        // Ignore exit race.
      }
    }
  }
}
