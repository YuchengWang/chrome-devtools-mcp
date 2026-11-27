/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type AuthDefaultAction,
  type AuthPolicyAction,
  type DialogPolicyAction,
  type DialogTypeName,
  type NetworkMonitorsManager,
} from './config/NetworkMonitorsConfig.js';
import type {ReadonlyServerConfig} from './config/ServerConfig.js';
import {DevToolsCommentBridge} from './devtools/DevToolsCommentBridge.js';
import {
  createTargetUniverse,
  type TargetUniverse,
} from './devtools/DevtoolsUtils.js';
import {
  ConsoleCollector,
  NetworkCollector,
  type ListenerMap,
  type UncaughtError,
} from './collectors/PageCollector.js';
import {
  getPageCdpSession,
  isCdpSessionLike,
  RealtimeNetworkCollector,
  type CdpSessionLike,
  type NetworkAlertCategory,
  type NetworkAlertData,
  type NetworkAlertKind,
  type SseEventData,
  type WaitForNetworkResponseOptions,
  type WaitForNetworkResponseResult,
  type WebSocketConnectionInfo,
  type WebSocketStatus,
  type WsFrameData,
} from './collectors/RealtimeNetworkCollector.js';
import {LogpointManager} from './LogpointManager.js';
import type {Logpoint, LogpointOptions} from './utils/logpoint.js';
import {TextSnapshot} from './TextSnapshot.js';
import {
  NetworkOverrideManager,
  type NetworkOverride,
  type NetworkMockFilter,
  type NetworkMockInput,
} from './NetworkOverrideManager.js';
import {
  type Flags,
  type JSONSchema7Definition,
  lighthouseNavigation,
  lighthouseSnapshot,
  PredefinedNetworkConditions,
  type RunnerResult,
} from './third_party/index.js';
import {
  type CDPSession,
  type Locator,
  type Dialog,
  type ElementHandle,
  type Frame,
  type Viewport,
  type WebMCPTool,
  type Protocol,
  type Page,
  type Target,
  type ConsoleMessage,
  type HTTPRequest,
  DevTools,
  TimeoutError,
} from './third_party/browser.js';
import type {ToolGroups} from './tools/thirdPartyDeveloper.js';
import type {
  ContextPage,
  DevToolsData,
  ElementCssStyles,
  Response,
  ScreenRecorderData,
  WebAuthnAuthenticatorConfig,
  WebAuthnAuthenticatorState,
} from './tools/ToolDefinition.js';
import type {
  EmulationSettings,
  ForcedColors,
  GeolocationOptions,
  PrefersContrast,
  PrefersReducedMotion,
  TextSnapshotNode,
} from './types.js';
import {
  getErrorMessage,
  isDetachedNavigationError,
} from './utils/errorHandling.js';
import {logger} from './utils/logger.js';
import {RingBuffer, type RingBufferQueryResult} from './utils/RingBuffer.js';
import {
  getNetworkMultiplierFromString,
  WaitForHelper,
  type WaitForEventsResult,
  type DialogAction,
} from './utils/WaitForHelper.js';

const WEBAUTHN_PROTOCOLS = {
  ctap2: DevTools.Protocol.WebAuthn.AuthenticatorProtocol.Ctap2,
  u2f: DevTools.Protocol.WebAuthn.AuthenticatorProtocol.U2f,
};

const WEBAUTHN_TRANSPORTS = {
  internal: DevTools.Protocol.WebAuthn.AuthenticatorTransport.Internal,
  usb: DevTools.Protocol.WebAuthn.AuthenticatorTransport.Usb,
  nfc: DevTools.Protocol.WebAuthn.AuthenticatorTransport.Nfc,
  ble: DevTools.Protocol.WebAuthn.AuthenticatorTransport.Ble,
  hybrid: DevTools.Protocol.WebAuthn.AuthenticatorTransport.Hybrid,
};

interface WebAuthnAuthenticator {
  id: DevTools.Protocol.WebAuthn.AuthenticatorId;
  options: Omit<WebAuthnAuthenticatorState, 'credentials'>;
}

const WEBAUTHN_CREATION_OPTIONS = [
  'protocol',
  'transport',
  'hasResidentKey',
  'hasUserVerification',
] as const;

export function replaceHtmlElementsWithUids(
  schema: JSONSchema7Definition,
): void {
  if (typeof schema === 'boolean') {
    return;
  }

  let isHtmlElement = false;
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'x-mcp-type' && value === 'HTMLElement') {
      isHtmlElement = true;
      break;
    }
  }

  if (isHtmlElement) {
    schema.properties = {uid: {type: 'string'}};
    schema.required = ['uid'];
  }

  if (schema.properties) {
    for (const key of Object.keys(schema.properties)) {
      replaceHtmlElementsWithUids(schema.properties[key]);
    }
  }

  if (schema.items) {
    if (Array.isArray(schema.items)) {
      for (const item of schema.items) {
        replaceHtmlElementsWithUids(item);
      }
    } else {
      replaceHtmlElementsWithUids(schema.items);
    }
  }

  if (schema.anyOf) {
    for (const s of schema.anyOf) {
      replaceHtmlElementsWithUids(s);
    }
  }
  if (schema.allOf) {
    for (const s of schema.allOf) {
      replaceHtmlElementsWithUids(s);
    }
  }
  if (schema.oneOf) {
    for (const s of schema.oneOf) {
      replaceHtmlElementsWithUids(s);
    }
  }
}

function isDebuggingWebMcpTool(tool: WebMCPTool): boolean {
  return Boolean(
    tool.annotations &&
    'debugging' in tool.annotations &&
    tool.annotations.debugging === true,
  );
}

const DEFAULT_TIMEOUT = 5_000;
const NAVIGATION_TIMEOUT = 10_000;
const DEVTOOLS_UNIVERSE_TIMEOUT_MS = 5_000;

/**
 * Chrome reports a URL-derived placeholder as the target title until the
 * document provides one. The placeholder omits the `http://` / `https://`
 * scheme and the trailing slash of a bare hostname.
 */
function isPlaceholderTitle(title: string, url: string): boolean {
  if (title === url) {
    return true;
  }
  const withoutScheme = url.replace(/^https?:\/\//, '');
  return title === withoutScheme || title === withoutScheme.replace(/\/$/, '');
}

function isBackendNodeId(
  id: unknown,
): id is DevTools.Protocol.DOM.BackendNodeId {
  return typeof id === 'number';
}

const MAX_DIALOG_SLOTS = 32;
const MAX_FILE_CHOOSER_SLOTS = 16;
const MAX_AUTH_HISTORY = 100;
const MAX_ATTEMPTED_AUTH_IDS = 500;
const DEFAULT_DIALOG_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_DOM_WAIT_TIMEOUT_MS = 10_000;
const DEFAULT_DOM_POLL_INTERVAL_MS = 100;
const AUTH_FETCH_PATTERNS = [
  {urlPattern: 'http://*'},
  {urlPattern: 'https://*'},
];

export interface DialogQueueEntry {
  id: number;
  index: number;
  dialog: Dialog;
  type: Protocol.Page.DialogType;
  message: string;
  defaultValue: string;
  createdAt: number;
}

export interface WaitForDialogOptions {
  type?: Protocol.Page.DialogType;
  messageRegex?: RegExp;
  timeoutMs?: number;
}

export interface WaitForDialogResult {
  id: number;
  type: Protocol.Page.DialogType;
  message: string;
  defaultValue: string;
  queueLength: number;
  autoHandled: boolean;
  autoAction?: DialogPolicyAction;
}

export interface PendingFileChooserInfo {
  id: number;
  frameId: string;
  mode: 'selectSingle' | 'selectMultiple';
  backendNodeId?: number;
  createdAt: number;
}

export interface HandleFileChooserOptions {
  action: 'accept' | 'cancel' | 'list' | 'enable' | 'disable';
  index?: number;
  filePaths?: string[];
}

export interface HandleFileChooserResult {
  action: 'accept' | 'cancel' | 'list' | 'enable' | 'disable';
  interceptionEnabled?: boolean;
  handled?: PendingFileChooserInfo;
  pending: PendingFileChooserInfo[];
}

export interface AuthChallengeInfo {
  challengeId: string;
  requestId: string;
  url: string;
  method: string;
  resourceType: string;
  frameId: string;
  source: string;
  origin: string;
  scheme: string;
  realm: string;
  createdAt: number;
  status: 'pending' | 'provided' | 'canceled' | 'default';
  resolvedAt?: number;
}

export interface HandleAuthChallengeOptions {
  action: 'provide' | 'cancel' | 'default' | 'list' | 'set_policy';
  challengeId?: string;
  username?: string;
  password?: string;
  defaultAction?: AuthDefaultAction;
  originRegex?: RegExp;
  urlRegex?: RegExp;
  realmRegex?: RegExp;
  source?: 'Server' | 'Proxy';
  queueTimeoutMs?: number;
}

export interface HandleAuthChallengeResult {
  action: HandleAuthChallengeOptions['action'];
  resolved?: AuthChallengeInfo;
  pending: AuthChallengeInfo[];
  history: AuthChallengeInfo[];
  defaultAction: AuthDefaultAction;
}

export type WaitForDomState = 'visible' | 'hidden' | 'attached' | 'detached';

export interface WaitForDomOptions {
  selector: string;
  state?: WaitForDomState;
  frameId?: string;
  text?: string;
  textRegex?: RegExp;
  attributeName?: string;
  attributeValue?: string;
  timeoutMs?: number;
  pollIntervalMs?: number;
}

export interface WaitForDomResult {
  matched: boolean;
  selector: string;
  state: WaitForDomState;
  frameId: string;
  count: number;
  visibleCount: number;
  tagName?: string;
  textPreview?: string;
  elapsedMs: number;
}

export interface DetachedFrameRecoveryResult {
  recovered: boolean;
  targetId: string;
  frameId?: string;
  url?: string;
  pageSwapped?: boolean;
}

interface InternalDialogEntry {
  id: number;
  dialog: Dialog;
  type: Protocol.Page.DialogType;
  message: string;
  defaultValue: string;
  createdAt: number;
}

interface DialogWaiter {
  type?: Protocol.Page.DialogType;
  messageRegex?: RegExp;
  resolve: (result: WaitForDialogResult) => void;
  reject: (error: Error) => void;
}

interface PendingAuthEntry {
  info: AuthChallengeInfo;
  session: CdpSessionLike;
  timer?: ReturnType<typeof setTimeout>;
}

interface RuntimeAuthRule {
  originRegex?: RegExp;
  urlRegex?: RegExp;
  realmRegex?: RegExp;
  source?: 'Server' | 'Proxy';
  action: AuthPolicyAction;
  username?: string;
  password?: string;
}

function getFrameId(frame: Frame): string | undefined {
  if ('_id' in frame && typeof frame._id === 'string') {
    return frame._id;
  }
  return undefined;
}

function getFrameCdpSession(frame: Frame): CdpSessionLike | undefined {
  if ('client' in frame && isCdpSessionLike(frame.client)) {
    return frame.client;
  }
  if ('_client' in frame && typeof frame._client === 'function') {
    const client: unknown = frame._client();
    return isCdpSessionLike(client) ? client : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function isDialogTypeName(value: string): value is DialogTypeName {
  return (
    value === 'alert' ||
    value === 'confirm' ||
    value === 'prompt' ||
    value === 'beforeunload'
  );
}

/**
 * Per-page state wrapper. Consolidates dialog, snapshot, emulation,
 * and metadata that were previously scattered across Maps in McpContext.
 *
 * Internal class consumed only by McpContext. Fields are public for direct
 * read/write access. The dialog queue is private because it requires an
 * event listener lifecycle managed by the init/dispose pair.
 */
export class McpPage implements ContextPage {
  readonly target: Target;
  readonly id: number;

  #pptrPage?: Page;
  #initPromise?: Promise<void>;
  #focusEmulationRequested = false;
  #disposed = false;
  #closed = false;

  // Snapshot
  textSnapshot: TextSnapshot | null = null;
  uniqueBackendNodeIdToMcpId: Map<string, string> = new Map<string, string>();
  extraHandles: ElementHandle[] = [];

  // Emulation
  emulationSettings: EmulationSettings = {};

  // Metadata
  isolatedContextName?: string;
  #devtoolsUniverse?: TargetUniverse;
  #devtoolsUniversePromise?: Promise<TargetUniverse | undefined>;
  #webAuthnEnabled = false;
  #webAuthnAuthenticator?: WebAuthnAuthenticator;

  // Logpoints, created on first use.
  #logpointManager?: LogpointManager;

  // Multi-slot dialog queue
  #dialogs: InternalDialogEntry[] = [];
  #nextDialogId = 1;
  #dialogWaiters = new Set<DialogWaiter>();
  #explicitDialogActionDepth = 0;
  #dialogHandler: (dialog: Dialog) => void;

  // FileChooser interception queue
  #pendingFileChoosers: PendingFileChooserInfo[] = [];
  #nextFileChooserId = 1;
  #nativeFileChooserDepth = 0;
  #explicitFileChooserInterception?: boolean;
  #fileChooserInterceptEnabled = false;
  #fileChooserSession?: CdpSessionLike;

  // Auth challenge management (Fetch.authRequired)
  #authSession?: CDPSession;
  #authFallbackSession?: CdpSessionLike;
  #authFetchEnabled = false;
  #authFetchSuppressedCount = 0;
  #pendingAuthChallenges = new Map<string, PendingAuthEntry>();
  #authHistory = new RingBuffer<AuthChallengeInfo>(MAX_AUTH_HISTORY);
  #attemptedAuthRequestIds = new Set<string>();
  #nextAuthId = 1;
  #runtimeAuthDefaultAction?: AuthDefaultAction;
  #runtimeAuthQueueTimeoutMs?: number;
  #runtimeAuthRules: RuntimeAuthRule[] = [];

  // Screencast
  #screenRecorder: ScreenRecorderData | null = null;

  // Performance trace
  #isRunningPerformanceTrace = false;

  #networkCollector?: NetworkCollector;
  #consoleCollector?: ConsoleCollector;
  #realtimeNetworkCollector?: RealtimeNetworkCollector;

  #locatorClass: typeof Locator;
  #navigationTimeout: number;
  #config: ReadonlyServerConfig;
  #monitorsManager?: NetworkMonitorsManager;
  #monitorsUnsubscribe?: () => void;
  #commentBridge?: DevToolsCommentBridge;
  #networkOverrideManager?: NetworkOverrideManager;

  constructor(
    target: Target,
    id: number,
    options: {
      config: ReadonlyServerConfig;
      locatorClass: typeof Locator;
      isolatedContextName?: string;
      navigationTimeout?: number;
      monitorsManager?: NetworkMonitorsManager;
    },
  ) {
    this.#config = options.config;
    this.#locatorClass = options.locatorClass;
    this.#navigationTimeout = options.navigationTimeout ?? NAVIGATION_TIMEOUT;
    this.#monitorsManager = options.monitorsManager;
    this.target = target;
    this.id = id;
    this.isolatedContextName = options.isolatedContextName;
    this.#dialogHandler = (dialog: Dialog): void => {
      this.#handleIncomingDialog(dialog);
    };
  }

  get #hasNetworkBlockOrAllowlist(): boolean {
    return Boolean(
      this.#config.resolved.allowedUrlPattern ||
      this.#config.resolved.blockedUrlPattern,
    );
  }

  get pptrPage(): Page {
    if (!this.#pptrPage) {
      throw new Error(
        `McpPage (id=${this.id}) is not initialized. Call init() first.`,
      );
    }
    return this.#pptrPage;
  }

  get networkCollector(): NetworkCollector {
    if (!this.#networkCollector) {
      throw new Error(
        `McpPage (id=${this.id}) is not initialized. Call init() first.`,
      );
    }
    return this.#networkCollector;
  }

  set networkCollector(collector: NetworkCollector) {
    this.#networkCollector = collector;
  }

  get consoleCollector(): ConsoleCollector {
    if (!this.#consoleCollector) {
      throw new Error(
        `McpPage (id=${this.id}) is not initialized. Call init() first.`,
      );
    }
    return this.#consoleCollector;
  }

  url(): string {
    return this.#pptrPage?.url() ?? this.target.url();
  }

  get targetId(): string {
    // @ts-expect-error internal types
    const info: Protocol.Target.TargetInfo = this.target._getTargetInfo();
    return info.targetId;
  }

  /**
   * Returns the page title or an empty string if the target only has Chrome's
   * URL-based placeholder title.
   *
   * Puppeteer's cached target info is only refreshed by
   * `Target.targetInfoChanged`, which Chrome emits on navigation commit (before
   * the document title is known) but not on title changes. Callers should pass
   * fresh target info (e.g., from `Target.getTargets`) when available.
   */
  getTitle(freshTargetInfo?: Protocol.Target.TargetInfo): string {
    // @ts-expect-error internal types
    const cachedInfo: Protocol.Target.TargetInfo = this.target._getTargetInfo();
    const info = freshTargetInfo ?? cachedInfo;
    return isPlaceholderTitle(info.title, info.url) ? '' : info.title;
  }

  isClosed(): boolean {
    if (this.#closed) {
      return true;
    }
    if (this.#pptrPage) {
      return this.#pptrPage.isClosed();
    }
    return this.#disposed;
  }

  async close(): Promise<void> {
    this.#closed = true;
    const page =
      this.#pptrPage ??
      (await this.target.page()) ??
      (await this.target.asPage());
    this.dispose();
    await page?.close({runBeforeUnload: false});
  }

  async init(options?: {emulateFocus?: boolean}): Promise<void> {
    if (this.#disposed) {
      throw new Error(`McpPage (id=${this.id}) has already been disposed.`);
    }
    if (!this.#initPromise) {
      this.#initPromise = this.#doInit().catch(err => {
        this.#initPromise = undefined;
        throw err;
      });
    }
    await this.#initPromise;
    // Discovery skips focus emulation, but a later page tool still needs it.
    if (
      options?.emulateFocus !== false &&
      !this.#disposed &&
      !this.#focusEmulationRequested
    ) {
      // Prevent duplicate requests while pending and after success.
      this.#focusEmulationRequested = true;
      this.#initFocusEmulationNoThrow();
    }
  }

  async #doInit(): Promise<void> {
    if (!this.#pptrPage) {
      const page = (await this.target.page()) ?? (await this.target.asPage());
      if (!page) {
        throw new Error(
          `Failed to initialize Puppeteer Page for target ${this.target.url()}`,
        );
      }
      if (this.#disposed) {
        return;
      }
      this.#pptrPage = page;
      this.#networkOverrideManager = new NetworkOverrideManager(
        page,
        this.#config,
      );
      page.on('dialog', this.#dialogHandler);
      page.on('framenavigated', this.#onFrameNavigatedSync);
      this.#networkCollector = new NetworkCollector(page, {
        maxNavigationSaved: this.#config.resolved.maxNavigationSaved,
      });
      this.#consoleCollector = new ConsoleCollector(
        page,
        collect => {
          return {
            console: event => {
              collect(event);
            },
            uncaughtError: event => {
              collect(event);
            },
            devtoolsAggregatedIssue: event => {
              collect(event);
            },
          };
        },
        {maxNavigationSaved: this.#config.resolved.maxNavigationSaved},
      );
      this.#realtimeNetworkCollector = new RealtimeNetworkCollector(page, {
        monitorsManager: this.#monitorsManager,
        redactNetworkHeaders: () => this.#config.resolved.redactNetworkHeaders,
      });
    }
    if (this.#monitorsManager && !this.#monitorsUnsubscribe) {
      this.#monitorsUnsubscribe = this.#monitorsManager.onConfigChange(() => {
        void this.syncFileChooserInterception();
        void this.#syncAuthInterception();
      });
    }
    this.updateTimeouts();
    await Promise.all([
      this.syncFileChooserInterception(),
      this.#syncAuthInterception(),
    ]);
    if (this.#disposed) {
      this.dispose();
    }
  }

  #onFrameNavigatedSync = (): void => {
    if (this.#shouldInterceptFileChooser()) {
      this.#fileChooserInterceptEnabled = false;
      void this.syncFileChooserInterception();
    }
    this.#syncAuthFallbackSession();
  };

  #shouldInterceptFileChooser(): boolean {
    if (this.#disposed || this.#nativeFileChooserDepth > 0) {
      return false;
    }
    if (this.#explicitFileChooserInterception !== undefined) {
      return this.#explicitFileChooserInterception;
    }
    return Boolean(
      this.#monitorsManager?.getConfig().interceptFileChooser ||
      this.#config.resolved.interceptFileChooser,
    );
  }

  async syncFileChooserInterception(): Promise<void> {
    if (!this.#pptrPage || this.#disposed) {
      return;
    }
    const desired = this.#shouldInterceptFileChooser();
    if (!desired) {
      if (this.#fileChooserInterceptEnabled) {
        const session =
          this.#fileChooserSession ?? getPageCdpSession(this.#pptrPage);
        this.#fileChooserInterceptEnabled = false;
        if (session) {
          try {
            await session.send('Page.setInterceptFileChooserDialog', {
              enabled: false,
            });
          } catch (error) {
            logger?.('Failed to disable file chooser interception', error);
          }
        }
      }
      return;
    }
    const session = getPageCdpSession(this.#pptrPage);
    if (!session) {
      return;
    }
    if (this.#fileChooserSession !== session) {
      this.#fileChooserSession?.off(
        'Page.fileChooserOpened',
        this.#onFileChooserOpened,
      );
      this.#fileChooserSession = session;
      session.on('Page.fileChooserOpened', this.#onFileChooserOpened);
      this.#fileChooserInterceptEnabled = false;
    }
    if (this.#fileChooserInterceptEnabled) {
      return;
    }
    try {
      await session.send('Page.setInterceptFileChooserDialog', {enabled: true});
      if (!this.#disposed && this.#shouldInterceptFileChooser()) {
        this.#fileChooserInterceptEnabled = true;
      }
    } catch (error) {
      logger?.('Failed to enable file chooser interception', error);
    }
  }

  #desiredAuthFetchEnabled(): boolean {
    if (
      this.#disposed ||
      this.#isRunningPerformanceTrace ||
      this.#authFetchSuppressedCount > 0
    ) {
      return false;
    }
    return (
      this.#runtimeAuthDefaultAction !== undefined ||
      this.#runtimeAuthRules.length > 0 ||
      this.#monitorsManager?.getConfig().autoAuthPolicy !== undefined
    );
  }

  #syncAuthFallbackSession(): void {
    if (
      !this.#pptrPage ||
      this.#disposed ||
      this.#authSession ||
      !this.#desiredAuthFetchEnabled()
    ) {
      return;
    }
    const session = getPageCdpSession(this.#pptrPage);
    if (!session || session === this.#authFallbackSession) {
      return;
    }
    this.#authFallbackSession?.off(
      'Fetch.authRequired',
      this.#onFallbackAuthRequired,
    );
    this.#authFallbackSession = session;
    session.on('Fetch.authRequired', this.#onFallbackAuthRequired);
  }

  async #createAuthSessionNoThrow(): Promise<void> {
    if (!this.#pptrPage || this.#disposed || this.#authSession) {
      return;
    }
    try {
      const session = await this.#pptrPage.createCDPSession();
      if (this.#disposed) {
        if (session && session !== this.#devtoolsUniverse?.session) {
          void session.detach().catch(() => {});
        }
        return;
      }
      if (isCdpSessionLike(session)) {
        this.#authSession = session;
        session.on('Fetch.requestPaused', this.#onAuthSessionRequestPaused);
        session.on('Fetch.authRequired', this.#onAuthSessionAuthRequired);
      }
    } catch (error) {
      logger?.('Failed to initialize dedicated Fetch auth session', error);
    }
  }

  async #syncAuthInterception(): Promise<void> {
    if (!this.#pptrPage || this.#disposed) {
      return;
    }
    if (!this.#desiredAuthFetchEnabled()) {
      if (this.#authSession && this.#authFetchEnabled) {
        await this.#setAuthFetchEnabled(false);
      }
      return;
    }
    if (!this.#authSession) {
      await this.#createAuthSessionNoThrow();
    }
    if (!this.#desiredAuthFetchEnabled()) {
      return;
    }
    if (this.#authSession) {
      if (!this.#authFetchEnabled) {
        await this.#setAuthFetchEnabled(true);
      }
    } else {
      this.#syncAuthFallbackSession();
    }
  }

  async #setAuthFetchEnabled(enabled: boolean): Promise<void> {
    const session = this.#authSession;
    if (!session || (enabled && this.#disposed)) {
      return;
    }
    if (enabled === this.#authFetchEnabled) {
      return;
    }
    try {
      if (enabled) {
        await session.send('Fetch.enable', {
          handleAuthRequests: true,
          patterns: AUTH_FETCH_PATTERNS,
        });
        if (!this.#disposed && this.#desiredAuthFetchEnabled()) {
          this.#authFetchEnabled = true;
        } else {
          this.#authFetchEnabled = false;
          await session.send('Fetch.disable').catch(() => {});
        }
      } else {
        this.#authFetchEnabled = false;
        await session.send('Fetch.disable');
      }
    } catch (error) {
      logger?.(`Failed to ${enabled ? 'enable' : 'disable'} Fetch auth`, error);
    }
  }

  #initFocusEmulationNoThrow(): void {
    // Background pages need emulated focus for multi-agent workflows.
    void this.pptrPage.emulateFocusedPage(true).catch(error => {
      // Allow the next page operation to retry a transient failure.
      this.#focusEmulationRequested = false;
      logger?.('Error turning on focused page emulation', error);
    });
  }

  async ensureDevToolsUniverse(): Promise<TargetUniverse | undefined> {
    if (this.devtoolsUniverse) {
      return this.devtoolsUniverse;
    }
    if (this.#disposed || this.#closed) {
      return undefined;
    }
    if (!this.#devtoolsUniversePromise) {
      this.#devtoolsUniversePromise = (async () => {
        let session:
          | Awaited<ReturnType<typeof this.pptrPage.createCDPSession>>
          | undefined;
        try {
          session = await this.pptrPage.createCDPSession();
          if (this.#disposed || this.#closed) {
            void session.detach().catch(() => {});
            return undefined;
          }
          const universe = await createTargetUniverse(session, {
            sourceMaps: this.#config.resolved.sourceMaps,
          });
          if (this.#disposed || this.#closed) {
            universe.universe.dispose();
            void session.detach().catch(() => {});
            return undefined;
          }
          this.#devtoolsUniverse = universe;
          return this.#devtoolsUniverse;
        } catch (e) {
          void session?.detach().catch(() => {});
          logger?.('Failed to initialize DevTools universe', e);
          return undefined;
        } finally {
          this.#devtoolsUniversePromise = undefined;
        }
      })();
    }
    return await this.#devtoolsUniversePromise;
  }

  syncSourceMaps(): void {
    if (!this.#devtoolsUniverse) {
      return;
    }
    const sourceMaps = this.#config.resolved.sourceMaps;
    this.#devtoolsUniverse.universe.settings
      .resolve(DevTools.SDKSettings.jsSourceMapsEnabledSettingDescriptor)
      .set(sourceMaps);
    this.#devtoolsUniverse.universe.settings
      .resolve(DevTools.SDKSettings.cssSourceMapsEnabledSettingDescriptor)
      .set(sourceMaps);
  }

  get devtoolsUniverse(): TargetUniverse | undefined {
    return this.#devtoolsUniverse;
  }

  /**
   * Makes the given logpoints the complete set of logpoints on the page, see
   * {@link LogpointManager.setLogpoints}. The manager is created on first
   * use, so an empty list on a page without logpoints is a no-op.
   */
  async setLogpoints(logpoints: LogpointOptions[]): Promise<Logpoint[]> {
    if (!this.#logpointManager) {
      if (logpoints.length === 0) {
        return [];
      }
      const devtoolsUniverse = await this.ensureDevToolsUniverse();
      if (!devtoolsUniverse) {
        throw new Error(
          `DevTools universe is not available for page ${this.id ?? '?'}.`,
        );
      }
      this.#logpointManager = new LogpointManager(devtoolsUniverse);
    }
    return await this.#logpointManager.setLogpoints(logpoints);
  }

  getWebAuthnAuthenticator():
    Omit<WebAuthnAuthenticatorState, 'credentials'> | undefined {
    return (
      this.#webAuthnAuthenticator && {
        ...this.#webAuthnAuthenticator.options,
      }
    );
  }

  async configureWebAuthn(
    config: WebAuthnAuthenticatorConfig,
  ): Promise<WebAuthnAuthenticatorState | undefined> {
    const devtoolsUniverse = await this.ensureDevToolsUniverse();
    const model = devtoolsUniverse?.target.model(
      DevTools.WebAuthnModel.WebAuthnModel,
    );
    if (!model) {
      throw new Error(`WebAuthn is not available for page ${this.id}.`);
    }
    const options = config.enabled
      ? this.#resolveWebAuthnOptions(config)
      : undefined;
    try {
      return await this.#applyWebAuthnConfig(model, options);
    } catch (error) {
      const orphan = this.#webAuthnAuthenticator;
      this.#webAuthnEnabled = false;
      this.#webAuthnAuthenticator = undefined;
      if (orphan) {
        try {
          await model.removeAuthenticator(orphan.id);
        } catch {
          // Already gone, e.g. another client disabled the environment.
        }
      }
      throw new Error(
        `Failed to configure WebAuthn for page ${this.id}: ${getErrorMessage(error)}`,
        {cause: error},
      );
    }
  }

  #resolveWebAuthnOptions(
    config: WebAuthnAuthenticatorConfig,
  ): WebAuthnAuthenticator['options'] {
    const current = this.#webAuthnAuthenticator?.options;
    const protocol = config.protocol ?? current?.protocol ?? 'ctap2';
    const transport = config.transport ?? current?.transport ?? 'internal';
    const isUserVerified =
      config.isUserVerified ?? current?.isUserVerified ?? true;
    if (protocol === 'u2f') {
      if (config.hasResidentKey || config.hasUserVerification) {
        throw new Error(
          `protocol 'u2f' does not support hasResidentKey or hasUserVerification. Set them to false or omit them.`,
        );
      }
      return {
        protocol,
        transport,
        hasResidentKey: false,
        hasUserVerification: false,
        isUserVerified,
      };
    }
    return {
      protocol,
      transport,
      hasResidentKey: config.hasResidentKey ?? current?.hasResidentKey ?? true,
      hasUserVerification:
        config.hasUserVerification ?? current?.hasUserVerification ?? true,
      isUserVerified,
    };
  }

  async #applyWebAuthnConfig(
    model: DevTools.WebAuthnModel.WebAuthnModel,
    options: WebAuthnAuthenticator['options'] | undefined,
  ): Promise<WebAuthnAuthenticatorState | undefined> {
    if (!options) {
      this.#webAuthnAuthenticator = undefined;
      this.#webAuthnEnabled = false;
      await model.setVirtualAuthEnvEnabled(false);
      return undefined;
    }
    if (!this.#webAuthnEnabled) {
      await model.setVirtualAuthEnvEnabled(true, false);
      this.#webAuthnEnabled = true;
    }

    const current = this.#webAuthnAuthenticator;
    let authenticator = current;
    if (
      !authenticator ||
      WEBAUTHN_CREATION_OPTIONS.some(
        key => options[key] !== authenticator?.options[key],
      )
    ) {
      if (authenticator) {
        await model.removeAuthenticator(authenticator.id);
        this.#webAuthnAuthenticator = undefined;
      }
      const id = await model.addAuthenticator({
        ...options,
        protocol: WEBAUTHN_PROTOCOLS[options.protocol],
        transport: WEBAUTHN_TRANSPORTS[options.transport],
        automaticPresenceSimulation: true,
      });
      authenticator = {id, options};
      this.#webAuthnAuthenticator = authenticator;
    } else if (
      options.isUserVerified !== authenticator.options.isUserVerified
    ) {
      await model.setUserVerified(authenticator.id, options.isUserVerified);
      authenticator.options.isUserVerified = options.isUserVerified;
    }

    const credentials = await model.getCredentials(authenticator.id);
    return {
      ...authenticator.options,
      credentials: credentials.map(credential => ({
        credentialId: credential.credentialId,
        rpId: credential.rpId,
        isResidentCredential: credential.isResidentCredential,
        userName: credential.userName,
        signCount: credential.signCount,
      })),
    };
  }

  #pruneHandledDialogs(): boolean {
    const before = this.#dialogs.length;
    if (before === 0) {
      return false;
    }
    this.#dialogs = this.#dialogs.filter(entry => !entry.dialog.handled);
    return this.#dialogs.length !== before;
  }

  #notifyDialogWaiters(
    entry: InternalDialogEntry,
    autoHandled: boolean,
    autoAction?: DialogPolicyAction,
  ): void {
    for (const waiter of this.#dialogWaiters) {
      if (waiter.type && waiter.type !== entry.type) {
        continue;
      }
      if (waiter.messageRegex) {
        waiter.messageRegex.lastIndex = 0;
        if (!waiter.messageRegex.test(entry.message)) {
          continue;
        }
      }
      this.#dialogWaiters.delete(waiter);
      waiter.resolve({
        id: entry.id,
        type: entry.type,
        message: entry.message,
        defaultValue: entry.defaultValue,
        queueLength: this.#dialogs.length,
        autoHandled,
        autoAction,
      });
    }
  }

  #handleIncomingDialog(dialog: Dialog): void {
    this.#pruneHandledDialogs();
    const type = dialog.type();
    const message = dialog.message();
    const defaultValue = dialog.defaultValue?.() ?? '';
    const entry: InternalDialogEntry = {
      id: this.#nextDialogId++,
      dialog,
      type,
      message,
      defaultValue,
      createdAt: Date.now(),
    };

    if (this.#explicitDialogActionDepth === 0 && this.#monitorsManager) {
      const dialogType: DialogTypeName = isDialogTypeName(type)
        ? type
        : 'alert';
      const decision = this.#monitorsManager.resolveDialogAction({
        type: dialogType,
        message,
        url: this.url(),
        defaultValue,
      });
      if (decision.action === 'accept') {
        void Promise.resolve(
          dialog.accept(
            dialogType === 'prompt'
              ? (decision.promptText ?? defaultValue)
              : undefined,
          ),
        ).catch(error => {
          logger?.('Failed auto-accepting dialog', error);
        });
        this.#notifyDialogWaiters(entry, true, 'accept');
        return;
      }
      if (decision.action === 'dismiss') {
        void Promise.resolve(dialog.dismiss()).catch(error => {
          logger?.('Failed auto-dismissing dialog', error);
        });
        this.#notifyDialogWaiters(entry, true, 'dismiss');
        return;
      }
    }

    this.#dialogs.push(entry);
    if (this.#dialogs.length > MAX_DIALOG_SLOTS) {
      this.#dialogs.shift();
    }
    this.#notifyDialogWaiters(entry, false);
  }

  getDialog(): Dialog | undefined {
    this.#pruneHandledDialogs();
    return this.#dialogs[0]?.dialog;
  }

  getDialogs(): DialogQueueEntry[] {
    this.#pruneHandledDialogs();
    return this.#dialogs.map((entry, index) => ({
      id: entry.id,
      index,
      dialog: entry.dialog,
      type: entry.type,
      message: entry.message,
      defaultValue: entry.defaultValue,
      createdAt: entry.createdAt,
    }));
  }

  clearDialog(dialog?: Dialog): void {
    const pruned = this.#pruneHandledDialogs();
    if (dialog) {
      this.#dialogs = this.#dialogs.filter(entry => entry.dialog !== dialog);
      return;
    }
    if (!pruned && this.#dialogs.length > 0) {
      this.#dialogs.shift();
    }
  }

  async waitForDialog(
    options: WaitForDialogOptions = {},
  ): Promise<WaitForDialogResult> {
    if (this.#disposed) {
      throw new Error(`McpPage (id=${this.id}) has already been disposed.`);
    }
    this.#pruneHandledDialogs();
    for (const entry of this.#dialogs) {
      if (options.type && entry.type !== options.type) {
        continue;
      }
      if (options.messageRegex) {
        options.messageRegex.lastIndex = 0;
        if (!options.messageRegex.test(entry.message)) {
          continue;
        }
      }
      return {
        id: entry.id,
        type: entry.type,
        message: entry.message,
        defaultValue: entry.defaultValue,
        queueLength: this.#dialogs.length,
        autoHandled: false,
      };
    }

    const timeoutMs = options.timeoutMs ?? DEFAULT_DIALOG_WAIT_TIMEOUT_MS;
    return await new Promise<WaitForDialogResult>((resolve, reject) => {
      const waiter: DialogWaiter = {
        type: options.type,
        messageRegex: options.messageRegex,
        resolve: res => {
          clearTimeout(timer);
          resolve(res);
        },
        reject: err => {
          clearTimeout(timer);
          reject(err);
        },
      };
      const timer = setTimeout(() => {
        this.#dialogWaiters.delete(waiter);
        reject(
          new TimeoutError(
            `Timed out after ${timeoutMs}ms waiting for dialog${options.type ? ` of type "${options.type}"` : ''}.`,
          ),
        );
      }, timeoutMs);
      timer.unref?.();
      this.#dialogWaiters.add(waiter);
    });
  }

  #onFileChooserOpened = (payload: unknown): void => {
    if (this.#nativeFileChooserDepth > 0 || !isRecord(payload)) {
      return;
    }
    const frameId = asString(payload['frameId']) ?? '';
    const rawMode = asString(payload['mode']);
    const mode: 'selectSingle' | 'selectMultiple' =
      rawMode === 'selectMultiple' ? 'selectMultiple' : 'selectSingle';
    const backendNodeId = asNumber(payload['backendNodeId']);
    this.#pendingFileChoosers.push({
      id: this.#nextFileChooserId++,
      frameId,
      mode,
      backendNodeId,
      createdAt: Date.now(),
    });
    if (this.#pendingFileChoosers.length > MAX_FILE_CHOOSER_SLOTS) {
      this.#pendingFileChoosers.shift();
    }
  };

  async withNativeFileChooser<T>(fn: () => Promise<T>): Promise<T> {
    this.#nativeFileChooserDepth++;
    this.#fileChooserInterceptEnabled = false;
    try {
      return await fn();
    } finally {
      this.#nativeFileChooserDepth--;
      await this.syncFileChooserInterception();
    }
  }

  getPendingFileChoosers(): PendingFileChooserInfo[] {
    return this.#pendingFileChoosers.map(entry => ({...entry}));
  }

  async handleFileChooser(
    options: HandleFileChooserOptions,
  ): Promise<HandleFileChooserResult> {
    if (options.action === 'enable') {
      this.#explicitFileChooserInterception = true;
      await this.syncFileChooserInterception();
      return {
        action: 'enable',
        interceptionEnabled: this.#shouldInterceptFileChooser(),
        pending: this.getPendingFileChoosers(),
      };
    }
    if (options.action === 'disable') {
      this.#explicitFileChooserInterception = false;
      await this.syncFileChooserInterception();
      return {
        action: 'disable',
        interceptionEnabled: this.#shouldInterceptFileChooser(),
        pending: this.getPendingFileChoosers(),
      };
    }
    if (options.action === 'list') {
      if (
        this.#explicitFileChooserInterception === undefined &&
        !this.#shouldInterceptFileChooser()
      ) {
        this.#explicitFileChooserInterception = true;
      }
      await this.syncFileChooserInterception();
      return {
        action: 'list',
        interceptionEnabled: this.#shouldInterceptFileChooser(),
        pending: this.getPendingFileChoosers(),
      };
    }
    const index = options.index ?? 0;
    const entry = this.#pendingFileChoosers[index];
    if (!entry) {
      throw new Error(
        this.#pendingFileChoosers.length === 0
          ? 'No pending intercepted file chooser found.'
          : `File chooser index ${index} out of range (0..${this.#pendingFileChoosers.length - 1}).`,
      );
    }

    const session = this.#resolveSessionForFrameId(entry.frameId);
    if (!session) {
      throw new Error(
        'No active CDP session available to handle file chooser.',
      );
    }

    if (options.action === 'accept') {
      const files = options.filePaths ?? [];
      if (files.length === 0) {
        throw new Error(
          'filePaths must contain at least one path when action is "accept".',
        );
      }
      if (entry.mode === 'selectSingle' && files.length > 1) {
        throw new Error(
          'This file chooser only accepts a single file (mode=selectSingle).',
        );
      }
      if (entry.backendNodeId === undefined) {
        throw new Error(
          'Intercepted file chooser has no backendNodeId (likely triggered outside an <input type="file"> element).',
        );
      }
      await session.send('DOM.setFileInputFiles', {
        files,
        backendNodeId: entry.backendNodeId,
      });
      this.#pendingFileChoosers.splice(index, 1);
      return {
        action: 'accept',
        handled: entry,
        pending: this.getPendingFileChoosers(),
      };
    }

    // Best-effort cancel event dispatch for <input type="file">.
    if (entry.backendNodeId !== undefined) {
      try {
        const resolved = await session.send('DOM.resolveNode', {
          backendNodeId: entry.backendNodeId,
        });
        if (isRecord(resolved) && isRecord(resolved['object'])) {
          const objectId = asString(resolved['object']['objectId']);
          if (objectId) {
            await session.send('Runtime.callFunctionOn', {
              objectId,
              functionDeclaration:
                'function() { this.dispatchEvent(new Event("cancel", { bubbles: true })); }',
            });
          }
        }
      } catch (error) {
        logger?.('Failed dispatching cancel event for file chooser', error);
      }
    }
    this.#pendingFileChoosers.splice(index, 1);
    return {
      action: 'cancel',
      handled: entry,
      pending: this.getPendingFileChoosers(),
    };
  }

  #resolveSessionForFrameId(frameId: string): CdpSessionLike | undefined {
    if (this.#pptrPage && frameId) {
      for (const frame of this.#pptrPage.frames?.() ?? []) {
        if (getFrameId(frame) === frameId) {
          const frameSession = getFrameCdpSession(frame);
          if (frameSession) {
            return frameSession;
          }
        }
      }
    }
    return this.#pptrPage ? getPageCdpSession(this.#pptrPage) : undefined;
  }

  #onAuthSessionRequestPaused = (payload: unknown): void => {
    const session = this.#authSession;
    if (!session || !isRecord(payload)) {
      return;
    }
    const requestId = asString(payload['requestId']);
    if (!requestId) {
      return;
    }
    void session.send('Fetch.continueRequest', {requestId}).catch(error => {
      logger?.('Ignoring Fetch.continueRequest error', error);
    });
  };

  #onAuthSessionAuthRequired = (payload: unknown): void => {
    if (this.#authSession && isCdpSessionLike(this.#authSession)) {
      this.#handleAuthRequiredEvent(this.#authSession, payload);
    }
  };

  #onFallbackAuthRequired = (payload: unknown): void => {
    if (this.#authFallbackSession) {
      this.#handleAuthRequiredEvent(this.#authFallbackSession, payload);
    }
  };

  #resolveRuntimeOrConfigAuthAction(info: {
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
    for (let i = this.#runtimeAuthRules.length - 1; i >= 0; i--) {
      const rule = this.#runtimeAuthRules[i];
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
      return {
        action: rule.action,
        username: rule.username,
        password: rule.password,
        queueTimeoutMs: this.#runtimeAuthQueueTimeoutMs ?? 15_000,
      };
    }

    const fromMonitors = this.#monitorsManager?.resolveAuthAction(info);
    if (this.#runtimeAuthDefaultAction) {
      if (fromMonitors && fromMonitors.action === 'provide') {
        return fromMonitors;
      }
      return {
        action: this.#runtimeAuthDefaultAction,
        queueTimeoutMs:
          this.#runtimeAuthQueueTimeoutMs ??
          fromMonitors?.queueTimeoutMs ??
          15_000,
      };
    }
    if (fromMonitors) {
      return fromMonitors;
    }
    return {
      action: 'default',
      queueTimeoutMs: this.#runtimeAuthQueueTimeoutMs ?? 15_000,
    };
  }

  #handleAuthRequiredEvent(session: CdpSessionLike, payload: unknown): void {
    if (!isRecord(payload)) {
      return;
    }
    const requestId = asString(payload['requestId']);
    if (!requestId) {
      return;
    }
    const request = isRecord(payload['request']) ? payload['request'] : {};
    const authChallenge = isRecord(payload['authChallenge'])
      ? payload['authChallenge']
      : {};
    const url = asString(request['url']) ?? '';
    const method = asString(request['method']) ?? 'GET';
    const resourceType = asString(payload['resourceType']) ?? 'Other';
    const frameId = asString(payload['frameId']) ?? '';
    const source = asString(authChallenge['source']) ?? 'Server';
    const origin = asString(authChallenge['origin']) ?? '';
    const scheme = asString(authChallenge['scheme']) ?? '';
    const realm = asString(authChallenge['realm']) ?? '';

    this.#realtimeNetworkCollector?.recordAuthChallengeAlert({
      requestId,
      url,
      method,
      resourceType,
      source,
      realm,
    });

    const challengeId = `auth-${this.#nextAuthId++}`;
    const info: AuthChallengeInfo = {
      challengeId,
      requestId,
      url,
      method,
      resourceType,
      frameId,
      source,
      origin,
      scheme,
      realm,
      createdAt: Date.now(),
      status: 'pending',
    };

    if (this.#attemptedAuthRequestIds.has(requestId)) {
      this.#respondAuthChallenge(session, info, 'CancelAuth');
      return;
    }

    const decision = this.#resolveRuntimeOrConfigAuthAction({
      url,
      origin,
      realm,
      source,
    });
    if (
      decision.action === 'provide' &&
      decision.username !== undefined &&
      decision.password !== undefined
    ) {
      this.#markAttemptedAuthRequest(requestId);
      this.#respondAuthChallenge(session, info, 'ProvideCredentials', {
        username: decision.username,
        password: decision.password,
      });
      return;
    }
    if (decision.action === 'default') {
      this.#respondAuthChallenge(session, info, 'Default');
      return;
    }
    if (decision.action === 'cancel') {
      this.#respondAuthChallenge(session, info, 'CancelAuth');
      return;
    }

    // Queue with bounded safety timeout so headless Chrome never stalls indefinitely.
    const entry: PendingAuthEntry = {
      info,
      session,
    };
    entry.timer = setTimeout(() => {
      if (!this.#pendingAuthChallenges.has(challengeId)) {
        return;
      }
      this.#pendingAuthChallenges.delete(challengeId);
      this.#respondAuthChallenge(session, info, 'CancelAuth');
    }, decision.queueTimeoutMs);
    entry.timer.unref?.();
    this.#pendingAuthChallenges.set(challengeId, entry);
  }

  #markAttemptedAuthRequest(requestId: string): void {
    if (this.#attemptedAuthRequestIds.has(requestId)) {
      this.#attemptedAuthRequestIds.delete(requestId);
    } else {
      while (this.#attemptedAuthRequestIds.size >= MAX_ATTEMPTED_AUTH_IDS) {
        const oldest = this.#attemptedAuthRequestIds.values().next().value;
        if (oldest === undefined) {
          break;
        }
        this.#attemptedAuthRequestIds.delete(oldest);
      }
    }
    this.#attemptedAuthRequestIds.add(requestId);
  }

  #respondAuthChallenge(
    session: CdpSessionLike,
    info: AuthChallengeInfo,
    responseType: 'ProvideCredentials' | 'CancelAuth' | 'Default',
    credentials?: {username: string; password: string},
  ): void {
    info.resolvedAt = Date.now();
    info.status =
      responseType === 'ProvideCredentials'
        ? 'provided'
        : responseType === 'CancelAuth'
          ? 'canceled'
          : 'default';
    this.#authHistory.push({...info}, info.resolvedAt);

    const authChallengeResponse: Record<string, unknown> = {
      response: responseType,
      ...(responseType === 'ProvideCredentials' && credentials
        ? {
            username: credentials.username,
            password: credentials.password,
          }
        : {}),
    };
    void session
      .send('Fetch.continueWithAuth', {
        requestId: info.requestId,
        authChallengeResponse,
      })
      .catch(error => {
        logger?.('Failed to send Fetch.continueWithAuth', error);
      });
  }

  getPendingAuthChallenges(): AuthChallengeInfo[] {
    return Array.from(this.#pendingAuthChallenges.values()).map(entry => ({
      ...entry.info,
    }));
  }

  getAuthChallengeHistory(limit = 50): AuthChallengeInfo[] {
    return this.#authHistory.query({limit}).entries.map(e => e.data);
  }

  async handleAuthChallenge(
    options: HandleAuthChallengeOptions,
  ): Promise<HandleAuthChallengeResult> {
    const effectiveDefault: AuthDefaultAction =
      this.#runtimeAuthDefaultAction ??
      this.#monitorsManager?.getConfig().autoAuthPolicy?.defaultAction ??
      'default';

    if (options.action === 'list') {
      return {
        action: 'list',
        pending: this.getPendingAuthChallenges(),
        history: this.getAuthChallengeHistory(),
        defaultAction: effectiveDefault,
      };
    }

    if (options.action === 'set_policy') {
      if (options.defaultAction !== undefined) {
        this.#runtimeAuthDefaultAction = options.defaultAction;
      }
      if (options.queueTimeoutMs !== undefined) {
        this.#runtimeAuthQueueTimeoutMs = options.queueTimeoutMs;
      }
      if (options.username !== undefined && options.password !== undefined) {
        this.#runtimeAuthRules.push({
          originRegex: options.originRegex,
          urlRegex: options.urlRegex,
          realmRegex: options.realmRegex,
          source: options.source,
          action: 'provide',
          username: options.username,
          password: options.password,
        });
      }
      await this.#syncAuthInterception();
      return {
        action: 'set_policy',
        pending: this.getPendingAuthChallenges(),
        history: this.getAuthChallengeHistory(),
        defaultAction: this.#runtimeAuthDefaultAction ?? effectiveDefault,
      };
    }

    let entry: PendingAuthEntry | undefined;
    if (options.challengeId) {
      entry = this.#pendingAuthChallenges.get(options.challengeId);
      if (!entry) {
        throw new Error(
          `Pending auth challenge "${options.challengeId}" not found.`,
        );
      }
    } else {
      entry = this.#pendingAuthChallenges.values().next().value;
      if (!entry) {
        throw new Error('No pending auth challenge found.');
      }
    }

    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
    }
    this.#pendingAuthChallenges.delete(entry.info.challengeId);

    if (options.action === 'provide') {
      if (options.username === undefined || options.password === undefined) {
        throw new Error(
          'username and password are required when action is "provide".',
        );
      }
      this.#markAttemptedAuthRequest(entry.info.requestId);
      this.#respondAuthChallenge(
        entry.session,
        entry.info,
        'ProvideCredentials',
        {
          username: options.username,
          password: options.password,
        },
      );
    } else if (options.action === 'default') {
      this.#respondAuthChallenge(entry.session, entry.info, 'Default');
    } else {
      this.#respondAuthChallenge(entry.session, entry.info, 'CancelAuth');
    }

    return {
      action: options.action,
      resolved: {...entry.info},
      pending: this.getPendingAuthChallenges(),
      history: this.getAuthChallengeHistory(),
      defaultAction: effectiveDefault,
    };
  }

  getScreenRecorder(): ScreenRecorderData | null {
    return this.#screenRecorder;
  }

  setScreenRecorder(data: ScreenRecorderData | null): void {
    this.#screenRecorder = data;
  }

  isRunningPerformanceTrace(): boolean {
    return this.#isRunningPerformanceTrace;
  }

  setIsRunningPerformanceTrace(x: boolean): void {
    this.#isRunningPerformanceTrace = x;
    void this.#syncAuthInterception();
  }

  throwIfDialogOpen(): void {
    const dialog = this.getDialog();
    if (dialog) {
      throw new Error(
        `A dialog is open (${dialog.type()}: ${dialog.message()}).`,
      );
    }
  }

  #getDebuggingWebMcpToolGroups(): ToolGroups {
    const webmcpTools = this.pptrPage.webmcp
      .tools()
      .filter(isDebuggingWebMcpTool);
    if (webmcpTools.length === 0) {
      return [];
    }
    return [
      {
        name: 'WebMCP Tools',
        description: 'Tools exposed via WebMCP',
        tools: webmcpTools.map(tool => ({
          name: tool.name,
          description: tool.description,
          inputSchema: structuredClone(tool.inputSchema ?? {}),
        })),
      },
    ];
  }

  async discoverThirdPartyDeveloperTools(): Promise<ToolGroups> {
    // Check if there is a `devtoolstooldiscovery` event listener
    using windowHandle = await this.pptrPage.evaluateHandle(() => window);
    // @ts-expect-error internal API
    const client = this.pptrPage._client();
    const {listeners = []}: {listeners?: Protocol.DOMDebugger.EventListener[]} =
      await client.send('DOMDebugger.getEventListeners', {
        objectId: windowHandle.remoteObject().objectId,
      });
    if (listeners.find(l => l.type === 'devtoolstooldiscovery') === undefined) {
      return this.#getDebuggingWebMcpToolGroups();
    }

    const eventToolGroups = await this.pptrPage.evaluate(() => {
      if (window.__dtmcp) {
        window.__dtmcp.toolGroups = [];
      }
      return new Promise<ToolGroups>(resolve => {
        const event = new CustomEvent('devtoolstooldiscovery');
        const groups: ToolGroups = [];
        // @ts-expect-error Adding custom property
        event.respondWith = toolGroup => {
          if (!window.__dtmcp) {
            window.__dtmcp = {};
          }
          if (!window.__dtmcp.toolGroups) {
            window.__dtmcp.toolGroups = [];
          }

          if (
            typeof toolGroup.name !== 'string' ||
            (toolGroup.description &&
              typeof toolGroup.description !== 'string') ||
            !Array.isArray(toolGroup.tools)
          ) {
            console.error('Invalid toolGroup:', toolGroup);
            return;
          }
          for (const tool of toolGroup.tools) {
            if (
              typeof tool.name !== 'string' ||
              typeof tool.description !== 'string' ||
              typeof tool.inputSchema !== 'object' ||
              typeof tool.execute !== 'function'
            ) {
              console.error('Invalid tool:', tool);
              return;
            }
          }

          window.__dtmcp.toolGroups.push(toolGroup);

          // When receiving a toolGroup for the first time, expose a simple execution helper
          if (!window.__dtmcp.executeTool) {
            window.__dtmcp.executeTool = async (toolName, args) => {
              if (
                !window.__dtmcp?.toolGroups ||
                window.__dtmcp.toolGroups.length === 0
              ) {
                throw new Error('No tools found on the page');
              }
              for (const group of window.__dtmcp.toolGroups) {
                const tool = group.tools?.find(t => t.name === toolName);
                if (tool) {
                  return await tool.execute(args);
                }
              }
              throw new Error(`Tool ${toolName} not found`);
            };
          }

          groups.push(toolGroup);
        };
        window.dispatchEvent(event);
        // If at least one toolGroup was added synchronously, resolve with the array.
        // Otherwise, use setTimeout to allow for any microtask/asynchronous respondWith calls, or resolve with an empty array.
        if (groups.length > 0) {
          resolve(groups);
        } else {
          setTimeout(() => {
            if (groups.length > 0) {
              resolve(groups);
            } else {
              resolve([]);
            }
          }, 0);
        }
      });
    });

    for (const group of eventToolGroups) {
      for (const tool of group.tools ?? []) {
        replaceHtmlElementsWithUids(tool.inputSchema);
      }
    }

    return [...this.#getDebuggingWebMcpToolGroups(), ...eventToolGroups];
  }

  getWebMcpTools(): WebMCPTool[] {
    return this.pptrPage.webmcp
      .tools()
      .filter(tool => !isDebuggingWebMcpTool(tool));
  }

  resolveCdpRequestId(cdpRequestId: string): number | undefined {
    if (!cdpRequestId) {
      logger?.('no network request');
      return;
    }
    const request = this.networkCollector.find(request => {
      // @ts-expect-error id is internal.
      return request.id === cdpRequestId;
    });
    if (!request) {
      logger?.('no network request for ' + cdpRequestId);
      return;
    }
    return this.networkCollector.getIdForResource(request);
  }

  resolveReqidToCdpRequestId(reqid: number): string | undefined {
    const request = this.networkCollector.getById(reqid);
    if (!request) {
      return undefined;
    }
    // @ts-expect-error id is internal.
    return request.id;
  }

  getNetworkRequests(includePreservedRequests?: boolean): HTTPRequest[] {
    return this.networkCollector.getData(includePreservedRequests);
  }

  get commentBridge(): DevToolsCommentBridge | undefined {
    return this.#commentBridge;
  }

  disposeCommentBridge(): void {
    this.#commentBridge?.dispose();
    this.#commentBridge = undefined;
  }

  /**
   * Returns the comment bridge attached to the DevTools page, or undefined if
   * the DevTools page does not support DevTools comments.
   */
  async ensureDevToolsCommentBridge(
    devtoolsPage: Page,
  ): Promise<DevToolsCommentBridge | undefined> {
    if (!this.#commentBridge) {
      this.#commentBridge = new DevToolsCommentBridge();
    }
    const attached = await this.#commentBridge.attach(devtoolsPage);
    return attached ? this.#commentBridge : undefined;
  }

  async getDevToolsPage(): Promise<Page | undefined> {
    try {
      if (await this.pptrPage.hasDevTools()) {
        return await this.pptrPage.openDevTools();
      }
      return undefined;
    } catch {
      // Prior to Chrome 144.0.7559.59, the command fails,
      // Some Electron apps still use older version
      // Fall back to not exposing DevTools at all.
      return undefined;
    }
  }

  /**
   * Opens the DevTools window and waits until the DevTools frontend creates
   * its universe, which also creates the CD4A bridge when it is enabled.
   */
  async openDevTools(): Promise<Page> {
    const devtoolsPage = await this.pptrPage.openDevTools();
    try {
      await devtoolsPage.waitForFunction(() => Boolean(window.universe), {
        timeout: DEVTOOLS_UNIVERSE_TIMEOUT_MS,
      });
    } catch (e) {
      logger?.(
        `DevTools might not have loaded completely within ${DEVTOOLS_UNIVERSE_TIMEOUT_MS / 1000} seconds`,
        e,
      );
    }
    return devtoolsPage;
  }

  getConsoleData(
    includePreservedMessages?: boolean,
  ): Array<ConsoleMessage | Error | DevTools.AggregatedIssue | UncaughtError> {
    return this.consoleCollector.getData(includePreservedMessages);
  }

  getConsoleMessageById(
    id: number,
  ): ConsoleMessage | Error | DevTools.AggregatedIssue | UncaughtError {
    return this.consoleCollector.getById(id);
  }

  getLatestConsoleMessageId(): number {
    const latest = this.consoleCollector.getData(true).at(-1);
    return latest ? this.consoleCollector.getIdForResource(latest) : 0;
  }

  getConsoleDataAfter(
    id: number,
  ): Array<ConsoleMessage | Error | DevTools.AggregatedIssue | UncaughtError> {
    return this.consoleCollector
      .getData(true)
      .filter(item => this.consoleCollector.getIdForResource(item) > id);
  }

  getNetworkRequestById(reqid: number): HTTPRequest {
    return this.networkCollector.getById(reqid);
  }

  get networkConditions(): string | null {
    return this.emulationSettings.networkConditions ?? null;
  }

  get cpuThrottlingRate(): number {
    return this.emulationSettings.cpuThrottlingRate ?? 1;
  }

  get geolocation(): GeolocationOptions | null {
    return this.emulationSettings.geolocation ?? null;
  }

  get viewport(): Viewport | null {
    return this.emulationSettings.viewport ?? null;
  }

  get userAgent(): string | null {
    return this.emulationSettings.userAgent ?? null;
  }

  get colorScheme(): 'dark' | 'light' | null {
    return this.emulationSettings.colorScheme ?? null;
  }

  get forcedColors(): ForcedColors | null {
    return this.emulationSettings.forcedColors ?? null;
  }

  get prefersContrast(): PrefersContrast | null {
    return this.emulationSettings.prefersContrast ?? null;
  }

  get prefersReducedMotion(): PrefersReducedMotion | null {
    return this.emulationSettings.prefersReducedMotion ?? null;
  }

  // Public for testability: tests spy on this method to verify throttle multipliers.
  createWaitForHelper(
    cpuMultiplier: number,
    networkMultiplier: number,
  ): WaitForHelper {
    return new WaitForHelper(this.pptrPage, cpuMultiplier, networkMultiplier);
  }

  async waitForEventsAfterAction(
    action: (signal: AbortSignal) => Promise<unknown>,
    options?: {
      timeout?: number;
      waitUntil?: 'load' | 'domcontentloaded' | 'networkidle0' | 'networkidle2';
      waitForStableDom?: boolean;
      expectNavigationIn?: number;
      handleDialog?:
        DialogAction | Partial<Record<Protocol.Page.DialogType, DialogAction>>;
    },
  ): Promise<WaitForEventsResult> {
    const helper = this.createWaitForHelper(
      this.cpuThrottlingRate,
      getNetworkMultiplierFromString(this.networkConditions),
    );
    const hasExplicitDialogHandler = options?.handleDialog !== undefined;
    if (hasExplicitDialogHandler) {
      this.#explicitDialogActionDepth++;
    }
    try {
      return await helper.waitForEventsAfterAction(action, options);
    } finally {
      if (hasExplicitDialogHandler) {
        this.#explicitDialogActionDepth--;
      }
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#isRunningPerformanceTrace = false;
    this.#monitorsUnsubscribe?.();
    this.#monitorsUnsubscribe = undefined;
    this.disposeCommentBridge();
    if (this.#screenRecorder) {
      const {recorder} = this.#screenRecorder;
      this.#screenRecorder = null;
      void recorder.stop().catch(e => {
        logger?.('Failed to stop screencast recording on dispose', e);
      });
    }
    this.#pptrPage?.off('dialog', this.#dialogHandler);
    this.#pptrPage?.off('framenavigated', this.#onFrameNavigatedSync);
    if (
      this.#fileChooserInterceptEnabled &&
      this.#fileChooserSession &&
      !this.isClosed()
    ) {
      void this.#fileChooserSession
        .send('Page.setInterceptFileChooserDialog', {enabled: false})
        .catch(() => {});
    }
    this.#fileChooserInterceptEnabled = false;
    this.#pendingFileChoosers = [];
    this.#fileChooserSession?.off(
      'Page.fileChooserOpened',
      this.#onFileChooserOpened,
    );
    this.#fileChooserSession = undefined;
    this.#authFallbackSession?.off(
      'Fetch.authRequired',
      this.#onFallbackAuthRequired,
    );
    this.#authFallbackSession = undefined;
    for (const waiter of this.#dialogWaiters) {
      waiter.reject(
        new Error(`McpPage (id=${this.id}) disposed while waiting for dialog.`),
      );
    }
    this.#dialogWaiters.clear();
    for (const entry of this.#pendingAuthChallenges.values()) {
      if (entry.timer !== undefined) {
        clearTimeout(entry.timer);
      }
      this.#respondAuthChallenge(entry.session, entry.info, 'CancelAuth');
    }
    this.#pendingAuthChallenges.clear();
    this.#attemptedAuthRequestIds.clear();
    this.#realtimeNetworkCollector?.dispose();
    this.#realtimeNetworkCollector = undefined;
    void this.#networkOverrideManager?.dispose();
    this.#networkCollector?.dispose();
    this.#consoleCollector?.dispose();
    this.#logpointManager?.dispose();
    this.#logpointManager = undefined;
    const devtoolsUniverse = this.#devtoolsUniverse;
    this.#devtoolsUniverse = undefined;
    this.#devtoolsUniversePromise = undefined;
    this.#webAuthnAuthenticator = undefined;
    devtoolsUniverse?.universe.dispose();
    void devtoolsUniverse?.session.detach().catch(e => {
      logger?.('Failed to detach DevTools session', e);
    });
    const authSession = this.#authSession;
    this.#authSession = undefined;
    this.#authFetchEnabled = false;
    if (authSession) {
      authSession.off('Fetch.requestPaused', this.#onAuthSessionRequestPaused);
      authSession.off('Fetch.authRequired', this.#onAuthSessionAuthRequired);
      if (authSession !== devtoolsUniverse?.session) {
        void authSession.detach().catch(e => {
          logger?.('Failed to detach Fetch auth session', e);
        });
      }
    }
  }

  async mockNetwork(input: NetworkMockInput): Promise<NetworkOverride> {
    const manager = await this.#getNetworkOverrideManagerForChanges();
    return await manager.mock(input);
  }

  async #getNetworkOverrideManagerForChanges(): Promise<NetworkOverrideManager> {
    if (this.#isRunningPerformanceTrace) {
      throw new Error(
        'Cannot change network mocks while a performance trace is running.',
      );
    }
    await this.init();
    if (!this.#networkOverrideManager) {
      throw new Error(`McpPage (id=${this.id}) is not initialized.`);
    }
    return this.#networkOverrideManager;
  }

  listNetworkMocks(filter?: NetworkMockFilter): NetworkOverride[] {
    return this.#networkOverrideManager?.list(filter) ?? [];
  }

  async removeNetworkMocks(filter: NetworkMockFilter): Promise<number> {
    const manager = await this.#getNetworkOverrideManagerForChanges();
    return await manager.remove(filter);
  }

  async executeThirdPartyDeveloperTool(
    toolName: string,
    params: Record<string, unknown>,
    response: Response,
  ): Promise<void> {
    const webmcpTool = this.pptrPage.webmcp
      .tools()
      .find(t => t.name === toolName && isDebuggingWebMcpTool(t));
    if (webmcpTool) {
      const {status, output, errorText, exception} =
        await webmcpTool.execute(params);
      if (status !== 'Completed') {
        const error = exception?.description ?? exception?.value ?? errorText;
        throw new Error(
          error ? String(error) : `Tool execution failed: ${status}`,
        );
      }
      if (output !== undefined) {
        response.appendResponseLine(JSON.stringify(output, null, 2));
      } else {
        response.appendResponseLine('Tool returned no result.');
      }
      return;
    }

    // Creates array of ElementHandles from the UIDs in the params.
    // We do not replace the uids with the ElementsHandles yet, because
    // the `evaluate` function only turns them into DOM elements if they
    // are passed as non-nested arguments.
    const handles: ElementHandle[] = [];
    for (const value of Object.values(params)) {
      if (
        value instanceof Object &&
        'uid' in value &&
        typeof value.uid === 'string' &&
        Object.keys(value).length === 1
      ) {
        handles.push(await this.getElementByUid(value.uid));
      }
    }

    const result = await this.pptrPage.evaluate(
      async (name, args, ...elements) => {
        // Replace the UIDs with DOM elements.
        for (const [key, value] of Object.entries(args)) {
          if (
            value instanceof Object &&
            'uid' in value &&
            typeof value.uid === 'string' &&
            Object.keys(value).length === 1
          ) {
            args[key] = elements.shift();
          }
        }

        if (!window.__dtmcp?.executeTool) {
          throw new Error('No tools found on the page');
        }

        const toolResult = await window.__dtmcp.executeTool(name, args);

        const stashedElements: Element[] = [];

        const stashDOMElement = (el: Element): {stashedId: string} => {
          stashedElements.push(el);
          return {
            stashedId: `stashed-${stashedElements.length - 1}`,
          };
        };

        const ancestors = new Set<unknown>();
        // Recursively walks the tool result:
        // - Replaces DOM elements with an ID and stashes the DOM element on the window object
        // - Replaces non-plain objects with a string representation of the object
        // - Replaces circular references with the string '<Circular reference>'
        // - Replaces functions with the string '<Function object>'
        // - Replaces symbols and bigints with their string representation
        const processToolResult = (data: unknown): unknown => {
          // 1. Handle DOM Elements
          if (data instanceof Element) {
            return stashDOMElement(data);
          }

          // 2. Handle Arrays
          if (Array.isArray(data)) {
            if (ancestors.has(data)) {
              return '<Circular reference>';
            }
            ancestors.add(data);
            try {
              return data.map((item: unknown) => processToolResult(item));
            } finally {
              ancestors.delete(data);
            }
          }

          // 3. Handle Objects
          if (data !== null && typeof data === 'object') {
            const proto = Object.getPrototypeOf(data);
            // If not a plain object, return a string representation of the object
            if (proto !== null && proto !== Object.prototype) {
              return `<${data.constructor?.name || 'Object'} instance>`;
            }

            if (ancestors.has(data)) {
              return '<Circular reference>';
            }
            ancestors.add(data);
            try {
              const processedObj: Record<string, unknown> = {};
              for (const [key, value] of Object.entries(data)) {
                processedObj[key] = processToolResult(value);
              }
              return processedObj;
            } finally {
              ancestors.delete(data);
            }
          }

          // 4. Handle Functions
          if (typeof data === 'function') {
            return '<Function object>';
          }

          // 5. Handle Symbols and BigInts (not JSON/CDP-by-value serializable)
          if (typeof data === 'symbol') {
            return data.toString();
          }
          if (typeof data === 'bigint') {
            return `${data.toString()}n`;
          }

          // 6. Return primitives (strings, numbers, booleans, undefined, null) as-is
          return data;
        };

        const processed = processToolResult(toolResult);
        const serialized =
          processed !== undefined ? JSON.stringify(processed) : undefined;
        if (stashedElements.length > 0) {
          window.__dtmcp.stashedElements = stashedElements;
        }
        return {
          result: serialized,
          stashed: stashedElements.length,
        };
      },
      toolName,
      params,
      ...handles,
    );

    const elementHandles: ElementHandle[] = [];
    if (result.stashed > 0) {
      try {
        for (let i = 0; i < result.stashed; i++) {
          const elementHandle = await this.pptrPage.evaluateHandle(index => {
            const el = window.__dtmcp?.stashedElements?.[index];
            if (!el) {
              throw new Error(`Stashed element at index ${index} not found`);
            }
            return el;
          }, i);
          elementHandles.push(elementHandle);
        }
      } finally {
        try {
          await this.pptrPage.evaluate(() => {
            if (window.__dtmcp) {
              window.__dtmcp.stashedElements = undefined;
            }
          });
        } catch (error) {
          logger?.('Failed to clean up stashed elements', error);
        }
      }
    }

    if (elementHandles.length) {
      using stack = new DisposableStack();
      for (const handle of this.extraHandles) {
        stack.use(handle);
      }
      this.textSnapshot = await TextSnapshot.create(this, {
        extraHandles: elementHandles,
      });
      response.includeSnapshot();
    }

    const cdpElementIds = await Promise.all(
      elementHandles.map(async (elementHandle, index) => {
        const backendNodeId = await elementHandle.backendNodeId();
        if (!backendNodeId) {
          logger?.(
            `No backendNodeId for stashed DOM element with index ${index}`,
          );
          return `stashed-${index}`;
        }
        const cdpElementId =
          this.textSnapshot?.resolveCdpElementId(backendNodeId);
        if (!cdpElementId) {
          logger?.(
            `Could not get cdpElementId for backend node ${backendNodeId}`,
          );
          return `stashed-${index}`;
        }
        return cdpElementId;
      }),
    );

    const recursivelyReplaceStashedElements = (node: unknown): unknown => {
      if (Array.isArray(node)) {
        return node.map(x => recursivelyReplaceStashedElements(x));
      }
      if (node !== null && typeof node === 'object') {
        if (
          'stashedId' in node &&
          typeof node.stashedId === 'string' &&
          node.stashedId.startsWith('stashed-') &&
          Object.keys(node).length === 1
        ) {
          const index = parseInt(node.stashedId.split('-')[1], 10);
          return {uid: cdpElementIds[index]};
        }
        const resultObj: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(node)) {
          resultObj[key] = recursivelyReplaceStashedElements(value);
        }
        return resultObj;
      }
      return node;
    };

    if (result.result !== undefined) {
      const parsedResult: unknown = JSON.parse(result.result);
      const resultWithUids = recursivelyReplaceStashedElements(parsedResult);
      response.appendResponseLine(JSON.stringify(resultWithUids, null, 2));
    } else {
      response.appendResponseLine('Tool returned no result.');
    }
  }

  async getElementByUid(uid: string): Promise<ElementHandle<Element>> {
    if (!this.textSnapshot) {
      throw new Error(
        `No snapshot found for page ${this.id ?? '?'}. Use take_snapshot to capture one.`,
      );
    }
    const node = this.textSnapshot.idToNode.get(uid);
    if (!node) {
      throw new Error(`Element uid "${uid}" not found on page ${this.id}.`);
    }
    return await this.#resolveElementHandle(node, uid);
  }

  async #resolveElementHandle(
    node: TextSnapshotNode,
    uid: string,
  ): Promise<ElementHandle<Element>> {
    const message = `Element with uid ${uid} no longer exists on the page.`;
    try {
      const handle = await node.elementHandle();
      if (!handle) {
        throw new Error(message);
      }
      return handle;
    } catch (error) {
      throw new Error(message, {
        cause: error,
      });
    }
  }

  getAXNodeByUid(uid: string): TextSnapshotNode | undefined {
    return this.textSnapshot?.idToNode.get(uid);
  }

  async resolveBackendNodeId(
    backendNodeId: number,
  ): Promise<string | undefined> {
    let id = this.textSnapshot?.resolveCdpElementId(backendNodeId);
    if (id) {
      return id;
    }
    this.textSnapshot = await TextSnapshot.create(this, {
      verbose: this.textSnapshot?.verbose ?? false,
    });
    id = this.textSnapshot.resolveCdpElementId(backendNodeId);
    if (!id && !this.textSnapshot.verbose) {
      this.textSnapshot = await TextSnapshot.create(this, {
        verbose: true,
      });
      id = this.textSnapshot.resolveCdpElementId(backendNodeId);
    }
    return id;
  }

  async resolveUidToBackendNodeId(
    uid: string,
  ): Promise<{backendNodeId: number; targetId?: string} | undefined> {
    const target = this.target;
    const targetId =
      Boolean(target) &&
      '_targetId' in target &&
      typeof target._targetId === 'string'
        ? target._targetId
        : undefined;
    const node = this.getAXNodeByUid(uid);
    if (node?.backendNodeId !== undefined) {
      return {backendNodeId: node.backendNodeId, targetId};
    }
    try {
      const handle = await this.getElementByUid(uid);
      const backendNodeId = await handle.backendNodeId();
      return backendNodeId ? {backendNodeId, targetId} : undefined;
    } catch {
      return undefined;
    }
  }

  async getCssStylesForUid(uid: string): Promise<ElementCssStyles> {
    if (!this.textSnapshot) {
      throw new Error(
        `No snapshot found for page ${this.id ?? '?'}. Use take_snapshot to capture one.`,
      );
    }
    const node = this.textSnapshot.idToNode.get(uid);
    if (!node) {
      throw new Error(`Element uid "${uid}" not found on page ${this.id}.`);
    }

    const backendNodeId = node.backendNodeId;
    if (!isBackendNodeId(backendNodeId)) {
      throw new Error(
        `Failed to resolve backend node ID for element with uid "${uid}".`,
      );
    }

    const devtoolsUniverse = await this.ensureDevToolsUniverse();
    if (!devtoolsUniverse) {
      throw new Error(
        `DevTools universe is not available for page ${this.id ?? '?'}.`,
      );
    }

    const targetManager = devtoolsUniverse.universe.context.get(
      DevTools.TargetManager,
    );
    let domNode: DevTools.DOMModel.DOMNode | undefined;
    let cssModel: DevTools.CSSModel.CSSModel | null = null;

    for (const dom of targetManager.models(DevTools.DOMModel.DOMModel)) {
      const nodeMap = await dom.pushNodesByBackendIdsToFrontend(
        new Set([backendNodeId]),
      );
      const frontendNode = nodeMap?.get(backendNodeId);
      if (frontendNode) {
        domNode = frontendNode;
        cssModel = dom.target().model(DevTools.CSSModel.CSSModel);
        break;
      }
    }

    if (!domNode || !cssModel) {
      throw new Error(
        `Element with uid "${uid}" was detached or no longer exists on the page. Please take a new snapshot with take_snapshot.`,
      );
    }

    const targetElement = domNode.enclosingElementOrSelf();
    if (!targetElement) {
      throw new Error(
        `Element with uid "${uid}" is not an element node and has no parent element.`,
      );
    }

    const [matchedStyles, computedStyles] = await Promise.all([
      cssModel.getMatchedStyles(targetElement.id),
      cssModel.getComputedStyle(targetElement.id),
    ]);
    if (!matchedStyles) {
      throw new Error(
        `Could not retrieve matched styles for element with uid "${uid}".`,
      );
    }
    if (!computedStyles) {
      logger?.(
        `Could not retrieve computed styles for element with uid ${uid}.`,
      );
    }

    return {matchedStyles, computedStyles};
  }

  async getDevToolsData(): Promise<DevToolsData> {
    try {
      logger?.('Getting DevTools UI data');
      const devtoolsPage = await this.getDevToolsPage();
      if (!devtoolsPage) {
        logger?.('No DevTools page detected');
        return {};
      }
      if (this.#config.resolved.devtoolsComments) {
        await this.ensureDevToolsCommentBridge(devtoolsPage);
      }
      const {cdpRequestId, cdpBackendNodeId} = await devtoolsPage.evaluate(
        async () => {
          // @ts-expect-error no types
          const UI = await import('/bundled/ui/legacy/legacy.js');
          // @ts-expect-error no types
          const SDK = await import('/bundled/core/sdk/sdk.js');
          const request = UI.Context.Context.instance().flavor(
            SDK.NetworkRequest.NetworkRequest,
          );
          const node = UI.Context.Context.instance().flavor(
            SDK.DOMModel.DOMNode,
          );
          return {
            cdpRequestId: request?.requestId(),
            cdpBackendNodeId: node?.backendNodeId(),
          };
        },
      );
      return {cdpBackendNodeId, cdpRequestId};
    } catch (err) {
      logger?.('error getting devtools data', err);
    }
    return {};
  }

  async restoreEmulation(): Promise<void> {
    const currentSetting = this.emulationSettings;
    const {viewport} = currentSetting;
    if (viewport) {
      // Lighthouse's CDP session replaces the device metrics override and
      // clears it on detach, and Chrome ignores an override identical to the
      // last one this session sent. A different width first makes the real
      // call take effect without a reload (`isMobile` and `hasTouch` stay the
      // same). This also runs after snapshot audits and fires a resize event,
      // so do not remove it as redundant.
      await this.pptrPage.setViewport({
        ...viewport,
        width: Math.max(1, viewport.width - 1),
      });
    }
    await this.emulate(currentSetting);
  }

  async #emulateMediaFeatures(settings: EmulationSettings): Promise<void> {
    // `page.emulateMediaFeatures` replaces all previously emulated media
    // features, so every supported feature is sent on each call. An empty
    // value disables the override for that feature.
    await this.pptrPage.emulateMediaFeatures([
      {name: 'prefers-color-scheme', value: settings.colorScheme ?? ''},
      {name: 'forced-colors', value: settings.forcedColors ?? ''},
      {name: 'prefers-contrast', value: settings.prefersContrast ?? ''},
      {
        name: 'prefers-reduced-motion',
        value: settings.prefersReducedMotion ?? '',
      },
    ]);
  }

  async emulate(options: {
    networkConditions?: string;
    cpuThrottlingRate?: number;
    geolocation?: GeolocationOptions;
    userAgent?: string;
    colorScheme?: 'dark' | 'light' | 'auto';
    forcedColors?: ForcedColors | 'auto';
    prefersContrast?: PrefersContrast | 'auto';
    prefersReducedMotion?: PrefersReducedMotion | 'auto';
    viewport?: Viewport;
    extraHttpHeaders?: Record<string, string> | undefined;
  }): Promise<void> {
    const page = this.pptrPage;
    const newSettings: EmulationSettings = {...this.emulationSettings};

    // Skip network emulation if blocklist/allowlist is configured, as it conflicts with blocking rules in Puppeteer.
    if (this.#hasNetworkBlockOrAllowlist) {
      if (options.networkConditions !== undefined) {
        throw new Error(
          'Network throttling is not supported when network blocking (allowlist/blocklist) is configured.',
        );
      }
    } else if (!options.networkConditions) {
      await page.emulateNetworkConditions(null);
      delete newSettings.networkConditions;
    } else if (options.networkConditions === 'Offline') {
      await page.emulateNetworkConditions({
        offline: true,
        download: 0,
        upload: 0,
        latency: 0,
      });
      newSettings.networkConditions = 'Offline';
    } else if (options.networkConditions in PredefinedNetworkConditions) {
      const networkCondition =
        PredefinedNetworkConditions[
          options.networkConditions as keyof typeof PredefinedNetworkConditions
        ];
      await page.emulateNetworkConditions(networkCondition);
      newSettings.networkConditions = options.networkConditions;
    }

    const secondarySession = this.devtoolsUniverse?.session;
    if (!options.cpuThrottlingRate) {
      await page.emulateCPUThrottling(1);
      if (secondarySession) {
        await secondarySession.send('Emulation.setCPUThrottlingRate', {
          rate: 1,
        });
      }
      delete newSettings.cpuThrottlingRate;
    } else {
      await page.emulateCPUThrottling(options.cpuThrottlingRate);
      if (secondarySession) {
        await secondarySession.send('Emulation.setCPUThrottlingRate', {
          rate: options.cpuThrottlingRate,
        });
      }
      newSettings.cpuThrottlingRate = options.cpuThrottlingRate;
    }

    if (!options.geolocation) {
      await page.setGeolocation(null);
      delete newSettings.geolocation;
    } else {
      await page.setGeolocation(options.geolocation);
      newSettings.geolocation = options.geolocation;
    }

    if (!options.userAgent) {
      await page.setUserAgent({userAgent: undefined});
      delete newSettings.userAgent;
    } else {
      await page.setUserAgent({userAgent: options.userAgent});
      newSettings.userAgent = options.userAgent;
    }

    if (!options.colorScheme || options.colorScheme === 'auto') {
      delete newSettings.colorScheme;
    } else {
      newSettings.colorScheme = options.colorScheme;
    }

    if (!options.forcedColors || options.forcedColors === 'auto') {
      delete newSettings.forcedColors;
    } else {
      newSettings.forcedColors = options.forcedColors;
    }

    if (!options.prefersContrast || options.prefersContrast === 'auto') {
      delete newSettings.prefersContrast;
    } else {
      newSettings.prefersContrast = options.prefersContrast;
    }

    if (
      !options.prefersReducedMotion ||
      options.prefersReducedMotion === 'auto'
    ) {
      delete newSettings.prefersReducedMotion;
    } else {
      newSettings.prefersReducedMotion = options.prefersReducedMotion;
    }

    await this.#emulateMediaFeatures(newSettings);

    if (!options.viewport) {
      delete newSettings.viewport;
    } else {
      const defaults = {
        deviceScaleFactor: 1,
        isMobile: false,
        hasTouch: false,
        isLandscape: false,
      };
      newSettings.viewport = {...defaults, ...options.viewport};
    }

    if (options.extraHttpHeaders !== undefined) {
      await page.setExtraHTTPHeaders(options.extraHttpHeaders);
      newSettings.extraHttpHeaders = options.extraHttpHeaders;
      if (Object.keys(options.extraHttpHeaders).length === 0) {
        delete newSettings.extraHttpHeaders;
      }
    }

    const previousViewport = this.emulationSettings.viewport;
    this.emulationSettings = Object.keys(newSettings).length ? newSettings : {};

    this.updateTimeouts();

    // This should happen after updating the page timeouts.
    // Setting the viewport can trigger a reload which we don't want to timeout.
    try {
      await page.setViewport(newSettings.viewport ?? null);
    } catch (error) {
      if (previousViewport) {
        newSettings.viewport = previousViewport;
      } else {
        delete newSettings.viewport;
      }
      this.emulationSettings = Object.keys(newSettings).length
        ? newSettings
        : {};
      throw error;
    }
  }

  async clearNetworkConditions(): Promise<void> {
    if (!this.emulationSettings.networkConditions) {
      return;
    }
    await this.#pptrPage?.emulateNetworkConditions(null);
    delete this.emulationSettings.networkConditions;
    this.updateTimeouts();
  }

  updateTimeouts(): void {
    if (!this.#pptrPage) {
      return;
    }
    // For waiters 5sec timeout should be sufficient.
    // Increased in case we throttle the CPU
    const cpuMultiplier = this.cpuThrottlingRate;
    this.pptrPage.setDefaultTimeout(DEFAULT_TIMEOUT * cpuMultiplier);
    // 10sec should be enough for the load event to be emitted during
    // navigations.
    // Increased in case we throttle the network requests or the CPU
    const networkMultiplier = getNetworkMultiplierFromString(
      this.networkConditions,
    );
    this.pptrPage.setDefaultNavigationTimeout(
      this.#navigationTimeout * networkMultiplier * cpuMultiplier,
    );
  }

  waitForTextOnPage(
    text: string[],
    options: {timeout?: number; visible?: boolean} = {},
  ): Promise<Element> {
    const {timeout, visible} = options;
    const page = this.pptrPage;
    const initialFrames = page.frames();
    const observedFrames = new Set(initialFrames);
    const controller = new AbortController();

    const locatorForFrames = (frames: Frame[]): Locator<Element> =>
      this.#locatorClass.race(
        frames.flatMap(frame =>
          text.flatMap(value => {
            const locators = [
              frame.locator(`aria/${value}`),
              frame.locator(`text/${value}`),
            ];
            return visible
              ? locators.map(locator => locator.setVisibility('visible'))
              : locators;
          }),
        ),
      );

    let initialLocator = locatorForFrames(initialFrames);
    if (timeout) {
      initialLocator = initialLocator.setTimeout(timeout);
    }

    return new Promise<Element>((resolve, reject) => {
      let settled = false;
      const cleanup = (): boolean => {
        if (settled) {
          return false;
        }
        settled = true;
        page.off('frameattached', onFrameAttached);
        controller.abort();
        return true;
      };
      const finish = (element: Element): void => {
        if (cleanup()) {
          resolve(element);
        }
      };
      const fail = (error: unknown): void => {
        if (cleanup()) {
          reject(error);
        }
      };
      const onFrameAttached = (frame: Frame): void => {
        if (observedFrames.has(frame)) {
          return;
        }
        observedFrames.add(frame);
        // The initial locator race does not include frames added later.
        // Watch each new frame until the initial race resolves or times out.
        // A timeout of 0 disables the frame timer; controller.abort() stops it.
        void locatorForFrames([frame])
          .setTimeout(0)
          .wait({signal: controller.signal})
          .then(finish, error => {
            if (controller.signal.aborted) {
              return;
            }
            logger?.('Failed to wait for text in an attached frame', error);
          });
      };

      page.on('frameattached', onFrameAttached);
      void initialLocator.wait({signal: controller.signal}).then(finish, fail);
    });
  }

  get realtimeNetworkCollector(): RealtimeNetworkCollector {
    if (!this.#realtimeNetworkCollector) {
      throw new Error(
        `McpPage (id=${this.id}) is not initialized. Call init() first.`,
      );
    }
    return this.#realtimeNetworkCollector;
  }

  listWebSocketConnections(
    options: {status?: WebSocketStatus; urlPattern?: string} = {},
  ): WebSocketConnectionInfo[] {
    return this.realtimeNetworkCollector.listWebSocketConnections(options);
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
    return this.realtimeNetworkCollector.pollWsFrames(options);
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
    return this.realtimeNetworkCollector.pollSseEvents(options);
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
    return this.realtimeNetworkCollector.pollNetworkAlerts(options);
  }

  waitForNetworkResponse(
    options: WaitForNetworkResponseOptions,
  ): Promise<WaitForNetworkResponseResult> {
    return this.realtimeNetworkCollector.waitForNetworkResponse(options);
  }

  async waitForDom(options: WaitForDomOptions): Promise<WaitForDomResult> {
    const rawSegments = options.selector.split('>>>');
    const segments: string[] = [];
    for (const part of rawSegments) {
      const trimmed = part.trim();
      if (!trimmed) {
        throw new Error(
          `Invalid selector "${options.selector}": empty segment around >>> Shadow DOM combinator.`,
        );
      }
      segments.push(trimmed);
    }

    const state: WaitForDomState = options.state ?? 'visible';
    const timeoutMs = options.timeoutMs ?? DEFAULT_DOM_WAIT_TIMEOUT_MS;
    const pollIntervalMs =
      options.pollIntervalMs ?? DEFAULT_DOM_POLL_INTERVAL_MS;
    const startedAt = Date.now();
    const deadline = startedAt + timeoutMs;

    let lastCount = 0;
    let lastVisibleCount = 0;
    let lastErrorMessage: string | undefined;

    while (true) {
      if (this.#disposed || this.isClosed()) {
        throw new Error(`Page ${this.id} closed while waiting for DOM.`);
      }

      const page = this.pptrPage;
      let targetFrame: Frame | undefined;
      if (options.frameId) {
        for (const candidate of page.frames()) {
          if (getFrameId(candidate) === options.frameId) {
            targetFrame = candidate;
            break;
          }
        }
        if (!targetFrame) {
          const graceDeadline = Math.min(deadline, startedAt + 1_500);
          if (Date.now() < graceDeadline) {
            await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
            continue;
          }
          const available = page
            .frames()
            .map(f => `${getFrameId(f) ?? 'unknown'}(${f.url()})`)
            .join(', ');
          throw new Error(
            `Frame "${options.frameId}" was detached or not found on target ${this.targetId}. Available frames: ${available || '(none)'}.`,
          );
        }
      } else {
        targetFrame = page.mainFrame();
      }

      try {
        const probe = await targetFrame.evaluate(
          (params: {
            segments: string[];
            state: WaitForDomState;
            text?: string;
            textRegexSource?: string;
            textRegexFlags?: string;
            attributeName?: string;
            attributeValue?: string;
          }) => {
            const queryShadowAll = (
              rootDoc: Document,
              segs: string[],
            ): Element[] => {
              let roots: Array<Document | ShadowRoot> = [rootDoc];
              let matches: Element[] = [];
              for (let i = 0; i < segs.length; i++) {
                const seg = segs[i];
                const nextMatches: Element[] = [];
                for (const root of roots) {
                  const found = root.querySelectorAll(seg);
                  for (const el of found) {
                    nextMatches.push(el);
                  }
                }
                if (i < segs.length - 1) {
                  const nextRoots: ShadowRoot[] = [];
                  for (const el of nextMatches) {
                    if (el.shadowRoot) {
                      nextRoots.push(el.shadowRoot);
                    }
                  }
                  if (nextRoots.length === 0) {
                    return [];
                  }
                  roots = nextRoots;
                } else {
                  matches = nextMatches;
                }
              }
              return matches;
            };

            const isElementVisible = (el: Element): boolean => {
              if (!el.isConnected) {
                return false;
              }
              const style = window.getComputedStyle(el);
              if (
                style.display === 'none' ||
                style.visibility === 'hidden' ||
                parseFloat(style.opacity) === 0
              ) {
                return false;
              }
              const rect = el.getBoundingClientRect();
              return (
                rect.width > 0 ||
                rect.height > 0 ||
                el.getClientRects().length > 0
              );
            };

            let rawElements: Element[];
            try {
              rawElements = queryShadowAll(document, params.segments);
            } catch (err) {
              return {
                ok: false,
                count: 0,
                visibleCount: 0,
                syntaxError: err instanceof Error ? err.message : String(err),
              };
            }

            const textRegex =
              params.textRegexSource !== undefined
                ? new RegExp(params.textRegexSource, params.textRegexFlags)
                : undefined;

            const matched: Element[] = [];
            for (const el of rawElements) {
              if (params.attributeName !== undefined) {
                if (!el.hasAttribute(params.attributeName)) {
                  continue;
                }
                if (
                  params.attributeValue !== undefined &&
                  el.getAttribute(params.attributeName) !==
                    params.attributeValue
                ) {
                  continue;
                }
              }
              if (params.text !== undefined || textRegex !== undefined) {
                const rawText = el.textContent ?? '';
                const inner =
                  el instanceof HTMLElement ? (el.innerText ?? '') : '';
                if (
                  params.text !== undefined &&
                  !rawText.includes(params.text) &&
                  !inner.includes(params.text)
                ) {
                  continue;
                }
                if (textRegex !== undefined) {
                  textRegex.lastIndex = 0;
                  const matchedText = textRegex.test(rawText);
                  textRegex.lastIndex = 0;
                  const matchedInner = textRegex.test(inner);
                  if (!matchedText && !matchedInner) {
                    continue;
                  }
                }
              }
              matched.push(el);
            }

            let visibleCount = 0;
            let firstVisible: Element | undefined;
            for (const el of matched) {
              if (isElementVisible(el)) {
                visibleCount++;
                firstVisible ??= el;
              }
            }

            let ok = false;
            if (params.state === 'attached') {
              ok = matched.length > 0;
            } else if (params.state === 'visible') {
              ok = visibleCount > 0;
            } else if (params.state === 'detached') {
              ok = matched.length === 0;
            } else if (params.state === 'hidden') {
              ok = visibleCount === 0;
            }

            const sample = firstVisible ?? matched[0];
            const sampleText = sample?.textContent?.trim();
            return {
              ok,
              count: matched.length,
              visibleCount,
              tagName: sample?.tagName.toLowerCase(),
              textPreview: sampleText ? sampleText.slice(0, 120) : undefined,
            };
          },
          {
            segments,
            state,
            text: options.text,
            textRegexSource: options.textRegex?.source,
            textRegexFlags: options.textRegex?.flags,
            attributeName: options.attributeName,
            attributeValue: options.attributeValue,
          },
        );

        if (probe.syntaxError) {
          throw new Error(
            `Invalid selector "${options.selector}": ${probe.syntaxError}`,
          );
        }
        lastCount = probe.count;
        lastVisibleCount = probe.visibleCount;
        lastErrorMessage = undefined;
        if (probe.ok) {
          return {
            matched: true,
            selector: options.selector,
            state,
            frameId: getFrameId(targetFrame) ?? options.frameId ?? 'main',
            count: probe.count,
            visibleCount: probe.visibleCount,
            tagName: probe.tagName,
            textPreview: probe.textPreview,
            elapsedMs: Date.now() - startedAt,
          };
        }
      } catch (error) {
        if (
          isDetachedNavigationError(error) &&
          !this.#disposed &&
          !this.isClosed() &&
          Date.now() < deadline
        ) {
          this.textSnapshot = null;
          this.uniqueBackendNodeIdToMcpId.clear();
          lastErrorMessage = getErrorMessage(error);
          await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
          continue;
        }
        throw error;
      }

      if (Date.now() >= deadline) {
        throw new TimeoutError(
          `Timed out after ${timeoutMs}ms waiting for selector "${options.selector}" to become ${state}` +
            `${options.frameId ? ` in frame ${options.frameId}` : ''}` +
            ` (last count=${lastCount}, visibleCount=${lastVisibleCount}` +
            `${lastErrorMessage ? `, lastError=${lastErrorMessage}` : ''}).`,
        );
      }
      const remaining = deadline - Date.now();
      await new Promise(resolve =>
        setTimeout(resolve, Math.min(pollIntervalMs, Math.max(10, remaining))),
      );
    }
  }

  async recoverDetachedFrame(
    _error?: unknown,
  ): Promise<DetachedFrameRecoveryResult> {
    this.textSnapshot = null;
    this.uniqueBackendNodeIdToMcpId.clear();
    const targetId = this.targetId;
    if (this.#disposed || this.isClosed()) {
      return {recovered: false, targetId};
    }
    const previousPage = this.#pptrPage;
    if (previousPage?.browser()?.connected === false) {
      return {recovered: false, targetId};
    }

    let activePage = previousPage;
    try {
      const targetPage = await this.target.page();
      if (targetPage && !targetPage.isClosed()) {
        activePage = targetPage;
      }
    } catch {
      // Keep previousPage if target.page() is unavailable.
    }
    if (!activePage || activePage.isClosed()) {
      return {recovered: false, targetId};
    }

    const mainFrame = activePage.mainFrame();
    if (!mainFrame || mainFrame.detached) {
      return {recovered: false, targetId};
    }

    this.#realtimeNetworkCollector?.syncCdpSession();
    if (this.#shouldInterceptFileChooser()) {
      this.#fileChooserInterceptEnabled = false;
      void this.syncFileChooserInterception();
    }
    return {
      recovered: true,
      targetId,
      frameId: getFrameId(mainFrame),
      url: activePage.url(),
      pageSwapped: previousPage !== undefined && activePage !== previousPage,
    };
  }

  async lighthouseNavigation(flags?: Flags): Promise<RunnerResult | undefined> {
    this.#authFetchSuppressedCount++;
    await this.#syncAuthInterception();
    try {
      return await lighthouseNavigation(this.pptrPage, this.pptrPage.url(), {
        flags,
      });
    } finally {
      this.#authFetchSuppressedCount--;
      await this.#syncAuthInterception();
    }
  }

  async lighthouseSnapshot(flags?: Flags): Promise<RunnerResult | undefined> {
    this.#authFetchSuppressedCount++;
    await this.#syncAuthInterception();
    try {
      return await lighthouseSnapshot(this.pptrPage, {
        flags,
      });
    } finally {
      this.#authFetchSuppressedCount--;
      await this.#syncAuthInterception();
    }
  }

  /**
   * We need to ignore favicon request as they make our test flaky
   */
  async setUpNetworkCollectorForTesting(): Promise<void> {
    this.networkCollector.dispose();
    this.networkCollector = new NetworkCollector(
      this.pptrPage,
      {maxNavigationSaved: this.#config.resolved.maxNavigationSaved},
      collect => {
        return {
          request: req => {
            if (req.url().includes('favicon.ico')) {
              return;
            }
            collect(req);
          },
        } as ListenerMap;
      },
    );
  }
}
