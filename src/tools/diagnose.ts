/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {UncaughtError} from '../collectors/PageCollector.js';
import type {
  ConsoleMessage,
  DevTools,
  HTTPRequest,
} from '../third_party/browser.js';
import {zod} from '../third_party/index.js';
import {getErrorMessage} from '../utils/errorHandling.js';
import {truncateText, truncateUrl} from '../utils/text.js';

import {ToolCategory} from './categories.js';
import {
  definePageTool,
  type ContextPage,
  type PageToolFactory,
} from './ToolDefinition.js';

export type DiagnosticSeverity = 'Blocker' | 'Warning' | 'Info';

export type DiagnosticCategory =
  | 'Network/Proxy'
  | 'SSL/TLS'
  | 'CORS/CSP'
  | 'Auth/Permissions'
  | 'Rate Limit'
  | 'Anti-bot/CAPTCHA'
  | 'HTTP Error'
  | 'Console/Runtime';

export interface DiagnosticFinding {
  severity: DiagnosticSeverity;
  category: DiagnosticCategory;
  summary: string;
  evidence: string[];
  solution: string;
}

interface SlowResourceEntry {
  name: string;
  initiatorType: string;
  durationMs: number;
  transferSize: number;
}

interface TimingSummary {
  ttfbMs?: number;
  domContentLoadedMs?: number;
  loadMs?: number;
  slowResources: SlowResourceEntry[];
}

interface TimingSummaryResult {
  summary?: TimingSummary;
  fallbackReason?: string;
}

type ConsoleCollectorItem =
  ConsoleMessage | Error | DevTools.AggregatedIssue | UncaughtError;

const SEVERITY_ORDER: Record<DiagnosticSeverity, number> = {
  Blocker: 0,
  Warning: 1,
  Info: 2,
};

const NETWORK_PROXY_ERRORS = new Set([
  'net::ERR_PROXY_CONNECTION_FAILED',
  'ERR_PROXY_CONNECTION_FAILED',
  'net::ERR_TUNNEL_CONNECTION_FAILED',
  'ERR_TUNNEL_CONNECTION_FAILED',
  'net::ERR_SOCKS_CONNECTION_FAILED',
  'ERR_SOCKS_CONNECTION_FAILED',
  'net::ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_REFUSED',
  'net::ERR_TIMED_OUT',
  'ERR_TIMED_OUT',
  'net::ERR_NAME_NOT_RESOLVED',
  'ERR_NAME_NOT_RESOLVED',
  'net::ERR_CONNECTION_RESET',
  'ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_CLOSED',
  'net::ERR_INTERNET_DISCONNECTED',
  'ERR_INTERNET_DISCONNECTED',
  'net::ERR_NETWORK_CHANGED',
  'ERR_NETWORK_CHANGED',
]);

const AUTH_REDIRECT_PATH_PATTERN =
  /(^|\/)(login|signin|sso|oauth|auth)(\/|\?|#|$)/i;

const ANTIBOT_URL_OR_TEXT_PATTERN =
  /challenges\.cloudflare\.com\/turnstile|cf-chl-|\/cdn-cgi\/challenge-platform|google\.com\/recaptcha|recaptcha\.net|hcaptcha\.com|turnstile/i;

const CRITICAL_RESOURCE_TYPES = new Set(['document', 'script', 'xhr', 'fetch']);

const MAX_EVIDENCE_ITEMS = 5;
const MAX_SLOW_RESOURCES = 5;
const MAX_FINDINGS_PER_REPORT = 30;

function matchesUrlPattern(url: string, pattern?: string): boolean {
  if (!pattern) {
    return true;
  }
  const trimmed = pattern.trim();
  if (!trimmed) {
    return true;
  }
  const lowerUrl = url.toLowerCase();
  if (!trimmed.includes('*')) {
    return lowerUrl.includes(trimmed.toLowerCase());
  }
  const escaped = trimmed
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*');
  return new RegExp(escaped, 'i').test(url);
}

function getHeaderCaseInsensitive(
  headers: Record<string, string> | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function collectRateLimitHeaders(
  headers: Record<string, string> | undefined,
): string[] {
  if (!headers) {
    return [];
  }
  const matched: string[] = [];
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (lower === 'retry-after' || lower.startsWith('x-ratelimit-')) {
      matched.push(`${key}: ${value}`);
    }
  }
  return matched;
}

function isAuthRedirectUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return AUTH_REDIRECT_PATH_PATTERN.test(parsed.pathname);
  } catch {
    return AUTH_REDIRECT_PATH_PATTERN.test(url);
  }
}

function isNetworkProxyError(errorText: string): boolean {
  if (NETWORK_PROXY_ERRORS.has(errorText)) {
    return true;
  }
  return (
    errorText.includes('ERR_PROXY_CONNECTION_FAILED') ||
    errorText.includes('ERR_TUNNEL_CONNECTION_FAILED') ||
    errorText.includes('ERR_SOCKS_CONNECTION_FAILED') ||
    errorText.includes('ERR_CONNECTION_REFUSED') ||
    errorText.includes('ERR_TIMED_OUT') ||
    errorText.includes('ERR_NAME_NOT_RESOLVED')
  );
}

function isSslTlsError(errorText: string): boolean {
  return /ERR_(CERT|SSL)_[A-Z0-9_]+/.test(errorText);
}

function isCorsOrCspNetworkError(errorText: string): boolean {
  return (
    errorText.includes('ERR_BLOCKED_BY_RESPONSE') ||
    errorText.includes('ERR_BLOCKED_BY_CLIENT')
  );
}

function addFinding(
  findingsMap: Map<string, DiagnosticFinding>,
  key: string,
  finding: DiagnosticFinding,
): void {
  const existing = findingsMap.get(key);
  if (!existing) {
    findingsMap.set(key, {
      ...finding,
      evidence: finding.evidence.slice(0, MAX_EVIDENCE_ITEMS),
    });
    return;
  }
  if (SEVERITY_ORDER[finding.severity] < SEVERITY_ORDER[existing.severity]) {
    existing.severity = finding.severity;
  }
  for (const item of finding.evidence) {
    if (
      existing.evidence.length < MAX_EVIDENCE_ITEMS &&
      !existing.evidence.includes(item)
    ) {
      existing.evidence.push(item);
    }
  }
}

function analyzeNetworkRequest(
  req: HTTPRequest,
  findingsMap: Map<string, DiagnosticFinding>,
): void {
  const url = req.url();
  const shortUrl = truncateUrl(url);
  const resourceType = req.resourceType();
  const isCritical = CRITICAL_RESOURCE_TYPES.has(resourceType);
  const failure = req.failure()?.errorText;
  const response = req.response();
  const status = response?.status();
  const headers = response?.headers();

  if (failure) {
    if (isNetworkProxyError(failure)) {
      addFinding(findingsMap, `network-proxy:${failure}`, {
        severity: 'Blocker',
        category: 'Network/Proxy',
        summary: `Network/proxy connection failure (${failure})`,
        evidence: [`[${resourceType}] ${shortUrl} -> ${failure}`],
        solution:
          'Check your local proxy client (e.g. v2rayN), verify `--proxy-server` configuration, switch proxy nodes, or confirm DNS and target host reachability.',
      });
      return;
    }

    if (isSslTlsError(failure)) {
      addFinding(findingsMap, `ssl-tls:${failure}`, {
        severity: 'Blocker',
        category: 'SSL/TLS',
        summary: `SSL/TLS handshake or certificate failure (${failure})`,
        evidence: [`[${resourceType}] ${shortUrl} -> ${failure}`],
        solution:
          'Verify the system clock is accurate, install/trust any proxy MITM root CA certificate, or pass `--acceptInsecureCerts` in non-production test environments.',
      });
      return;
    }

    if (isCorsOrCspNetworkError(failure)) {
      addFinding(findingsMap, `cors-csp-net:${failure}`, {
        severity: isCritical ? 'Blocker' : 'Warning',
        category: 'CORS/CSP',
        summary: `Request blocked by browser security policy or client (${failure})`,
        evidence: [`[${resourceType}] ${shortUrl} -> ${failure}`],
        solution:
          'Inspect the blocked URL and verify response headers (`Access-Control-Allow-Origin`, `Cross-Origin-Resource-Policy`) or Content-Security-Policy directives (`connect-src`, `script-src`, `frame-ancestors`).',
      });
      return;
    }

    if (failure !== 'net::ERR_ABORTED') {
      addFinding(findingsMap, `http-fail:${failure}`, {
        severity: isCritical ? 'Blocker' : 'Warning',
        category: 'HTTP Error',
        summary: `Request failed (${failure})`,
        evidence: [`[${resourceType}] ${shortUrl} -> ${failure}`],
        solution:
          'Inspect network request details with `get_network_request` to determine why the request did not complete.',
      });
    }
    return;
  }

  // Check Anti-bot / CAPTCHA gate before generic 403/503 Auth or HTTP Error.
  const cfMitigated = getHeaderCaseInsensitive(headers, 'cf-mitigated');
  const hasCfChallenge =
    cfMitigated?.toLowerCase().includes('challenge') ?? false;
  const hasAntiBotSignal =
    hasCfChallenge || ANTIBOT_URL_OR_TEXT_PATTERN.test(url);

  if (
    hasAntiBotSignal &&
    (status === 403 || status === 503 || status === undefined || status === 200)
  ) {
    const signals: string[] = [];
    if (hasCfChallenge) {
      signals.push(`cf-mitigated: ${cfMitigated}`);
    }
    const urlMatch = url.match(ANTIBOT_URL_OR_TEXT_PATTERN);
    if (urlMatch) {
      signals.push(`signal: ${urlMatch[0]}`);
    }
    addFinding(findingsMap, 'antibot-captcha', {
      severity: 'Blocker',
      category: 'Anti-bot/CAPTCHA',
      summary: `Anti-bot or CAPTCHA challenge detected${status ? ` (HTTP ${status})` : ''}`,
      evidence: [`[${resourceType}] ${shortUrl} (${signals.join(', ')})`],
      solution:
        'Alert only (no automated bypass). Instruct the user to solve the CAPTCHA/challenge manually in a visible browser window.',
    });
    return;
  }

  // Check Rate Limit (429).
  if (status === 429) {
    const rateHeaders = collectRateLimitHeaders(headers);
    const retryAfter = getHeaderCaseInsensitive(headers, 'retry-after');
    const waitHint = retryAfter
      ? `Retry-After=${retryAfter}`
      : rateHeaders.length > 0
        ? rateHeaders.join(', ')
        : 'no Retry-After header provided';
    addFinding(findingsMap, 'rate-limit:429', {
      severity: isCritical ? 'Blocker' : 'Warning',
      category: 'Rate Limit',
      summary: `Rate limited with HTTP 429 (${waitHint})`,
      evidence: [`[${resourceType}] ${shortUrl} -> 429 (${waitHint})`],
      solution: `Respect the server rate limit (${waitHint}), apply exponential backoff, and reduce request concurrency or frequency.`,
    });
    return;
  }

  // Check Auth/Permissions (401, 403, or redirects to login/sso/oauth/auth).
  const locationHeader = getHeaderCaseInsensitive(headers, 'location');
  const redirectUrls = req.redirectChain().map(hop => hop.url());
  const authRedirectTarget = [
    ...redirectUrls,
    ...(locationHeader ? [locationHeader] : []),
    url,
  ].find(candidate => isAuthRedirectUrl(candidate));

  if (status === 401 || status === 403 || authRedirectTarget) {
    const reason =
      status === 401 || status === 403
        ? `HTTP ${status}`
        : `redirected to ${truncateUrl(authRedirectTarget ?? url)}`;
    addFinding(findingsMap, `auth:${status ?? 'redirect'}`, {
      severity:
        isCritical || Boolean(authRedirectTarget) ? 'Blocker' : 'Warning',
      category: 'Auth/Permissions',
      summary: `Authentication or permission required (${reason})`,
      evidence: [`[${resourceType}] ${shortUrl} -> ${reason}`],
      solution:
        'Switch to `--autoConnect` or `cua-ycwang` `existing_profile` so the user can log in interactively and reuse an authenticated browser session.',
    });
    return;
  }

  // Other 4xx / 5xx HTTP errors.
  if (status !== undefined && status >= 400) {
    addFinding(findingsMap, `http-status:${status}`, {
      severity: status >= 500 && isCritical ? 'Blocker' : 'Warning',
      category: 'HTTP Error',
      summary: `HTTP ${status} error response`,
      evidence: [`[${resourceType}] ${shortUrl} -> HTTP ${status}`],
      solution:
        'Inspect the response payload and headers with `get_network_request` to debug the server or endpoint error.',
    });
  }
}

function extractIssueEvidence(issue: DevTools.AggregatedIssue): {
  urls: string[];
  detailsSummary: string[];
} {
  const urls: string[] = [];
  const detailsSummary: string[] = [];

  for (const singleIssue of issue.getAllIssues()) {
    const details = singleIssue.details() as unknown as
      Record<string, unknown> | undefined;
    if (!details || typeof details !== 'object') {
      continue;
    }
    const request = details.request as {url?: unknown} | undefined;
    if (request && typeof request.url === 'string') {
      urls.push(request.url);
    }
    if (typeof details.blockedURL === 'string') {
      urls.push(details.blockedURL);
    }
    if (typeof details.violatedDirective === 'string') {
      detailsSummary.push(`directive: ${details.violatedDirective}`);
    }
    const corsErrorStatus = details.corsErrorStatus as
      {corsError?: unknown} | undefined;
    if (corsErrorStatus && typeof corsErrorStatus.corsError === 'string') {
      detailsSummary.push(`corsError: ${corsErrorStatus.corsError}`);
    }
  }

  return {urls, detailsSummary};
}

function isAggregatedIssue(
  item: ConsoleCollectorItem,
): item is DevTools.AggregatedIssue {
  return (
    typeof item === 'object' &&
    item !== null &&
    !(item instanceof Error) &&
    !(item instanceof UncaughtError) &&
    'getAllIssues' in item &&
    typeof item.getAllIssues === 'function' &&
    'code' in item &&
    typeof item.code === 'function'
  );
}

function analyzeConsoleItem(
  item: ConsoleCollectorItem,
  focusUrlPattern: string | undefined,
  findingsMap: Map<string, DiagnosticFinding>,
): void {
  if (isAggregatedIssue(item)) {
    const code = item.code();
    const {urls, detailsSummary} = extractIssueEvidence(item);

    if (
      focusUrlPattern &&
      urls.length > 0 &&
      !urls.some(u => matchesUrlPattern(u, focusUrlPattern))
    ) {
      return;
    }

    const isCors = code.includes('CorsIssue');
    const isCsp = code.includes('ContentSecurityPolicyIssue');
    if (isCors || isCsp) {
      const shortUrls = urls.map(u => truncateUrl(u));
      const evidenceParts = [
        `issue=${code}`,
        ...detailsSummary,
        ...(shortUrls.length > 0 ? [`urls: ${shortUrls.join(', ')}`] : []),
      ];
      addFinding(findingsMap, `issue:${code}`, {
        severity: 'Blocker',
        category: 'CORS/CSP',
        summary: isCors
          ? `CORS policy violation (${code})`
          : `Content Security Policy violation (${code})`,
        evidence: [evidenceParts.join(' | ')],
        solution: isCors
          ? 'Configure the server to return matching `Access-Control-Allow-Origin`, `Access-Control-Allow-Methods`, and `Access-Control-Allow-Headers` response headers.'
          : 'Update the page `Content-Security-Policy` header/meta directives (e.g., `script-src`, `connect-src`, `img-src`, `frame-ancestors`) to allow the blocked resource.',
      });
    }
    return;
  }

  let text = '';
  let sourceUrl: string | undefined;

  if (item instanceof UncaughtError) {
    text =
      item.details.exception?.description ??
      item.details.text ??
      'Uncaught exception';
    sourceUrl = item.details.url;
  } else if (item instanceof Error) {
    text = item.message;
  } else {
    if (item.type() !== 'error') {
      return;
    }
    text = item.text();
    sourceUrl = item.location()?.url;
  }

  if (
    focusUrlPattern &&
    sourceUrl &&
    !matchesUrlPattern(sourceUrl, focusUrlPattern) &&
    !matchesUrlPattern(text, focusUrlPattern)
  ) {
    return;
  }

  const truncatedText = truncateText(text, 240);

  if (ANTIBOT_URL_OR_TEXT_PATTERN.test(text)) {
    addFinding(findingsMap, 'antibot-captcha-console', {
      severity: 'Blocker',
      category: 'Anti-bot/CAPTCHA',
      summary: 'Anti-bot or CAPTCHA signal reported in console',
      evidence: [truncatedText],
      solution:
        'Alert only (no automated bypass). Instruct the user to solve the CAPTCHA/challenge manually in a visible browser window.',
    });
    return;
  }

  if (
    /Access-Control-Allow-Origin|CORS policy|Content Security Policy|Content-Security-Policy/i.test(
      text,
    )
  ) {
    addFinding(findingsMap, 'cors-csp-console', {
      severity: 'Blocker',
      category: 'CORS/CSP',
      summary: 'CORS or CSP error reported in console',
      evidence: [truncatedText],
      solution:
        'Check the blocked origin/resource in the error message and add the required CORS headers or CSP directives.',
    });
    return;
  }

  addFinding(findingsMap, `console-error:${truncatedText.slice(0, 60)}`, {
    severity: 'Warning',
    category: 'Console/Runtime',
    summary: 'Console error or uncaught runtime exception',
    evidence: [
      sourceUrl
        ? `${truncatedText} (${truncateUrl(sourceUrl)})`
        : truncatedText,
    ],
    solution:
      'Inspect the console stack trace with `list_console_messages` (`includeStackTraces: true`) to locate the failing script.',
  });
}

async function collectTimingSummary(
  page: ContextPage,
  focusUrlPattern?: string,
): Promise<TimingSummaryResult> {
  try {
    const raw = await page.pptrPage.evaluate(() => {
      const navEntries = performance.getEntriesByType('navigation') as Array<{
        startTime?: number;
        responseStart?: number;
        domContentLoadedEventEnd?: number;
        loadEventEnd?: number;
      }>;
      const nav = navEntries[0];
      const resources = performance.getEntriesByType('resource') as Array<{
        name: string;
        initiatorType?: string;
        duration?: number;
        transferSize?: number;
      }>;

      return {
        ttfbMs:
          nav && typeof nav.responseStart === 'number'
            ? Math.round(nav.responseStart - (nav.startTime ?? 0))
            : undefined,
        domContentLoadedMs:
          nav &&
          typeof nav.domContentLoadedEventEnd === 'number' &&
          nav.domContentLoadedEventEnd > 0
            ? Math.round(nav.domContentLoadedEventEnd - (nav.startTime ?? 0))
            : undefined,
        loadMs:
          nav && typeof nav.loadEventEnd === 'number' && nav.loadEventEnd > 0
            ? Math.round(nav.loadEventEnd - (nav.startTime ?? 0))
            : undefined,
        resources: resources.map(entry => ({
          name: entry.name,
          initiatorType: entry.initiatorType ?? 'other',
          durationMs: Math.round(entry.duration ?? 0),
          transferSize: entry.transferSize ?? 0,
        })),
      };
    });

    if (!raw || !Array.isArray(raw.resources)) {
      return {
        fallbackReason:
          'Performance timing entries were unavailable on the current page.',
      };
    }

    const slowResources = raw.resources
      .filter(entry => matchesUrlPattern(entry.name, focusUrlPattern))
      .sort((a, b) => b.durationMs - a.durationMs)
      .slice(0, MAX_SLOW_RESOURCES);

    return {
      summary: {
        ttfbMs: raw.ttfbMs,
        domContentLoadedMs: raw.domContentLoadedMs,
        loadMs: raw.loadMs,
        slowResources,
      },
    };
  } catch (error) {
    return {
      fallbackReason: `Timing evaluation failed (${getErrorMessage(error)})`,
    };
  }
}

export const diagnosePageLoad: PageToolFactory = definePageTool(() => ({
  name: 'diagnose_page_load',
  description:
    'Diagnoses page load failures, network/proxy errors, SSL/TLS issues, CORS/CSP blocks, auth redirects, rate limits, anti-bot/CAPTCHA gates, and slow resource timings on the selected page.',
  annotations: {
    category: ToolCategory.DEBUGGING,
    readOnlyHint: true,
  },
  schema: {
    includePreservedRequests: zod
      .boolean()
      .default(true)
      .optional()
      .describe(
        'Whether to include preserved requests and console messages from recent navigations. Default is true.',
      ),
    focusUrlPattern: zod
      .string()
      .optional()
      .describe(
        'Optional substring or wildcard (`*`) pattern to focus diagnostics on matching URLs.',
      ),
    includeTimingSummary: zod
      .boolean()
      .default(true)
      .optional()
      .describe(
        'Whether to collect navigation timing and top 5 slowest resources via performance.getEntriesByType. Default is true.',
      ),
  },
  blockedByDialog: false,
  concurrency: 'page',
  verifyFilesSchema: {},
  handler: async (request, response) => {
    const includePreserved = request.params.includePreservedRequests ?? true;
    const focusUrlPattern = request.params.focusUrlPattern;
    const includeTimingSummary = request.params.includeTimingSummary ?? true;

    const allRequests = request.page.getNetworkRequests(includePreserved);
    const filteredRequests = focusUrlPattern
      ? allRequests.filter(
          req =>
            matchesUrlPattern(req.url(), focusUrlPattern) ||
            req
              .redirectChain()
              .some(hop => matchesUrlPattern(hop.url(), focusUrlPattern)),
        )
      : allRequests;

    const consoleItems = request.page.getConsoleData(includePreserved);

    const findingsMap = new Map<string, DiagnosticFinding>();
    for (const req of filteredRequests) {
      analyzeNetworkRequest(req, findingsMap);
    }
    for (const item of consoleItems) {
      analyzeConsoleItem(item, focusUrlPattern, findingsMap);
    }

    const findings = Array.from(findingsMap.values())
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity])
      .slice(0, MAX_FINDINGS_PER_REPORT);

    const timingResult = includeTimingSummary
      ? await collectTimingSummary(request.page, focusUrlPattern)
      : undefined;

    const pageUrl = request.page.pptrPage.url();
    const blockers = findings.filter(f => f.severity === 'Blocker').length;
    const warnings = findings.filter(f => f.severity === 'Warning').length;
    const infos = findings.filter(f => f.severity === 'Info').length;

    response.appendResponseLine(`# Page Load Diagnosis`);
    response.appendResponseLine(
      `URL: ${pageUrl ? truncateUrl(pageUrl) : '(unknown)'}`,
    );
    if (focusUrlPattern) {
      response.appendResponseLine(`Focus URL pattern: ${focusUrlPattern}`);
    }
    response.appendResponseLine(
      `Inspected: ${filteredRequests.length} network request(s), ${consoleItems.length} console item(s) (includePreserved=${includePreserved})`,
    );
    response.appendResponseLine(
      `Findings: ${blockers} Blocker, ${warnings} Warning, ${infos} Info`,
    );
    response.appendResponseLine('');

    if (findings.length === 0) {
      response.appendResponseLine(
        '## Root Causes\nNo blocking errors, failed requests, or console exceptions were detected.',
      );
    } else {
      response.appendResponseLine('## Root Causes');
      for (const finding of findings) {
        response.appendResponseLine(
          `### [${finding.severity}] ${finding.category}: ${finding.summary}`,
        );
        for (const ev of finding.evidence) {
          response.appendResponseLine(`- Evidence: ${ev}`);
        }
        response.appendResponseLine(`- Solution: ${finding.solution}`);
      }
    }

    if (includeTimingSummary && timingResult) {
      response.appendResponseLine('');
      response.appendResponseLine('## Timing Summary');
      if (timingResult.summary) {
        const {ttfbMs, domContentLoadedMs, loadMs, slowResources} =
          timingResult.summary;
        const navParts: string[] = [];
        if (ttfbMs !== undefined) {
          navParts.push(`TTFB=${ttfbMs}ms`);
        }
        if (domContentLoadedMs !== undefined) {
          navParts.push(`DOMContentLoaded=${domContentLoadedMs}ms`);
        }
        if (loadMs !== undefined) {
          navParts.push(`Load=${loadMs}ms`);
        }
        if (navParts.length > 0) {
          response.appendResponseLine(`Navigation: ${navParts.join(', ')}`);
        }
        if (slowResources.length === 0) {
          response.appendResponseLine('Slowest resources: (none)');
        } else {
          response.appendResponseLine('Top 5 slowest resources:');
          for (const res of slowResources) {
            response.appendResponseLine(
              `- ${res.durationMs}ms [${res.initiatorType}] (${res.transferSize} B) ${truncateUrl(res.name)}`,
            );
          }
        }
      } else if (timingResult.fallbackReason) {
        response.appendResponseLine(
          `Timing fallback: ${timingResult.fallbackReason}`,
        );
      }
    }
  },
}));
