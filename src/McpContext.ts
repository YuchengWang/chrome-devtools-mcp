/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

import {overrideDevToolsGlobals} from './devtools/DevtoolsUtils.js';
import type {
  HeapSnapshotManager,
  HeapSnapshotAggregateData,
  HeapSnapshotDiff,
  HeapSnapshotDetailedClassDiff,
  DuplicateStringGroup,
  HeapEdgesQueryOptions,
  HeapQueryOptions,
} from './processors/HeapSnapshotManager.js';
import {McpPage} from './McpPage.js';
import type {UncaughtError} from './collectors/PageCollector.js';
import {
  isCdpSessionLike,
  type CdpSessionLike,
} from './collectors/RealtimeNetworkCollector.js';
import {ServiceWorkerCollector} from './collectors/ServiceWorkerCollector.js';
import {NetworkMonitorsManager} from './config/NetworkMonitorsConfig.js';
import {Mutex, type Root} from './third_party/index.js';
import {
  Locator,
  TimeoutError,
  type Browser,
  type BrowserContext,
  type Connection,
  type ConsoleMessage,
  type HTTPRequest,
  type GetPWAStateOptions,
  type InstallPWAOptions,
  type LaunchPWAOptions,
  type Page,
  type Protocol,
  type PWAState,
  type Target,
  type UninstallPWAOptions,
  type Extension,
  type DevTools,
} from './third_party/browser.js';
import type {ParsedArguments} from './config/mcp-options.js';
import type {ReadonlyServerConfig} from './config/ServerConfig.js';
import {ToolCategory} from './tools/categories.js';
import {
  CLOSE_PAGE_ERROR,
  isCapabilityEnabled,
  type BrowserlessContext,
  type CapabilityGate,
  type Context,
  type ContextPage,
  type DevToolsData,
  type SupportedExtensions,
} from './tools/ToolDefinition.js';
import type {TraceResult} from './processors/PerformanceTrace.js';
import type {ConnectBrowserOptions, Logger} from './types.js';
import {McpWorker} from './McpWorker.js';
import {getErrorMessage} from './utils/errorHandling.js';
import {
  fileUrlToPathWithPosixFallback,
  getTempFilePath,
  resolveCanonicalPath,
} from './utils/files.js';
import {escapeForLog, redactUrlForLogging} from './utils/logger.js';
import {
  fetchWithValidatedRedirects,
  validateUrlNotBlocked,
} from './utils/network.js';
import type {TaskQueue, TaskRunner} from './utils/TaskRunner.js';
import {isAllowedUrl} from './utils/url.js';

export type DownloadState = 'inProgress' | 'completed' | 'canceled';

export interface DownloadEntry {
  guid: string;
  url: string;
  suggestedFilename: string;
  filePath?: string;
  state: DownloadState;
  frameId?: string;
  totalBytes: number;
  receivedBytes: number;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
}

export interface WaitForDownloadOptions {
  guid?: string;
  filenameRegex?: RegExp;
  urlRegex?: RegExp;
  timeoutMs?: number;
  includeExistingCompleted?: boolean;
  sinceTimestamp?: number;
}

export interface RebindPageResult {
  recovered: boolean;
  targetId: string;
  page?: McpPage;
  frameId?: string;
  url?: string;
  pageSwapped?: boolean;
  selectedPageChanged?: boolean;
  fallbackPage?: McpPage;
}

interface DownloadWaiter {
  matches: (entry: DownloadEntry) => boolean;
  resolve: (entry: DownloadEntry) => void;
  reject: (err: Error) => void;
}

const MAX_DOWNLOAD_ENTRIES = 100;
const DEFAULT_DOWNLOAD_WAIT_TIMEOUT_MS = 30_000;

export interface McpContextOptions {
  config: ReadonlyServerConfig;
  // Custom navigation timeout in milliseconds to override default.
  navigationTimeout?: number;
  // Shared heap snapshot manager to preserve loaded snapshots across browser reconnects.
  heapSnapshotManager: HeapSnapshotManager;
  // Creates the context queue and the page queues.
  taskRunner: TaskRunner;
  // Optional monitor manager instance (used by tests).
  monitorsManager?: NetworkMonitorsManager;
  // Returns the browser to use. Called by ensureBrowser(), so the browser
  // connection is only established once a tool needs it.
  getBrowser: () => Promise<Browser>;
  // Dynamically switches or establishes the active browser connection.
  connectBrowser?: (
    options: ConnectBrowserOptions,
    onSwitched?: (browser: Browser) => Promise<void> | void,
  ) => Promise<Browser>;
}

interface OptionGate {
  options: ReadonlyArray<keyof ParsedArguments>;
}

type FeatureController =
  | {
      gate: OptionGate;
      onChange(context: McpContext): Promise<unknown> | void;
    }
  | {
      gate: CapabilityGate;
      onDisable(context: McpContext): Promise<void> | void;
    };

function hasOptionChanged(
  gate: OptionGate,
  previousArgs: ParsedArguments,
  nextArgs: ParsedArguments,
): boolean {
  return gate.options.some(
    option => !isDeepStrictEqual(nextArgs[option], previousArgs[option]),
  );
}

const FEATURE_CONTROLLERS: readonly FeatureController[] = [
  {
    gate: {options: ['blockedUrlPattern', 'allowedUrlPattern']},
    onChange: context => context.syncNetworkRestrictions(),
  },
  {
    gate: {options: ['sourceMaps']},
    onChange: context => context.syncSourceMaps(),
  },
  {
    gate: {options: ['experimentalIncludeAllPages']},
    onChange: context => context.createPagesSnapshot(),
  },
  {
    gate: {options: ['interceptDownloads']},
    onChange: context => context.syncDownloadInterception(),
  },
  {
    gate: {options: ['interceptFileChooser']},
    onChange: context => context.syncFileChooserInterception(),
  },
  {
    gate: {category: ToolCategory.DEBUGGING},
    onDisable: context => context.releaseScreencasts(),
  },
  {
    gate: {category: ToolCategory.MEMORY, conditions: ['memoryDebugging']},
    onDisable: context => context.releaseHeapSnapshots(),
  },
  {
    gate: {category: ToolCategory.PERFORMANCE},
    onDisable: context => context.releasePerformanceTrace(),
  },
  {
    gate: {category: ToolCategory.DEBUGGING, conditions: ['devtoolsComments']},
    onDisable: context => context.releaseDevToolsComments(),
  },
];

// Page ids are handed out from a process-wide counter so they stay unique
// across all contexts, in particular across browser reconnects. An id issued
// before a reconnect then fails to resolve instead of hitting an unrelated
// page of the reconnected browser.
let nextPageId = 1;

export class McpContext implements Context, BrowserlessContext {
  logger: Logger;

  #browser?: Browser;
  // Initialization of #browser, settles once its browser-dependent state is
  // ready.
  #browserReady?: Promise<void>;
  // Whether a browser connection was established before, so that switching to
  // a new browser surfaces a reconnect notice.
  #hasConnected = false;

  // Maps LLM-provided isolatedContext name → Puppeteer BrowserContext.
  #isolatedContexts = new Map<string, BrowserContext>();
  // Auto-generated name counter for when no name is provided.
  #nextIsolatedContextId = 1;

  // Cached McpWorker per target, reused across snapshots (mirrors #mcpPages) so
  // referential identity holds and workers can carry per-worker state later.
  #workers = new Map<Target, McpWorker>();

  #mcpPages = new Map<Target, McpPage>();
  /**
   * Queue for the browser-wide state (page list, selected page, trace
   * state). Every page queue is a child of it, so a task on it waits for
   * every page task and blocks later page tasks.
   */
  readonly taskQueue: TaskQueue;
  #taskRunner: TaskRunner;
  #pageTaskQueues = new Map<number, TaskQueue>();
  /**
   * Serializes `createPagesSnapshot()`. Two tasks on different page queues
   * can call it at the same time.
   */
  #pagesSnapshotMutex = new Mutex();
  #selectedPage?: McpPage;
  #selectedPageFallback?: {wasClosed: boolean};
  #selectedPageFallbackRead = false;

  #serviceWorkerCollector?: ServiceWorkerCollector;

  #reconnectNotice = false;

  #traceResults: TraceResult[] = [];

  #locatorClass: typeof Locator;
  #config: ReadonlyServerConfig;
  #options: McpContextOptions;
  #heapSnapshotManager: HeapSnapshotManager;
  #monitorsManager: NetworkMonitorsManager;
  #roots: Root[] | undefined = undefined;

  #downloads = new Map<string, DownloadEntry>();
  #downloadOrder: string[] = [];
  #downloadDir?: string;
  #downloadDirPromise?: Promise<string>;
  #downloadConnection?: CdpSessionLike;
  #downloadsConfiguredForBrowser?: Browser;
  #configuredDownloadContexts = new WeakSet<BrowserContext>();
  #downloadWaiters = new Set<DownloadWaiter>();
  #isIsolatedBrowser: boolean;
  #downloadsExplicitlyEnabled = false;
  #monitorsUnsubscribe?: () => void;

  private constructor(
    logger: Logger,
    options: McpContextOptions,
    locatorClass: typeof Locator,
  ) {
    overrideDevToolsGlobals({
      loadResource: (url: string) => {
        return this.loadResource(url);
      },
    });

    this.logger = logger;
    this.#locatorClass = locatorClass;
    this.#taskRunner = options.taskRunner;
    this.taskQueue = options.taskRunner.createQueue();
    this.#config = options.config;
    this.#options = options;
    this.#isIsolatedBrowser = Boolean(options.config.resolved.isolated);
    this.#heapSnapshotManager = options.heapSnapshotManager;
    this.#monitorsManager =
      options.monitorsManager ??
      new NetworkMonitorsManager({
        validatePath: filePath => this.validatePath(filePath),
        getAllowedRoots: () =>
          this.roots().map(root =>
            path.resolve(fileUrlToPathWithPosixFallback(root.uri)),
          ),
      });
    this.#monitorsManager.start();
    this.#monitorsUnsubscribe = this.#monitorsManager.onConfigChange(() => {
      void this.syncDownloadInterception();
    });
  }

  /**
   * The browser of the current connection. Throws if no browser connection was
   * established yet, see {@link McpContext.ensureBrowser}.
   */
  get browser(): Browser {
    if (!this.#browser) {
      throw new Error('Not connected to a browser.');
    }
    return this.#browser;
  }

  #allMcpPages(): Set<McpPage> {
    const pages = new Set(this.#mcpPages.values());
    if (this.#selectedPage) {
      pages.add(this.#selectedPage);
    }
    return pages;
  }

  /**
   * Synchronizes browser/page state and releases state of capabilities that
   * transitioned from enabled to disabled after a config reload.
   */
  async onConfigChanged(previousArgs: ParsedArguments): Promise<void> {
    const nextArgs = this.#config.resolved;
    for (const controller of FEATURE_CONTROLLERS) {
      if ('onChange' in controller) {
        if (hasOptionChanged(controller.gate, previousArgs, nextArgs)) {
          await controller.onChange(this);
        }
      } else if (
        isCapabilityEnabled(controller.gate, previousArgs) &&
        !isCapabilityEnabled(controller.gate, nextArgs)
      ) {
        await controller.onDisable(this);
      }
    }
  }

  /**
   * Applies updated URL allowlist/blocklist rules to the connected browser and
   * clears incompatible page network throttling state.
   */
  async syncNetworkRestrictions(): Promise<void> {
    const {blockedUrlPattern, allowedUrlPattern} = this.#config.resolved;
    if (blockedUrlPattern || allowedUrlPattern) {
      for (const mcpPage of this.#allMcpPages()) {
        await mcpPage.clearNetworkConditions();
      }
    }
    if (this.#browser) {
      await this.#browser.restrictNetwork({
        blocklist: blockedUrlPattern,
        allowlist: allowedUrlPattern,
      });
    }
  }

  /**
   * Synchronizes the DevTools source maps setting across all pages.
   */
  syncSourceMaps(): void {
    for (const mcpPage of this.#allMcpPages()) {
      mcpPage.syncSourceMaps();
    }
  }

  /**
   * Stops and saves active screencast recordings across all pages when
   * screencast tools are disabled.
   */
  async releaseScreencasts(): Promise<void> {
    for (const mcpPage of this.#allMcpPages()) {
      const screenRecorderData = mcpPage.getScreenRecorder();
      if (!screenRecorderData) {
        continue;
      }
      const {recorder, filePath} = screenRecorderData;
      mcpPage.setScreenRecorder(null);
      try {
        await recorder.stop();
        this.logger?.(
          `The screencast recording was stopped and saved to ${filePath} because screencast tools were disabled.`,
        );
      } catch (err) {
        this.logger?.('Failed to stop the screencast recording', err);
      }
    }
  }

  /**
   * Closes all loaded heap snapshots when memory tools are disabled.
   */
  releaseHeapSnapshots(): void {
    if (this.#heapSnapshotManager.hasSnapshots()) {
      this.#heapSnapshotManager.dispose();
      this.logger?.(
        'Loaded heap snapshots were closed because memory tools were disabled.',
      );
    }
  }

  /**
   * Discards recorded performance traces and stops any running trace when
   * performance tools are disabled.
   */
  async releasePerformanceTrace(): Promise<void> {
    this.#traceResults = [];
    for (const mcpPage of this.#allMcpPages()) {
      if (!mcpPage.isRunningPerformanceTrace()) {
        continue;
      }
      mcpPage.setIsRunningPerformanceTrace(false);
      try {
        await mcpPage.pptrPage.tracing.stop();
      } catch (err) {
        this.logger?.('Failed to stop the performance trace', err);
      }
      this.logger?.(
        'The running performance trace was discarded because performance tools were disabled.',
      );
    }
  }

  /**
   * Disposes DevTools comment bridges across all pages when DevTools comment
   * tools are disabled.
   */
  releaseDevToolsComments(): void {
    for (const mcpPage of this.#allMcpPages()) {
      mcpPage.disposeCommentBridge();
    }
  }

  /**
   * Returns the browser, establishing the connection if needed. If the browser
   * changed since the last call (e.g. after a reconnect), all
   * browser-dependent state is rebuilt for the new browser.
   */
  async ensureBrowser(): Promise<Browser> {
    const browser = await this.#options.getBrowser();
    if (browser === this.#browser && this.#browserReady) {
      // Joins a still pending initialization instead of handing out
      // half-initialized state.
      await this.#browserReady;
      return browser;
    }

    this.#resetBrowserState();
    this.#browser = browser;
    const ready = this.#initBrowserState(browser);
    this.#browserReady = ready;
    try {
      await ready;
      return browser;
    } catch (err) {
      // Leave no half-initialized state behind, the next call starts over. If
      // a later call already installed another browser, its state is left
      // intact.
      if (this.#browserReady === ready) {
        this.#resetBrowserState();
      }
      throw err;
    }
  }

  /**
   * Hot-switches the active browser to a new endpoint or launched isolated
   * instance, resetting stale page/worker state and re-initializing against
   * the new browser before returning.
   */
  async connectBrowser(options: ConnectBrowserOptions): Promise<Browser> {
    if (!this.#options.connectBrowser) {
      throw new Error(
        'Dynamic browser connection is not configured for this context.',
      );
    }
    return await this.#options.connectBrowser(options, async browser => {
      this.#resetBrowserState();
      this.#isIsolatedBrowser = Boolean(
        options.isolated ??
        (options.incognito && options.userDataDir === undefined),
      );
      this.#downloadsExplicitlyEnabled = false;
      this.#browser = browser;
      const ready = this.#initBrowserState(browser);
      this.#browserReady = ready;
      try {
        await ready;
        this.#reconnectNotice = false;
      } catch (err) {
        if (this.#browserReady === ready) {
          this.#resetBrowserState();
        }
        throw err;
      }
    });
  }

  #shouldEnableDownloads(): boolean {
    return (
      this.#downloadsExplicitlyEnabled ||
      this.#isIsolatedBrowser ||
      Boolean(
        this.#monitorsManager?.getConfig().interceptDownloads ||
        this.#config.resolved.interceptDownloads,
      )
    );
  }

  async #initBrowserState(browser: Browser): Promise<void> {
    const collector = new ServiceWorkerCollector(browser);
    this.#serviceWorkerCollector = collector;
    // All listeners are registered synchronously, before the first await. If
    // this call hangs and is abandoned by the tool-call timeout, a later call
    // that installs a different browser removes them in #resetBrowserState().
    browser.on('targetcreated', this.#onTargetCreated);
    browser.on('targetdestroyed', this.#onTargetDestroyed);
    const shouldTrackDownloads = this.#shouldEnableDownloads();
    if (shouldTrackDownloads) {
      this.#attachDownloadListeners(browser);
    }
    await Promise.all([
      collector.init(this.createWorkersSnapshot()),
      this.createPagesSnapshot(),
      shouldTrackDownloads ? this.#enableDownloads(browser) : Promise.resolve(),
    ]);
    // The state now belongs to the browser of a later call, leave it intact.
    if (this.#browser !== browser) {
      throw new Error('Browser was replaced while initializing.');
    }

    if (this.#hasConnected) {
      this.#reconnectNotice = true;
    }
    this.#hasConnected = true;
  }

  #resetBrowserState(): void {
    this.#browser?.off('targetcreated', this.#onTargetCreated);
    this.#browser?.off('targetdestroyed', this.#onTargetDestroyed);
    this.#detachDownloadListeners();
    this.#downloadsConfiguredForBrowser = undefined;

    this.#serviceWorkerCollector?.dispose();
    for (const mcpPage of this.#allMcpPages()) {
      this.#disposeMcpPage(mcpPage);
    }
    this.#mcpPages.clear();
    this.#workers.clear();
    // Isolated contexts are intentionally not closed here.
    // Either the entire browser will be closed or we disconnect
    // without destroying browser state.
    this.#isolatedContexts.clear();
    this.#configuredDownloadContexts = new WeakSet();
    this.#downloads.clear();
    this.#downloadOrder = [];
    for (const waiter of this.#downloadWaiters) {
      waiter.reject(
        new Error('Browser connection reset while waiting for download.'),
      );
    }
    this.#downloadWaiters.clear();
    this.#nextIsolatedContextId = 1;
    this.#selectedPage = undefined;
    this.#selectedPageFallback = undefined;
    this.#selectedPageFallbackRead = false;
    this.#traceResults = [];
    this.#serviceWorkerCollector = undefined;
    this.#browser = undefined;
    this.#browserReady = undefined;
  }

  dispose(): void {
    this.#monitorsUnsubscribe?.();
    this.#monitorsUnsubscribe = undefined;
    this.#resetBrowserState();
    this.#cleanupDownloadDir();
    if (!this.#options.monitorsManager) {
      this.#monitorsManager.dispose();
    }
  }

  #cleanupDownloadDir(): void {
    const dir = this.#downloadDir;
    const dirPromise = this.#downloadDirPromise;
    this.#downloadDir = undefined;
    this.#downloadDirPromise = undefined;
    if (dir) {
      try {
        fsSync.rmSync(dir, {recursive: true, force: true});
      } catch (err) {
        this.logger?.(
          `Failed to remove temp download directory ${dir}: ${getErrorMessage(err)}`,
        );
      }
    } else if (dirPromise) {
      void dirPromise
        .then(resolvedDir => fs.rm(resolvedDir, {recursive: true, force: true}))
        .catch(err => {
          this.logger?.(
            `Failed to remove pending temp download directory: ${getErrorMessage(err)}`,
          );
        });
    }
  }

  #onTargetCreated = (target: Target): void => {
    try {
      if (!this.#isPageTarget(target)) {
        return;
      }
      this.#createMcpPage(target);
    } catch (err) {
      this.logger?.('Error handling targetcreated', err);
    }
  };

  #onTargetDestroyed = (target: Target): void => {
    try {
      const mcpPage = this.#mcpPages.get(target);
      if (mcpPage) {
        this.#disposeMcpPage(mcpPage);
        this.#mcpPages.delete(target);
      }
      this.#workers.delete(target);
    } catch (err) {
      this.logger?.('Error handling targetdestroyed', err);
    }
  };

  static create(
    logger: Logger,
    opts: McpContextOptions,
    /* Let tests use unbundled Locator class to avoid overly strict checks within puppeteer that fail when mixing bundled and unbundled class instances */
    locatorClass: typeof Locator = Locator,
  ): McpContext {
    return new McpContext(logger, opts, locatorClass);
  }

  static resetPageIdsForTesting(): void {
    nextPageId = 1;
  }

  static resetWorkerIdsForTesting(): void {
    McpWorker.resetIdsForTesting();
  }

  roots(): Root[] {
    return [
      ...(this.#roots ?? []),
      {
        uri: pathToFileURL(os.tmpdir()).href,
        name: 'temp',
      },
    ];
  }

  setRoots(roots: Root[] | undefined): void {
    this.#roots = roots;
  }

  /**
   * Validates that the filePath is allowed according to the roots configuration.
   * Tolerates if parts of the filePath do not exist yet but the file access to
   * the resolved should only be allowed without following symlinks.
   */
  async validatePath(filePath: string): Promise<string>;
  async validatePath(filePath?: undefined): Promise<undefined>;
  async validatePath(filePath?: string): Promise<string | undefined>;
  async validatePath(filePath?: string): Promise<string | undefined> {
    if (filePath === undefined) {
      return undefined;
    }

    let canonicalPath: string;

    try {
      canonicalPath = await resolveCanonicalPath(filePath);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(
        `[MCP Context] Error resolving real path for ${escapeForLog(filePath)}: ${escapeForLog(errMsg)}`,
      );
      throw new Error(
        `Access denied: Cannot resolve base path for ${escapeForLog(filePath)}.`,
      );
    }

    // If the client never negotiated roots and the operator has explicitly
    // opted into unrestricted access via --allow-unrestricted-paths, restore
    // the previous permissive behavior and skip validation.
    if (
      this.#roots === undefined &&
      this.#config.resolved.allowUnrestrictedPaths
    ) {
      // Canonical path might not exist yet so we fallback to
      // path.resolve(filePath). Consumers should not follow symlinks.
      return canonicalPath || path.resolve(filePath);
    }
    // roots() always returns at least the temp directory, even if the
    // connecting client never negotiated the optional `roots` capability.
    // Path validation must not be skipped just because no workspace roots
    // were configured.
    const roots = this.roots();

    let allowed = false;
    const resolvedRoots = await Promise.allSettled(
      roots.map(async root => {
        const rootPathUri = root.uri;
        const rootPath = path.resolve(
          fileUrlToPathWithPosixFallback(rootPathUri),
        );
        return await fs.realpath(rootPath);
      }),
    );

    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      const result = resolvedRoots[i];

      if (result.status === 'fulfilled') {
        const canonicalRoot = result.value;
        // A filesystem root such as `/` or `C:\` already ends with the
        // separator; appending another one would match no path below it.
        const rootPrefix = canonicalRoot.endsWith(path.sep)
          ? canonicalRoot
          : canonicalRoot + path.sep;
        if (
          canonicalPath === canonicalRoot ||
          canonicalPath.startsWith(rootPrefix)
        ) {
          allowed = true;
          break;
        }
      } else {
        const rootErr = result.reason;
        const errMsg =
          rootErr instanceof Error ? rootErr.message : String(rootErr);
        console.warn(
          `[MCP Context] Could not resolve configured root ${escapeForLog(root.uri)}: ${escapeForLog(errMsg)}`,
        );
        // Skip this root if it cannot be resolved.
      }
    }

    if (!allowed) {
      throw new Error(
        `Access denied: path ${escapeForLog(filePath)} (canonical: ${escapeForLog(canonicalPath)}) is not within any of the configured workspace roots.`,
      );
    }

    return canonicalPath || path.resolve(filePath);
  }

  async ensureExtension<Extension extends `.${string}`>(
    filePath: string,
    extension: Extension,
  ): Promise<`${string}${Extension}`> {
    const resolved = await this.validatePath(filePath);
    const currentExtension = path.extname(resolved);
    const outputPath: `${string}${Extension}` = `${resolved.slice(
      0,
      resolved.length - currentExtension.length,
    )}${extension}`;
    return outputPath;
  }

  async newPage(
    background?: boolean,
    isolatedContextName?: string,
  ): Promise<McpPage> {
    let page: Page;
    if (isolatedContextName !== undefined) {
      let ctx = this.#isolatedContexts.get(isolatedContextName);
      if (!ctx) {
        ctx = await this.browser.createBrowserContext();
        this.#isolatedContexts.set(isolatedContextName, ctx);
        if (this.#shouldEnableDownloads()) {
          await this.#configureDownloadBehaviorForContext(this.browser, ctx);
        }
      }
      page = await ctx.newPage({background});
    } else {
      page = await this.browser.newPage({background});
    }
    const mcpPage = this.#createMcpPage(page.target());
    await mcpPage.init({emulateFocus: true});
    this.selectPage(mcpPage);
    await this.createPagesSnapshot();
    return mcpPage;
  }
  async closePage(pageId: number): Promise<void> {
    const page = this.getPageById(pageId);
    if (this.#mcpPages.size === 1) {
      throw new Error(CLOSE_PAGE_ERROR);
    }
    this.#mcpPages.delete(page.target);
    await page.close();
  }

  async installPWA(options: InstallPWAOptions): Promise<string> {
    try {
      return await this.browser.installPWA(options);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("Couldn't fetch install info")
      ) {
        return await this.browser.installPWA(options);
      }
      throw error;
    }
  }

  uninstallPWA(options: UninstallPWAOptions): Promise<void> {
    return this.browser.uninstallPWA(options);
  }

  async launchPWA(options: LaunchPWAOptions): Promise<Page> {
    const page = await this.browser.launchPWA(options);
    if (!page.url() || page.url() === 'about:blank') {
      await page
        .waitForNavigation({
          timeout: this.#options.navigationTimeout ?? 10_000,
        })
        .catch(() => {
          // Ignore timeout if navigation already completed or failed.
        });
    }
    return page;
  }

  getPWAState(options: GetPWAStateOptions): Promise<PWAState> {
    return this.browser.getPWAState(options);
  }

  isRunningPerformanceTrace(): boolean {
    for (const mcpPage of this.#allMcpPages()) {
      if (mcpPage.isRunningPerformanceTrace()) {
        return true;
      }
    }
    return false;
  }

  isCruxEnabled(): boolean {
    return this.#config.resolved.performanceCrux;
  }

  getPages(): McpPage[] {
    return Array.from(this.#mcpPages.values());
  }

  /**
   * Fetches current target info for all targets from the browser, keyed by
   * target id. Unlike Puppeteer's cached target info, this reflects title
   * changes, which Chrome does not report via `Target.targetInfoChanged`.
   * Returns an empty map if the browser cannot be queried.
   */
  async getTargetInfos(): Promise<Map<string, Protocol.Target.TargetInfo>> {
    try {
      // @ts-expect-error use existing browser connection (internal Puppeteer API).
      const connection: Connection = this.browser._connection;
      const {targetInfos} = await connection.send('Target.getTargets');
      return new Map(targetInfos.map(info => [info.targetId, info]));
    } catch (err) {
      this.logger?.('Failed to fetch target infos', err);
      return new Map();
    }
  }

  getSelectedMcpPage(): McpPage {
    const page = this.#selectedPage;
    if (!page) {
      throw new Error('No page selected');
    }
    if (page.isClosed()) {
      throw new Error(
        'The selected page has been closed. Call list_pages to see open pages.',
      );
    }
    return page;
  }

  getSelectedMcpPageUrl(page?: McpPage): string | undefined {
    let targetPage = page;
    if (!targetPage) {
      try {
        targetPage = this.getSelectedMcpPage();
      } catch {
        return undefined;
      }
    }
    if (targetPage && !targetPage.isClosed()) {
      return targetPage.url();
    }
    return undefined;
  }

  async getDevToolsData(page?: McpPage): Promise<DevToolsData | undefined> {
    const targetPage = page ?? this.#selectedPage;
    if (!targetPage) {
      return undefined;
    }
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<undefined>(resolve => {
      timeoutId = setTimeout(() => resolve(undefined), 500);
    });
    const dataPromise = targetPage.getDevToolsData();
    try {
      return await Promise.race([dataPromise, timeoutPromise]);
    } catch {
      return undefined;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Returns true once after the browser connection was re-established with a
   * new browser, so the next response can surface a note. Cleared on first
   * call.
   */
  consumeReconnectNotice(): boolean {
    const notice = this.#reconnectNotice;
    this.#reconnectNotice = false;
    return notice;
  }

  #findPageById(pageId: number): McpPage | undefined {
    return this.#mcpPages.values().find(mcpPage => mcpPage.id === pageId);
  }

  getPageById(pageId: number): McpPage {
    const page = this.#findPageById(pageId);
    if (!page) {
      throw new Error('No page found');
    }
    return page;
  }

  /**
   * The queue for tasks on page `pageId`, a child of {@link taskQueue}.
   * Returns {@link taskQueue} when no page has this id, for example before
   * the browser connects. No queue is stored for such an id.
   */
  pageTaskQueue(pageId: number): TaskQueue {
    let queue = this.#pageTaskQueues.get(pageId);
    if (!queue) {
      if (!this.#findPageById(pageId)) {
        return this.taskQueue;
      }
      queue = this.#taskRunner.createQueue(this.taskQueue);
      this.#pageTaskQueues.set(pageId, queue);
    }
    return queue;
  }

  #disposeMcpPage(mcpPage: McpPage): void {
    mcpPage.dispose();
    this.#pageTaskQueues
      .get(mcpPage.id)
      ?.dispose(new Error(`Page ${mcpPage.id} is closed.`));
    this.#pageTaskQueues.delete(mcpPage.id);
  }

  isPageSelected(page: McpPage): boolean {
    return this.#selectedPage === page;
  }

  selectPage(newPage: McpPage): void {
    this.#selectedPageFallback = undefined;
    this.#selectedPageFallbackRead = false;
    this.#selectPage(newPage);
  }

  #selectPage(newPage: McpPage): void {
    if (
      this.#selectedPage &&
      this.#selectedPage !== newPage &&
      !this.#mcpPages.has(this.#selectedPage.target)
    ) {
      this.#disposeMcpPage(this.#selectedPage);
    }
    this.#selectedPage = newPage;
    newPage.updateTimeouts();
  }

  /**
   * Returns details about the last page snapshot automatically replacing the
   * selection because the selected page disappeared from the page list, or
   * `undefined` if the snapshot left the selection intact. Cleared on the next
   * createPagesSnapshot() call after it has been read, or when selectPage() is
   * called explicitly.
   */
  getSelectedPageFallback(): {wasClosed: boolean} | undefined {
    this.#selectedPageFallbackRead = true;
    return this.#selectedPageFallback;
  }

  /**
   * Creates a snapshot of the tracked workers. Today this is limited to
   * extension service workers; the McpWorker abstraction lets dedicated and
   * shared workers join the same snapshot later without changing consumers.
   */
  createWorkersSnapshot(): McpWorker[] {
    const serviceWorkers = this.browser.targets().filter(target => {
      return (
        target.type() === 'service_worker' &&
        target.url().includes('chrome-extension://')
      );
    });

    // Reuse the existing McpWorker for a target; only mint one (and an id) for
    // targets seen for the first time.
    for (const target of serviceWorkers) {
      if (!this.#workers.has(target)) {
        this.#workers.set(target, McpWorker.create('service_worker', target));
      }
    }

    // Prune workers whose target is gone (mirrors #mcpPages pruning).
    const currentTargets = new Set(serviceWorkers);
    for (const target of this.#workers.keys()) {
      if (!currentTargets.has(target)) {
        this.#workers.delete(target);
      }
    }

    return Array.from(this.#workers.values());
  }

  #getServiceWorkerExtensionId(serviceWorkerId: string): string {
    const worker = this.getWorkerById(serviceWorkerId);
    if (worker?.type !== 'service_worker') {
      throw new Error(
        `Service worker ${serviceWorkerId} not found. Call list_pages to get the current sw-N IDs.`,
      );
    }
    return new URL(worker.url).hostname;
  }

  getServiceWorkerConsoleData(
    serviceWorkerId: string,
  ): Array<ConsoleMessage | UncaughtError> {
    const extensionId = this.#getServiceWorkerExtensionId(serviceWorkerId);
    return this.#serviceWorkerCollector?.console.getData(extensionId) ?? [];
  }

  getServiceWorkerConsoleMessageById(
    serviceWorkerId: string,
    msgid: number,
  ): ConsoleMessage | UncaughtError {
    const extensionId = this.#getServiceWorkerExtensionId(serviceWorkerId);
    if (!this.#serviceWorkerCollector) {
      throw new Error('Service worker console data is not available.');
    }
    return this.#serviceWorkerCollector.console.getById(extensionId, msgid);
  }

  getServiceWorkerNetworkData(serviceWorkerId: string): HTTPRequest[] {
    const extensionId = this.#getServiceWorkerExtensionId(serviceWorkerId);
    return this.#serviceWorkerCollector?.network.getData(extensionId) ?? [];
  }

  getServiceWorkerNetworkRequestById(
    serviceWorkerId: string,
    reqid: number,
  ): HTTPRequest {
    const extensionId = this.#getServiceWorkerExtensionId(serviceWorkerId);
    if (!this.#serviceWorkerCollector) {
      throw new Error('Service worker network data is not available.');
    }
    return this.#serviceWorkerCollector.network.getById(extensionId, reqid);
  }

  #getBrowserContextToNameMap(): Map<BrowserContext, string> {
    // Build a reverse lookup from BrowserContext instance → name.
    const contextToName = new Map<BrowserContext, string>();
    for (const [name, ctx] of this.#isolatedContexts) {
      contextToName.set(ctx, name);
    }
    const defaultCtx = this.browser.defaultBrowserContext();
    // Auto-discover BrowserContexts not in our mapping (e.g., externally
    // created incognito contexts) and assign generated names.
    const knownContexts = new Set(this.#isolatedContexts.values());
    for (const ctx of this.browser.browserContexts()) {
      if (ctx !== defaultCtx && !ctx.closed && !knownContexts.has(ctx)) {
        const name = `isolated-context-${this.#nextIsolatedContextId++}`;
        this.#isolatedContexts.set(name, ctx);
        contextToName.set(ctx, name);
        if (this.#shouldEnableDownloads()) {
          void this.#configureDownloadBehaviorForContext(this.browser, ctx);
        }
      }
    }
    return contextToName;
  }

  #createMcpPage(target: Target): McpPage {
    let mcpPage =
      this.#mcpPages.get(target) ??
      (this.#selectedPage?.target === target ? this.#selectedPage : undefined);
    if (!mcpPage) {
      mcpPage = new McpPage(target, nextPageId++, {
        config: this.#config,
        locatorClass: this.#locatorClass,
        isolatedContextName: this.#getBrowserContextToNameMap().get(
          target.browserContext(),
        ),
        navigationTimeout: this.#options.navigationTimeout,
        monitorsManager: this.#monitorsManager,
      });
    }
    this.#mcpPages.set(target, mcpPage);
    return mcpPage;
  }

  async createPagesSnapshot(): Promise<McpPage[]> {
    if (!this.#browser) {
      return [];
    }
    using guard = await this.#pagesSnapshotMutex.acquire();
    const allTargets = this.#fetchPageTargets();

    for (const target of allTargets) {
      this.#createMcpPage(target);
    }

    // Prune orphaned #mcpPages entries (targets that no longer exist).
    const currentTargets = new Set(allTargets);
    for (const [target, mcpPage] of this.#mcpPages) {
      if (!currentTargets.has(target)) {
        if (mcpPage !== this.#selectedPage || mcpPage.isClosed()) {
          this.#disposeMcpPage(mcpPage);
        }
        this.#mcpPages.delete(target);
      }
    }

    const pages = Array.from(this.#mcpPages.values());

    // Only fall back when the selected page is actually gone or no longer
    // counts as a page, e.g. a background page after
    // experimentalIncludeAllPages was turned off. Gating on `isClosed()`
    // instead of `pages` membership avoids silently swapping a live page that
    // is momentarily missing from the snapshot.
    if (this.#selectedPageFallbackRead) {
      this.#selectedPageFallback = undefined;
      this.#selectedPageFallbackRead = false;
    }
    if (
      !this.#selectedPage ||
      this.#selectedPage.isClosed() ||
      !this.#isPageTarget(this.#selectedPage.target)
    ) {
      if (pages[0]) {
        // Record the automatic change so the response can surface it. Skipped on
        // first connect, when there was no prior selection to replace.
        if (this.#selectedPage) {
          this.#selectedPageFallback = {
            wasClosed: this.#selectedPage.isClosed(),
          };
        }
        this.#selectPage(pages[0]);
      } else if (this.#selectedPage) {
        const wasClosed = Boolean(this.#selectedPage.isClosed());
        if (!wasClosed) {
          this.#disposeMcpPage(this.#selectedPage);
        }
        this.#selectedPage = undefined;
        this.#selectedPageFallback = {wasClosed};
      }
    }

    if (this.#selectedPage && !this.#selectedPage.isClosed()) {
      // Automatic page snapshots must preserve real focus on untouched tabs.
      await this.#selectedPage.init({emulateFocus: false});
    }

    return pages;
  }

  #isPageTarget(target: Target): boolean {
    const existingMcpPage =
      this.#mcpPages.get(target) ??
      (this.#selectedPage?.target === target ? this.#selectedPage : undefined);
    const url = existingMcpPage ? existingMcpPage.url() : target.url();
    if (
      !this.#config.resolved.experimentalDevtools &&
      url.startsWith('devtools://')
    ) {
      return false;
    }
    if (
      !isAllowedUrl(url, {
        categoryExtensions: this.#config.resolved.categoryExtensions,
      })
    ) {
      return false;
    }
    const type = target.type();
    if (type === 'page') {
      return true;
    }
    if (
      this.#config.resolved.experimentalIncludeAllPages &&
      (type === 'background_page' || type === 'webview')
    ) {
      return true;
    }
    if (
      this.#config.resolved.experimentalDevtools &&
      type === 'other' &&
      url.startsWith('devtools://')
    ) {
      return true;
    }
    return false;
  }

  #fetchPageTargets(): Target[] {
    return this.browser.targets().filter(target => this.#isPageTarget(target));
  }

  getWorkers(): McpWorker[] {
    return Array.from(this.#workers.values());
  }

  getWorkerById(id: string): McpWorker | undefined {
    return this.#workers.values().find(worker => worker.id === id);
  }

  async #writeFile(
    filepath: string,
    data: Uint8Array<ArrayBufferLike>,
  ): Promise<void> {
    const resolved = await this.validatePath(filepath);

    try {
      await fs.mkdir(path.dirname(resolved), {recursive: true});
      // Open the file with flags to:
      // - O_WRONLY: Write-only
      // - O_CREAT: Create if it doesn't exist
      // - O_TRUNC: Truncate to zero length if it exists
      // - O_NOFOLLOW: DO NOT follow symlinks.
      // - 0o600: Permissions: read/write for owner, no permissions for others.
      await fs.writeFile(resolved, data, {
        flag:
          fs.constants.O_WRONLY |
          fs.constants.O_CREAT |
          fs.constants.O_TRUNC |
          fs.constants.O_NOFOLLOW,
        mode: 0o600,
      });
    } catch (err) {
      throw new Error(`Could not write ${escapeForLog(filepath)}`, {
        cause: err,
      });
    }
  }

  async saveTemporaryFile(
    data: Uint8Array<ArrayBufferLike>,
    filename: string,
  ): Promise<{filepath: string}> {
    const filepath = await getTempFilePath(filename);
    await this.#writeFile(filepath, data);
    return {filepath};
  }

  async saveFile(
    data: Uint8Array<ArrayBufferLike>,
    clientProvidedFilePath: string,
    extension: SupportedExtensions,
  ): Promise<{filename: string}> {
    const filePath = await this.ensureExtension(
      clientProvidedFilePath,
      extension,
    );
    await this.#writeFile(filePath, data);
    return {filename: filePath};
  }

  storeTraceRecording(result: TraceResult): void {
    // Clear the trace results because we only consume the latest trace currently.
    this.#traceResults = [];
    this.#traceResults.push(result);
  }

  recordedTraces(): TraceResult[] {
    return this.#traceResults;
  }

  async installExtension(extensionPath: string): Promise<string> {
    const id = await Promise.race([
      this.browser.installExtension(extensionPath),
      new Promise<string>((_, rej) =>
        setTimeout(() => rej(new Error('Timeout installing extension')), 30000),
      ),
    ]);
    return id;
  }

  async uninstallExtension(id: string): Promise<void> {
    await Promise.race([
      this.browser.uninstallExtension(id),
      new Promise<void>((_, rej) =>
        setTimeout(
          () => rej(new Error('Timeout uninstalling extension')),
          30000,
        ),
      ),
    ]);
  }

  async triggerExtensionAction(id: string): Promise<void> {
    const extensions = await this.browser.extensions();
    const extension = extensions.get(id);
    if (!extension) {
      throw new Error(`Extension with ID ${id} not found.`);
    }
    const page = this.getSelectedMcpPage().pptrPage;
    await extension.triggerAction(page);
  }

  listExtensions(): Promise<Map<string, Extension>> {
    return this.browser.extensions();
  }

  async getExtension(id: string): Promise<Extension | undefined> {
    const pptrExtensions = await this.browser.extensions();
    return pptrExtensions.get(id);
  }

  async getHeapSnapshotAggregates(
    filePath: string,
    filterName?: string,
    objectId?: number,
  ): Promise<HeapSnapshotAggregateData> {
    return await this.#heapSnapshotManager.getAggregates(
      filePath,
      filterName,
      objectId,
    );
  }

  async getHeapSnapshotDuplicateStrings(
    filePath: string,
  ): Promise<DuplicateStringGroup[]> {
    return await this.#heapSnapshotManager.getDuplicateStrings(filePath);
  }

  async queryHeapSnapshotObjects(
    filePath: string,
    options: HeapQueryOptions,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.ItemsRange> {
    return await this.#heapSnapshotManager.queryObjects(filePath, options);
  }

  async getHeapSnapshotStats(
    filePath: string,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.Statistics> {
    return await this.#heapSnapshotManager.getStats(filePath);
  }

  async getHeapSnapshotStaticData(
    filePath: string,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.StaticData | null> {
    return await this.#heapSnapshotManager.getStaticData(filePath);
  }

  async getHeapSnapshotNativeContextSizes(
    filePath: string,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.NativeContextSizes> {
    return await this.#heapSnapshotManager.getNativeContextSizes(filePath);
  }

  async getHeapSnapshotRetainedByContextSummary(
    filePath: string,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.RetainedByContextSummary> {
    return await this.#heapSnapshotManager.getRetainedByContextSummary(
      filePath,
    );
  }

  async getHeapSnapshotNodesById(
    filePath: string,
    id: number,
    filterName?: string,
    objectId?: number,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.ItemsRange> {
    return await this.#heapSnapshotManager.getNodesById(
      filePath,
      id,
      filterName,
      objectId,
    );
  }

  async getHeapSnapshotRetainers(
    filePath: string,
    nodeId: number,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.ItemsRange> {
    return await this.#heapSnapshotManager.getRetainers(filePath, nodeId);
  }

  async getHeapSnapshotObjectDetails(
    filePath: string,
    nodeId: number,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.ObjectInfo> {
    return await this.#heapSnapshotManager.getObjectInfo(filePath, nodeId);
  }

  async analyzeHeapSnapshotContexts(
    filePath: string,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.ContextAnalysisResult> {
    return await this.#heapSnapshotManager.analyzeContexts(filePath);
  }

  async closeHeapSnapshot(filePath: string): Promise<boolean> {
    return await this.#heapSnapshotManager.disposeSnapshot(filePath);
  }

  async getHeapSnapshotRetainingPaths(
    filePath: string,
    nodeId: number,
    maxDepth?: number,
    maxNodes?: number,
    maxSiblings?: number,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.RetainingPaths> {
    return await this.#heapSnapshotManager.getRetainingPaths(
      filePath,
      nodeId,
      maxDepth,
      maxNodes,
      maxSiblings,
    );
  }

  async getHeapSnapshotDominators(
    filePath: string,
    nodeId: number,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.DominatorChain> {
    return await this.#heapSnapshotManager.getDominatorsOf(filePath, nodeId);
  }

  async #loadNetworkResource(url: URL): Promise<string> {
    const response = await fetchWithValidatedRedirects(url, {
      policy: this.#config.resolved,
    });
    if (!response.ok) {
      throw new Error(
        'Failed to load resource: ' +
          redactUrlForLogging(response.url || url.href),
      );
    }
    return await response.text();
  }

  async loadResource(path: string): Promise<string> {
    const url = new URL(path);

    validateUrlNotBlocked(url, this.#config.resolved.blockedUrlPattern);

    switch (url.protocol) {
      case 'https:':
      case 'http:': {
        return await this.#loadNetworkResource(url);
      }

      case 'file:': {
        const resolved = await this.validatePath(fileURLToPath(url));
        return await fs.readFile(resolved, 'utf-8');
      }

      default:
        throw new Error(`Unsupported protocol for: ${url}`);
    }
  }

  async getHeapSnapshotEdges(
    filePath: string,
    nodeId: number,
    options?: HeapEdgesQueryOptions,
  ): Promise<DevTools.HeapSnapshotModel.HeapSnapshotModel.ItemsRange> {
    return await this.#heapSnapshotManager.getEdges(filePath, nodeId, options);
  }

  async getHeapSnapshotClassDiffs(
    baseFilePath: string,
    currentFilePath: string,
  ): Promise<HeapSnapshotDiff> {
    return await this.#heapSnapshotManager.getClassDiffs(
      baseFilePath,
      currentFilePath,
    );
  }

  async getHeapSnapshotDetailedClassDiff(
    baseFilePath: string,
    currentFilePath: string,
    classIndex: number,
  ): Promise<HeapSnapshotDetailedClassDiff> {
    return await this.#heapSnapshotManager.getDetailedClassDiff(
      baseFilePath,
      currentFilePath,
      classIndex,
    );
  }

  getNetworkMonitorsManager(): NetworkMonitorsManager {
    return this.#monitorsManager;
  }

  getDownloadDirectory(): string | undefined {
    return this.#downloadDir;
  }

  async enableDownloads(): Promise<void> {
    this.#downloadsExplicitlyEnabled = true;
    if (this.#browser) {
      this.#attachDownloadListeners(this.#browser);
      await this.#enableDownloads(this.#browser);
    }
  }

  async syncDownloadInterception(): Promise<void> {
    if (!this.#browser || !this.#shouldEnableDownloads()) {
      return;
    }
    this.#attachDownloadListeners(this.#browser);
    await this.#enableDownloads(this.#browser);
  }

  async syncFileChooserInterception(): Promise<void> {
    for (const mcpPage of this.#allMcpPages()) {
      await mcpPage.syncFileChooserInterception();
    }
  }

  getDownloads(
    options: {state?: DownloadState; limit?: number} = {},
  ): DownloadEntry[] {
    const entries: DownloadEntry[] = [];
    for (let i = this.#downloadOrder.length - 1; i >= 0; i--) {
      const entry = this.#downloads.get(this.#downloadOrder[i]);
      if (!entry) {
        continue;
      }
      if (options.state && entry.state !== options.state) {
        continue;
      }
      entries.push({...entry});
      if (options.limit !== undefined && entries.length >= options.limit) {
        break;
      }
    }
    return entries;
  }

  async waitForDownload(
    options: WaitForDownloadOptions = {},
  ): Promise<DownloadEntry> {
    await this.enableDownloads();
    const timeoutMs = options.timeoutMs ?? DEFAULT_DOWNLOAD_WAIT_TIMEOUT_MS;
    const includeExistingCompleted = options.includeExistingCompleted ?? true;
    const matchesMeta = (entry: DownloadEntry): boolean => {
      if (options.guid && entry.guid !== options.guid) {
        return false;
      }
      if (
        options.sinceTimestamp !== undefined &&
        entry.createdAt < options.sinceTimestamp
      ) {
        return false;
      }
      if (options.filenameRegex) {
        options.filenameRegex.lastIndex = 0;
        if (!options.filenameRegex.test(entry.suggestedFilename)) {
          return false;
        }
      }
      if (options.urlRegex) {
        options.urlRegex.lastIndex = 0;
        if (!options.urlRegex.test(entry.url)) {
          return false;
        }
      }
      return true;
    };

    const activeInProgressGuids = new Set<string>();
    for (let i = this.#downloadOrder.length - 1; i >= 0; i--) {
      const existing = this.#downloads.get(this.#downloadOrder[i]);
      if (!existing || !matchesMeta(existing)) {
        continue;
      }
      if (existing.state === 'completed' && includeExistingCompleted) {
        return {...existing};
      }
      if (existing.state === 'canceled' && options.guid) {
        throw new Error(
          `Download ${existing.guid} (${existing.suggestedFilename}) was canceled.`,
        );
      }
      if (existing.state === 'inProgress') {
        activeInProgressGuids.add(existing.guid);
      }
    }

    if (timeoutMs <= 0) {
      throw new TimeoutError(
        'Timed out waiting for download (timeoutMs <= 0 and no matching download completed).',
      );
    }

    return await new Promise<DownloadEntry>((resolve, reject) => {
      let settled = false;
      const waiter: DownloadWaiter = {
        matches: entry => {
          if (!matchesMeta(entry)) {
            return false;
          }
          if (entry.state === 'completed') {
            return true;
          }
          if (
            entry.state === 'canceled' &&
            (Boolean(options.guid) || activeInProgressGuids.has(entry.guid))
          ) {
            return true;
          }
          return false;
        },
        resolve: entry => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          this.#downloadWaiters.delete(waiter);
          if (entry.state === 'canceled') {
            reject(
              new Error(
                `Download ${entry.guid} (${entry.suggestedFilename}) was canceled.`,
              ),
            );
            return;
          }
          resolve({...entry});
        },
        reject: err => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          this.#downloadWaiters.delete(waiter);
          reject(err);
        },
      };

      const timer = setTimeout(() => {
        waiter.reject(
          new TimeoutError(
            `Timed out after ${timeoutMs}ms waiting for download` +
              `${options.guid ? ` (guid=${options.guid})` : ''}.`,
          ),
        );
      }, timeoutMs);

      this.#downloadWaiters.add(waiter);
    });
  }

  async rebindPageByTargetId(
    targetId: string,
    options: {previousPage?: ContextPage} = {},
  ): Promise<RebindPageResult> {
    const previousPage = options.previousPage
      ? this.#findPageById(options.previousPage.id)
      : undefined;
    if (previousPage) {
      previousPage.textSnapshot = null;
      previousPage.uniqueBackendNodeIdToMcpId.clear();
    }

    const pages = await this.createPagesSnapshot();
    const candidate = pages.find(page => {
      if (page.isClosed()) {
        return false;
      }
      try {
        return page.targetId === targetId;
      } catch {
        return false;
      }
    });

    if (candidate) {
      const recovery = await candidate.recoverDetachedFrame();
      if (recovery.recovered) {
        await candidate.init({emulateFocus: false});
        const shouldSelect =
          !this.#selectedPage ||
          this.#selectedPage === previousPage ||
          this.#selectedPage.isClosed();
        let selectedPageChanged = false;
        if (shouldSelect && this.#selectedPage !== candidate) {
          this.selectPage(candidate);
          selectedPageChanged = true;
        }
        return {
          recovered: true,
          targetId,
          page: candidate,
          frameId: recovery.frameId,
          url: recovery.url,
          pageSwapped: recovery.pageSwapped,
          selectedPageChanged,
        };
      }
    }

    return {
      recovered: false,
      targetId,
      fallbackPage:
        this.#selectedPage && !this.#selectedPage.isClosed()
          ? this.#selectedPage
          : undefined,
    };
  }

  #getBrowserConnection(browser: Browser): CdpSessionLike | undefined {
    try {
      // @ts-expect-error use existing browser connection (internal Puppeteer API).
      const candidate: unknown = browser._connection;
      return isCdpSessionLike(candidate) ? candidate : undefined;
    } catch {
      return undefined;
    }
  }

  async #ensureDownloadDir(): Promise<string> {
    if (this.#downloadDir) {
      return this.#downloadDir;
    }
    if (!this.#downloadDirPromise) {
      this.#downloadDirPromise = fs
        .mkdtemp(path.join(os.tmpdir(), 'chrome-devtools-mcp-downloads-'))
        .then(dir => {
          this.#downloadDir = dir;
          return dir;
        });
    }
    return await this.#downloadDirPromise;
  }

  #attachDownloadListeners(browser: Browser): void {
    const connection = this.#getBrowserConnection(browser);
    if (!connection || this.#downloadConnection === connection) {
      return;
    }
    this.#detachDownloadListeners();
    this.#downloadConnection = connection;
    connection.on('Browser.downloadWillBegin', this.#onDownloadWillBegin);
    connection.on('Browser.downloadProgress', this.#onDownloadProgress);
  }

  #detachDownloadListeners(): void {
    this.#downloadConnection?.off(
      'Browser.downloadWillBegin',
      this.#onDownloadWillBegin,
    );
    this.#downloadConnection?.off(
      'Browser.downloadProgress',
      this.#onDownloadProgress,
    );
    this.#downloadConnection = undefined;
  }

  async #enableDownloads(browser: Browser): Promise<void> {
    const connection = this.#getBrowserConnection(browser);
    if (!connection) {
      return;
    }
    try {
      const downloadDir = await this.#ensureDownloadDir();
      if (this.#browser !== browser) {
        return;
      }
      if (this.#downloadsConfiguredForBrowser !== browser) {
        await connection.send('Browser.setDownloadBehavior', {
          behavior: 'allowAndName',
          downloadPath: downloadDir,
          eventsEnabled: true,
        });
        this.#downloadsConfiguredForBrowser = browser;
      }
      const contextsToConfigure = new Set<BrowserContext>(
        this.#isolatedContexts.values(),
      );
      if (typeof browser.browserContexts === 'function') {
        const defaultCtx = browser.defaultBrowserContext?.();
        for (const ctx of browser.browserContexts()) {
          if (ctx !== defaultCtx && !ctx.closed) {
            contextsToConfigure.add(ctx);
          }
        }
      }
      for (const ctx of contextsToConfigure) {
        if (!ctx.closed) {
          await this.#configureDownloadBehaviorForContext(browser, ctx);
        }
      }
    } catch (err) {
      this.logger?.(
        `Failed to enable global download tracking: ${getErrorMessage(err)}`,
      );
    }
  }

  async #configureDownloadBehaviorForContext(
    browser: Browser,
    ctx: BrowserContext,
  ): Promise<void> {
    if (this.#configuredDownloadContexts.has(ctx) || !ctx.id) {
      return;
    }
    const connection = this.#getBrowserConnection(browser);
    if (!connection) {
      return;
    }
    try {
      const downloadDir = await this.#ensureDownloadDir();
      if (this.#browser !== browser || ctx.closed) {
        return;
      }
      await connection.send('Browser.setDownloadBehavior', {
        behavior: 'allowAndName',
        downloadPath: downloadDir,
        browserContextId: ctx.id,
        eventsEnabled: true,
      });
      this.#configuredDownloadContexts.add(ctx);
    } catch (err) {
      this.logger?.(
        `Failed to configure download behavior for context ${ctx.id}: ${getErrorMessage(err)}`,
      );
    }
  }

  #recordNewDownloadEntry(entry: DownloadEntry): void {
    this.#downloads.set(entry.guid, entry);
    this.#downloadOrder.push(entry.guid);
    while (this.#downloadOrder.length > MAX_DOWNLOAD_ENTRIES) {
      const evicted = this.#downloadOrder.shift();
      if (evicted !== undefined) {
        this.#downloads.delete(evicted);
      }
    }
  }

  #onDownloadWillBegin = (payload: unknown): void => {
    if (!isDownloadRecord(payload)) {
      return;
    }
    const guid = typeof payload.guid === 'string' ? payload.guid : undefined;
    const url = typeof payload.url === 'string' ? payload.url : undefined;
    const suggestedFilename =
      typeof payload.suggestedFilename === 'string'
        ? payload.suggestedFilename
        : undefined;
    const frameId =
      typeof payload.frameId === 'string' ? payload.frameId : undefined;
    if (!guid || url === undefined || suggestedFilename === undefined) {
      return;
    }
    const now = Date.now();
    const existing = this.#downloads.get(guid);
    if (existing) {
      existing.url = url;
      existing.suggestedFilename = suggestedFilename;
      existing.frameId = frameId ?? existing.frameId;
      existing.updatedAt = now;
      return;
    }
    this.#recordNewDownloadEntry({
      guid,
      url,
      suggestedFilename,
      state: 'inProgress',
      frameId,
      totalBytes: 0,
      receivedBytes: 0,
      createdAt: now,
      updatedAt: now,
    });
  };

  #onDownloadProgress = (payload: unknown): void => {
    if (!isDownloadRecord(payload)) {
      return;
    }
    const guid = typeof payload.guid === 'string' ? payload.guid : undefined;
    const state = parseDownloadState(payload.state);
    if (!guid || !state) {
      return;
    }
    const now = Date.now();
    let entry = this.#downloads.get(guid);
    if (!entry) {
      entry = {
        guid,
        url: '',
        suggestedFilename: guid,
        state,
        totalBytes: 0,
        receivedBytes: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.#recordNewDownloadEntry(entry);
    }
    if (typeof payload.totalBytes === 'number') {
      entry.totalBytes = payload.totalBytes;
    }
    if (typeof payload.receivedBytes === 'number') {
      entry.receivedBytes = payload.receivedBytes;
    }
    entry.state = state;
    entry.updatedAt = now;
    if (typeof payload.filePath === 'string' && payload.filePath.length > 0) {
      entry.filePath = payload.filePath;
    }
    if (state === 'completed' || state === 'canceled') {
      entry.completedAt = now;
      for (const waiter of Array.from(this.#downloadWaiters)) {
        if (waiter.matches(entry)) {
          waiter.resolve(entry);
        }
      }
    }
  };
}

function isDownloadRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parseDownloadState(value: unknown): DownloadState | undefined {
  if (value === 'inProgress' || value === 'completed' || value === 'canceled') {
    return value;
  }
  return undefined;
}
