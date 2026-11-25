/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {execSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type {ReadonlyServerConfig} from './config/ServerConfig.js';
import type {
  Browser,
  ChromeReleaseChannel,
  ConnectionTransport,
  ConnectOptions,
  LaunchOptions,
  NodeWebSocketTransportOptions,
  PuppeteerNode,
} from './third_party/browser.js';
import {loadBrowser, Mutex} from './third_party/index.js';
import {devToolsActivePortPermissionError} from './utils/errorHandling.js';
import {
  logger,
  puppeteerLogger,
  redactConnectOptionsForLogging,
} from './utils/logger.js';
import {isAllowedUrl} from './utils/url.js';

export interface BrowserManagerOptions {
  logFile?: fs.WriteStream;
}

export interface AbortableTransportHandle {
  transport: ConnectionTransport;
  terminate: () => void;
}

export const connectTransport = {
  async create(
    url: string,
    headers: Record<string, string> | undefined,
    logger: NonNullable<ConnectOptions['logger']>,
    options: NodeWebSocketTransportOptions,
    signal: AbortSignal,
  ): Promise<AbortableTransportHandle> {
    if (signal.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('Connection attempt was abandoned before it completed.');
    }
    const {
      NodeWebSocket,
      NodeWebSocketTransport,
      DEFAULT_MAX_PAYLOAD_BYTES,
      puppeteerPackageVersion,
    } = await loadBrowser();
    if (signal.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('Connection attempt was abandoned before it completed.');
    }
    return await new Promise<AbortableTransportHandle>((resolve, reject) => {
      const ws = new NodeWebSocket(url, [], {
        followRedirects: true,
        perMessageDeflate: false,
        allowSynchronousEvents: false,
        maxPayload: options.maxPayload ?? DEFAULT_MAX_PAYLOAD_BYTES,
        handshakeTimeout: options.handshakeTimeout,
        headers: {
          'User-Agent': `Puppeteer ${puppeteerPackageVersion}`,
          ...headers,
        },
      });

      const cleanup = (): void => {
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        signal.removeEventListener('abort', onAbort);
      };

      const onOpen = (): void => {
        cleanup();
        const transport = new NodeWebSocketTransport(ws, logger, options);
        resolve({
          transport,
          terminate: () => {
            transport.close();
            ws.terminate();
          },
        });
      };

      const onError = (err: unknown): void => {
        cleanup();
        reject(err);
      };

      const onAbort = (): void => {
        cleanup();
        // ws.terminate() during CONNECTING emits an 'error' event; swallow it
        // so Node does not crash with an unhandled 'error' event.
        ws.on('error', () => {});
        ws.terminate();
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error(
                'Connection attempt was abandoned before it completed.',
              ),
        );
      };

      ws.addEventListener('open', onOpen);
      ws.addEventListener('error', onError);
      signal.addEventListener('abort', onAbort, {once: true});
    });
  },
};

/**
 * Identity token for an in-flight connect/launch attempt. Instances carry no
 * data and are never inspected structurally — only ever compared by
 * reference (`!==`) — see BrowserManager#abandonPendingAttempt().
 */
class BrowserAttempt {}

/**
 * Loads Puppeteer and stops it from following symlinks when it reads or
 * writes files, before each launch or connect.
 */
async function loadPuppeteer(): Promise<PuppeteerNode> {
  const {puppeteer} = await loadBrowser();
  puppeteer.setFollowSymlinks(false);
  return puppeteer;
}

export class BrowserManager {
  #browser?: Browser;
  #browserMode?: 'launched' | 'connected';
  #initPromise?: Promise<Browser>;
  #mutex = new Mutex();
  #closingCount = 0;
  #config: ReadonlyServerConfig;
  #options: BrowserManagerOptions;

  #browserAttempt: BrowserAttempt = new BrowserAttempt();
  #connectAbortController?: AbortController;

  constructor(
    config: ReadonlyServerConfig,
    options: BrowserManagerOptions = {},
  ) {
    this.#config = config;
    this.#options = options;
  }

  static makeTargetFilter(enableExtensions = false) {
    return function targetFilter(target: {url(): string}): boolean {
      const url = target.url();
      if (!url) {
        return true;
      }
      return isAllowedUrl(url, {categoryExtensions: enableExtensions});
    };
  }

  static detectDisplay(): void {
    // Only detect display on Linux/UNIX.
    if (os.platform() === 'win32' || os.platform() === 'darwin') {
      return;
    }
    if (!process.env['DISPLAY']) {
      try {
        const result = execSync(
          `ps -u $(id -u) -o pid= | xargs -I{} cat /proc/{}/environ 2>/dev/null | tr '\\0' '\\n' | grep -m1 '^DISPLAY=' | cut -d= -f2`,
        );
        const display = result.toString('utf8').trim();
        process.env['DISPLAY'] = display;
      } catch {
        // no-op
      }
    }
  }

  /**
   * Chrome refuses to start as root unless the sandbox is explicitly disabled and
   * only says so on its stderr. Because we launch with `pipe: true`, Puppeteer
   * never surfaces that stderr and the failure reaches the client as an opaque
   * `Protocol error (Target.setDiscoverTargets): Target closed`. Detect the
   * situation and explain the way out instead. See https://crbug.com/638180.
   *
   * Returns `undefined` when the failure cannot be explained by running as root,
   * including on platforms without uids and when the sandbox was already disabled
   * through `--chrome-arg` (in which case root is not what stopped Chrome).
   */
  static rootSandboxLaunchError(
    error: Error,
    args: readonly string[],
    uid: number | undefined = process.getuid?.(),
  ): Error | undefined {
    if (uid !== 0) {
      return undefined;
    }
    if (
      args.some(
        arg => arg === '--no-sandbox' || arg.startsWith('--no-sandbox='),
      )
    ) {
      return undefined;
    }
    return new Error(
      `Chrome failed to start: ${error.message}\n\n` +
        'chrome-devtools-mcp is running as root and Chrome does not start as root ' +
        '(https://crbug.com/638180). Run chrome-devtools-mcp as a non-root user; in a ' +
        'container, create an unprivileged user in the image and switch to it with ' +
        "USER. For the setup that Chrome's sandbox needs, see " +
        'https://pptr.dev/troubleshooting#setting-up-chrome-linux-sandbox.',
      {
        cause: error,
      },
    );
  }

  /**
   * Puppeteer reports a headed launch without a display as "Missing X server"
   * and suggests its own `headless` option, which users of this server cannot
   * set directly. Point them to the `--headless` flag instead.
   *
   * Returns `undefined` for headless launches and for unrelated failures.
   */
  static missingDisplayLaunchError(
    error: Error,
    headless: boolean,
  ): Error | undefined {
    if (headless || !error.message.includes('Missing X server')) {
      return undefined;
    }
    return new Error(
      `Chrome failed to start: ${error.message}\n\n` +
        'No X server is available to show a headed Chrome window. Start ' +
        'chrome-devtools-mcp with --headless, set DISPLAY to a running X ' +
        'server, or run chrome-devtools-mcp under xvfb-run.',
      {
        cause: error,
      },
    );
  }

  async ensureBrowser(): Promise<Browser> {
    if (this.#initPromise) {
      return await this.#initPromise;
    }
    const initPromise = this.#ensureBrowserLocked();
    this.#initPromise = initPromise;
    try {
      return await initPromise;
    } finally {
      if (this.#initPromise === initPromise) {
        this.#initPromise = undefined;
      }
    }
  }

  async #ensureBrowserLocked(): Promise<Browser> {
    if (this.#closingCount > 0) {
      throw new Error('Browser was closed while initializing.');
    }
    // Captured before acquiring #mutex, not after: a caller queued here can
    // have its own timeout fire (abandonPendingAttempt()) while it's still
    // waiting for the lock. Capturing only after acquiring it would let such
    // a call silently adopt the freshly-rotated token as its own baseline
    // once the lock frees up, defeating the abandonment check entirely.
    const attempt = this.#browserAttempt;
    using guard = await this.#mutex.acquire();
    if (this.#closingCount > 0) {
      throw new Error('Browser was closed while initializing.');
    }
    if (this.#browserAttempt !== attempt) {
      // Abandoned while queued for the lock — #browser was never touched by
      // this call, so bail immediately without #closeBrowser(), which could
      // otherwise tear down a different, still-current attempt's browser.
      throw new Error('Connection attempt was abandoned before it completed.');
    }
    if (!this.#browser?.connected) {
      await this.#initBrowser();
    }
    if (
      this.#closingCount > 0 ||
      this.#browserAttempt !== attempt ||
      !this.#browser
    ) {
      const reason =
        this.#closingCount > 0
          ? 'Browser was closed while initializing.'
          : 'Connection attempt was abandoned before it completed.';
      await this.#closeBrowser();
      throw new Error(reason);
    }
    return this.#browser;
  }

  /**
   * Signals that whoever was waiting on the in-flight ensureBrowser() call
   * has given up (e.g. a tool-call timeout). There's no way to cancel a
   * pending connect()/launch(), so this doesn't stop it — it rotates the
   * token to a fresh value and clears #initPromise, so a late-resolving
   * attempt gets discarded by #ensureBrowserLocked() instead of silently
   * installed for a caller who already walked away.
   *
   * Also forgets the cached #browser, if any. This only ever fires from a
   * getContext()-level timeout, which covers both ensureBrowser() and the
   * McpContext initialization built on it — if ensureBrowser() already
   * resolved and it's that later step hanging (e.g. a dead CDP transport),
   * the token rotation alone does nothing, since #browser is already
   * cached. Safe to forget unconditionally here: a tool call that already
   * received a Browser keeps using it, so forgetting the cached value only
   * makes the next ensureBrowser() reconnect.
   */
  abandonPendingAttempt(): void {
    this.#browserAttempt = new BrowserAttempt();
    this.#initPromise = undefined;
    this.#connectAbortController?.abort(
      new Error('Connection attempt was abandoned before it completed.'),
    );
    this.#connectAbortController = undefined;
    this.#forgetCurrentBrowser();
  }

  async #initBrowser(): Promise<Browser> {
    if (
      this.#config.resolved.browserUrl ||
      this.#config.resolved.wsEndpoint ||
      this.#config.resolved.autoConnect
    ) {
      return await this.#connect();
    }
    return await this.#launch();
  }

  async #launch(): Promise<Browser> {
    const {
      channel,
      executablePath,
      headless,
      isolated = false,
      categoryExtensions: enableExtensions,
      viaCli,
      viewport,
      acceptInsecureCerts,
      experimentalDevtools: devtools = false,
      blockedUrlPattern: blocklist,
      allowedUrlPattern: allowlist,
      ignoreDefaultChromeArg,
      proxyServer,
    } = this.#config.resolved;

    const profileDirName =
      channel && channel !== 'stable'
        ? `chrome-profile-${channel}`
        : 'chrome-profile';

    let userDataDir = this.#config.resolved.userDataDir;
    if (!isolated && !userDataDir) {
      userDataDir = path.join(
        os.homedir(),
        '.cache',
        viaCli ? 'chrome-devtools-mcp-cli' : 'chrome-devtools-mcp',
        profileDirName,
      );
      await fs.promises.mkdir(userDataDir, {
        recursive: true,
      });
    }

    const args: LaunchOptions['args'] = [
      ...(this.#config.resolved.chromeArg ?? []),
    ];
    if (proxyServer) {
      args.push(`--proxy-server=${proxyServer}`);
    }
    args.push('--hide-crash-restore-bubble');

    const ignoreDefaultArgs: LaunchOptions['ignoreDefaultArgs'] =
      ignoreDefaultChromeArg ?? false;

    if (headless) {
      args.push('--screen-info={3840x2160}');
    }
    let puppeteerChannel: ChromeReleaseChannel | undefined;
    if (devtools) {
      args.push('--auto-open-devtools-for-tabs');
    }
    if (!executablePath) {
      puppeteerChannel =
        channel && channel !== 'stable' ? `chrome-${channel}` : 'chrome';
    }

    if (!headless) {
      BrowserManager.detectDisplay();
    }

    const puppeteer = await loadPuppeteer();
    let browser: Browser | undefined;
    try {
      browser = await puppeteer.launch({
        channel: puppeteerChannel,
        targetFilter: BrowserManager.makeTargetFilter(enableExtensions),
        executablePath,
        defaultViewport: null,
        userDataDir,
        pipe: true,
        headless,
        args,
        ignoreDefaultArgs,
        acceptInsecureCerts,
        handleDevToolsAsPage: true,
        enableExtensions,
        blocklist,
        allowlist,
        logger: puppeteerLogger,
        // The entry points own signal handling and call close(), which
        // closes the browser gracefully. Puppeteer's handlers would SIGKILL
        // Chrome synchronously on the same signal and win the race.
        handleSIGINT: false,
        handleSIGTERM: false,
        handleSIGHUP: false,
      });
      if (this.#options.logFile) {
        // FIXME: we are probably subscribing too late to catch startup logs. We
        // should expose the process earlier or expose the getRecentLogs() getter.
        browser.process()?.stderr?.pipe(this.#options.logFile);
        browser.process()?.stdout?.pipe(this.#options.logFile);
      }
      if (viewport) {
        const [page] = await browser.pages();
        await page?.resize({
          contentWidth: viewport.width,
          contentHeight: viewport.height,
        });
      }
      this.#browserMode = 'launched';
      this.#browser = browser;
      const launched = browser;
      launched.once('disconnected', () => this.#evictIfCurrent(launched));
      return launched;
    } catch (error) {
      await browser?.close().catch(() => {
        // Best-effort cleanup if post-launch setup failed.
      });
      if (
        userDataDir &&
        error instanceof Error &&
        error.message.includes('The browser is already running')
      ) {
        throw new Error(
          `The browser is already running for ${userDataDir}. Use --isolated to run multiple browser instances.`,
          {
            cause: error,
          },
        );
      }
      if (error instanceof Error) {
        const rootError = BrowserManager.rootSandboxLaunchError(error, args);
        if (rootError) {
          throw rootError;
        }
        const displayError = BrowserManager.missingDisplayLaunchError(
          error,
          headless,
        );
        if (displayError) {
          throw displayError;
        }
      }
      throw error;
    }
  }

  async #readDevToolsActivePort(
    activePortDir: string,
    customUserDataDir?: string,
    channelName?: string,
  ): Promise<string> {
    const portPath = path.join(activePortDir, 'DevToolsActivePort');
    try {
      const fileContent = await fs.promises.readFile(portPath, 'utf8');
      const [rawPort, rawPath] = fileContent
        .split('\n')
        .map(line => {
          return line.trim();
        })
        .filter(line => {
          return !!line;
        });
      if (!rawPort || !rawPath) {
        throw new Error(`Invalid DevToolsActivePort '${fileContent}' found`);
      }
      const port = parseInt(rawPort, 10);
      if (isNaN(port) || port <= 0 || port > 65535) {
        throw new Error(`Invalid port '${rawPort}' found`);
      }
      const host = customUserDataDir ? '127.0.0.1' : 'localhost';
      return `ws://${host}:${port}${rawPath}`;
    } catch (error) {
      if (customUserDataDir !== undefined) {
        const permissionError = devToolsActivePortPermissionError(
          error,
          customUserDataDir,
        );
        if (permissionError) {
          throw permissionError;
        }
        throw new Error(
          `Could not connect to Chrome in ${customUserDataDir}. Check if Chrome is running and remote debugging is enabled by going to chrome://inspect/#remote-debugging.`,
          {
            cause: error,
          },
        );
      }
      if (
        error instanceof Error &&
        'code' in error &&
        (error.code === 'EPERM' || error.code === 'EACCES')
      ) {
        const wrapped = new Error(
          `Could not read DevToolsActivePort for ${channelName} at ${portPath}: permission denied`,
          {cause: error},
        );
        const permissionError = devToolsActivePortPermissionError(wrapped);
        if (permissionError) {
          throw permissionError;
        }
      }
      throw new Error(
        `Could not connect to Chrome. Check if Chrome is running and remote debugging is enabled by going to chrome://inspect/#remote-debugging.`,
        {
          cause: error,
        },
      );
    }
  }

  async #fetchWSEndpoint(
    browserURL: string,
    headers: Record<string, string> | undefined,
    signal: AbortSignal,
  ): Promise<string> {
    const endpointURL = new URL(browserURL);
    endpointURL.pathname =
      endpointURL.pathname.replace(/\/?$/, '') + '/json/version';
    endpointURL.hash = '';
    const urlString = endpointURL.toString();
    try {
      const result = await globalThis.fetch(urlString, {
        method: 'GET',
        headers,
        signal,
      });
      if (!result.ok) {
        throw new Error(`HTTP ${result.statusText}`);
      }
      const data = (await result.json()) as {webSocketDebuggerUrl: string};
      return data.webSocketDebuggerUrl;
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      if (error instanceof Error) {
        error.message =
          `Failed to fetch browser webSocket URL from ${urlString}: ` +
          error.message;
      }
      throw error;
    }
  }

  async #connect(): Promise<Browser> {
    const {
      browserUrl: browserURL,
      wsEndpoint,
      wsHeaders,
      autoConnect: isAutoConnect,
      userDataDir,
      blockedUrlPattern: blocklist,
      allowedUrlPattern: allowlist,
      categoryExtensions: enableExtensions,
    } = this.#config.resolved;
    // Important: only pass channel, if autoConnect is true.
    const channel = isAutoConnect ? this.#config.resolved.channel : undefined;

    const connectOptions: ConnectOptions = {
      targetFilter: BrowserManager.makeTargetFilter(enableExtensions),
      defaultViewport: null,
      handleDevToolsAsPage: true,
      blocklist,
      allowlist,
      logger: puppeteerLogger,
    };

    const autoConnect = !wsEndpoint && !browserURL && !!(channel || userDataDir);
    if (!wsEndpoint && !browserURL && !autoConnect) {
      throw new Error(
        'Either browserURL, wsEndpoint, channel or userDataDir must be provided',
      );
    }

    const abortController = new AbortController();
    this.#connectAbortController = abortController;
    const {signal} = abortController;

    logger?.(
      'Connecting Puppeteer to ',
      JSON.stringify(
        redactConnectOptionsForLogging({
          ...connectOptions,
          ...(wsEndpoint ? {browserWSEndpoint: wsEndpoint} : {}),
          ...(browserURL ? {browserURL} : {}),
          ...(channel ? {channel} : {}),
          ...(wsHeaders ? {headers: wsHeaders} : {}),
        }),
      ),
    );

    const pendingHandshakeWarningMs = 5_000;
    const pendingHandshakeTimer = autoConnect
      ? setTimeout(() => {
          const message =
            'Puppeteer autoConnect handshake is still pending after 5s; Chrome may be waiting on the "Allow remote debugging?" native prompt.';
          logger?.(message);
          console.warn(message);
        }, pendingHandshakeWarningMs)
      : undefined;
    pendingHandshakeTimer?.unref?.();

    let handle: AbortableTransportHandle | undefined;
    const onAbortDuringConnect = (): void => {
      handle?.terminate();
    };
    signal.addEventListener('abort', onAbortDuringConnect, {once: true});

    try {
      const puppeteer = await loadPuppeteer();
      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error('Connection attempt was abandoned before it completed.');
      }

      let resolvedWsEndpoint: string;
      if (wsEndpoint) {
        resolvedWsEndpoint = wsEndpoint;
      } else if (browserURL) {
        resolvedWsEndpoint = await this.#fetchWSEndpoint(
          browserURL,
          wsHeaders,
          signal,
        );
      } else if (userDataDir) {
        resolvedWsEndpoint = await this.#readDevToolsActivePort(
          userDataDir,
          userDataDir,
        );
      } else {
        if (!channel) {
          throw new Error('Channel must be provided if userDataDir is missing');
        }
        const {
          detectBrowserPlatform,
          resolveDefaultUserDataDir,
          BrowserEnum,
          convertPuppeteerChannelToBrowsersChannel,
        } = await loadBrowser();
        const platform = detectBrowserPlatform();
        if (!platform) {
          throw new Error('Could not detect required browser platform');
        }
        const puppeteerChannel: ChromeReleaseChannel =
          channel === 'stable' ? 'chrome' : `chrome-${channel}`;
        const defaultUserDataDir = resolveDefaultUserDataDir(
          BrowserEnum.CHROME,
          platform,
          convertPuppeteerChannelToBrowsersChannel(puppeteerChannel),
        );
        resolvedWsEndpoint = await this.#readDevToolsActivePort(
          defaultUserDataDir,
          undefined,
          puppeteerChannel,
        );
      }

      if (signal.aborted) {
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error('Connection attempt was abandoned before it completed.');
      }

      handle = await connectTransport.create(
        resolvedWsEndpoint,
        wsHeaders,
        puppeteerLogger,
        {keepAlive: true},
        signal,
      );
      if (signal.aborted) {
        handle.terminate();
        throw signal.reason instanceof Error
          ? signal.reason
          : new Error('Connection attempt was abandoned before it completed.');
      }

      const connected = await puppeteer.connect({
        ...connectOptions,
        transport: handle.transport,
      });
      logger?.('Connected Puppeteer');
      this.#browserMode = 'connected';
      this.#browser = connected;
      connected.once('disconnected', () => this.#evictIfCurrent(connected));
      return connected;
    } catch (err) {
      handle?.terminate();
      if (signal.aborted) {
        throw err;
      }
      if (
        err instanceof Error &&
        err.message.startsWith('Could not connect to Chrome')
      ) {
        throw err;
      }
      const permissionError = devToolsActivePortPermissionError(err);
      if (permissionError) {
        throw permissionError;
      }
      throw new Error(
        `Could not connect to Chrome. ${autoConnect ? `Check if Chrome is running and remote debugging is enabled by going to chrome://inspect/#remote-debugging.` : `Check if Chrome is running.`}`,
        {
          cause: err,
        },
      );
    } finally {
      signal.removeEventListener('abort', onAbortDuringConnect);
      if (this.#connectAbortController === abortController) {
        this.#connectAbortController = undefined;
      }
      if (pendingHandshakeTimer !== undefined) {
        clearTimeout(pendingHandshakeTimer);
      }
    }
  }

  /**
   * Drops the cached browser handle so the next ensureBrowser() call
   * establishes a fresh connection. Only called from abandonPendingAttempt()
   * when a getContext()-level timeout fires after ensureBrowser() already
   * resolved, which means the handle looks connected but its CDP
   * initialization is hanging.
   *
   * Also tears the browser down in the background: closes it if it was
   * launched (so the Chrome subprocess doesn't leak), or disconnects if it
   * was only connected to (so the transport and its listeners don't leak).
   * Puppeteer's connection disposal rejects any in-flight CDP call, so a hung
   * call settles instead of leaking forever.
   */
  #forgetCurrentBrowser(): void {
    const browser = this.#browser;
    if (!browser) {
      return;
    }
    const mode = this.#browserMode;
    this.#browser = undefined;
    this.#browserMode = undefined;
    if (mode === 'launched') {
      void this.#closeLaunchedBrowser(browser);
    } else {
      void browser.disconnect().catch(err => {
        logger?.('Failed to disconnect forgotten browser', err);
      });
    }
  }

  /**
   * Handles a `disconnected` event fired by a browser we hold: clears the
   * cached handle if it's still the current one, so the next ensureBrowser()
   * call reconnects proactively rather than only discovering the staleness
   * lazily on the next call's `!this.#browser?.connected` check. No teardown
   * here — the browser is already disconnected/closed, that's why this
   * fired. The identity guard makes a `disconnected` that fires late on an
   * already-superseded browser a safe no-op.
   */
  #evictIfCurrent(candidate: Browser): void {
    if (this.#browser !== candidate) {
      return;
    }
    this.#browser = undefined;
    this.#browserMode = undefined;
  }

  async #closeLaunchedBrowser(browser: Browser): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        browser.close(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Timed out closing browser')),
            5_000,
          );
          timer.unref?.();
        }),
      ]);
    } catch (err) {
      logger?.('Failed to close browser', err);
      browser.process()?.kill('SIGKILL');
    } finally {
      clearTimeout(timer);
    }
  }

  async #closeBrowser(): Promise<void> {
    const browser = this.#browser;
    const mode = this.#browserMode;
    this.#browser = undefined;
    this.#browserMode = undefined;
    if (!browser || !browser.connected) {
      return;
    }
    if (mode === 'launched') {
      await this.#closeLaunchedBrowser(browser);
      return;
    }
    await browser.disconnect().catch(err => {
      logger?.('Failed to disconnect from browser', err);
    });
  }

  /**
   * Shutdown hook for the active browser. Closes a launched browser (so the
   * Chrome subprocess is reaped) or disconnects from an attached browser (so
   * the user's Chrome instance stays alive). No-op if no browser is active or
   * the connection has already been dropped.
   */
  async close(): Promise<void> {
    this.#initPromise = undefined;
    this.#closingCount++;
    this.#connectAbortController?.abort(
      new Error('Browser was closed while initializing.'),
    );
    this.#connectAbortController = undefined;
    using guard = await this.#mutex.acquire();
    try {
      await this.#closeBrowser();
    } finally {
      this.#closingCount--;
    }
  }

  [Symbol.dispose](): void {
    this.close().catch(err => {
      logger?.('Failed to dispose BrowserManager', err);
    });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }
}
