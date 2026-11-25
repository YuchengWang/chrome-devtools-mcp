/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {UncaughtError} from '../../src/collectors/PageCollector.js';
import {McpResponse} from '../../src/McpResponse.js';
import type {
  ConsoleMessage,
  DevTools,
  HTTPRequest,
  HTTPResponse,
  Protocol,
  ResourceType,
} from '../../src/third_party/browser.js';
import {diagnosePageLoad} from '../../src/tools/diagnose.js';
import {DEFAULT_RESPONSE_MAX_BYTES} from '../../src/utils/text.js';
import {createHandlerMocks, createMockServerConfig} from '../mocks.js';
import {getMockAggregatedIssue, getTextContent} from '../utils.js';

function createMockRequest(options: {
  url: string;
  method?: string;
  resourceType?: ResourceType;
  status?: number;
  headers?: Record<string, string>;
  failureErrorText?: string;
  redirectChainUrls?: string[];
}): HTTPRequest {
  const response =
    options.status !== undefined
      ? ({
          status: () => options.status,
          headers: () => options.headers ?? {},
        } as unknown as HTTPResponse)
      : null;

  const redirectChain = (options.redirectChainUrls ?? []).map(
    hopUrl =>
      ({
        url: () => hopUrl,
      }) as unknown as HTTPRequest,
  );

  return {
    url: () => options.url,
    method: () => options.method ?? 'GET',
    resourceType: () => options.resourceType ?? 'document',
    failure: () =>
      options.failureErrorText ? {errorText: options.failureErrorText} : null,
    response: () => response,
    redirectChain: () => redirectChain,
  } as unknown as HTTPRequest;
}

function createMockConsoleError(text: string, url?: string): ConsoleMessage {
  return {
    type: () => 'error',
    text: () => text,
    location: () => ({url}),
  } as unknown as ConsoleMessage;
}

async function runDiagnose(options: {
  requests?: HTTPRequest[];
  consoleItems?: Array<
    ConsoleMessage | Error | DevTools.AggregatedIssue | UncaughtError
  >;
  pageUrl?: string;
  evaluateResult?: unknown;
  evaluateError?: Error;
  params?: {
    includePreservedRequests?: boolean;
    focusUrlPattern?: string;
    includeTimingSummary?: boolean;
  };
}): Promise<string> {
  const {page, context, args} = createHandlerMocks();
  const response = new McpResponse(createMockServerConfig());

  page.pptrPage.url.returns(options.pageUrl ?? 'https://example.com/');
  page.getNetworkRequests.returns(options.requests ?? []);
  page.getConsoleData.returns(options.consoleItems ?? []);

  if (options.evaluateError) {
    page.pptrPage.evaluate.rejects(options.evaluateError);
  } else {
    page.pptrPage.evaluate.resolves(
      options.evaluateResult ?? {
        ttfbMs: 120,
        domContentLoadedMs: 350,
        loadMs: 600,
        resources: [],
      },
    );
  }

  await diagnosePageLoad(args).handler(
    {
      params: options.params ?? {},
      page,
    },
    response,
    context,
  );

  const handled = await response.handle(context);
  return getTextContent(handled.content[0]);
}

describe('diagnose_page_load', () => {
  it('categorizes Network/Proxy failures as Blocker with proxy guidance', async () => {
    const text = await runDiagnose({
      requests: [
        createMockRequest({
          url: 'https://api.example.com/data',
          resourceType: 'fetch',
          failureErrorText: 'net::ERR_PROXY_CONNECTION_FAILED',
        }),
        createMockRequest({
          url: 'https://cdn.example.com/app.js',
          resourceType: 'script',
          failureErrorText: 'net::ERR_NAME_NOT_RESOLVED',
        }),
      ],
    });

    assert.ok(text.includes('[Blocker] Network/Proxy'));
    assert.ok(text.includes('ERR_PROXY_CONNECTION_FAILED'));
    assert.ok(text.includes('ERR_NAME_NOT_RESOLVED'));
    assert.ok(text.includes('v2rayN'));
    assert.ok(text.includes('--proxy-server'));
  });

  it('categorizes SSL/TLS errors as Blocker with clock/CA/insecure-certs guidance', async () => {
    const text = await runDiagnose({
      requests: [
        createMockRequest({
          url: 'https://selfsigned.example.com/',
          resourceType: 'document',
          failureErrorText: 'net::ERR_CERT_AUTHORITY_INVALID',
        }),
      ],
    });

    assert.ok(text.includes('[Blocker] SSL/TLS'));
    assert.ok(text.includes('ERR_CERT_AUTHORITY_INVALID'));
    assert.ok(text.includes('system clock'));
    assert.ok(text.includes('--acceptInsecureCerts'));
  });

  it('categorizes CORS/CSP network blocks and DevTools AggregatedIssues', async () => {
    const corsIssue = getMockAggregatedIssue();
    corsIssue.code.returns('CorsIssue');
    corsIssue.getAllIssues.returns([
      {
        details: () => ({
          request: {url: 'https://api.other.com/v1/items'},
          corsErrorStatus: {corsError: 'MissingAllowOriginHeader'},
        }),
      },
    ] as unknown as DevTools.Issue[]);

    const cspIssue = getMockAggregatedIssue();
    cspIssue.code.returns('ContentSecurityPolicyIssue');
    cspIssue.getAllIssues.returns([
      {
        details: () => ({
          blockedURL: 'https://evil.example.com/script.js',
          violatedDirective: 'script-src',
        }),
      },
    ] as unknown as DevTools.Issue[]);

    const text = await runDiagnose({
      requests: [
        createMockRequest({
          url: 'https://tracker.example.com/pixel.png',
          resourceType: 'image',
          failureErrorText: 'net::ERR_BLOCKED_BY_CLIENT',
        }),
      ],
      consoleItems: [corsIssue, cspIssue],
    });

    assert.ok(text.includes('[Blocker] CORS/CSP'));
    assert.ok(text.includes('https://api.other.com/v1/items'));
    assert.ok(text.includes('MissingAllowOriginHeader'));
    assert.ok(text.includes('https://evil.example.com/script.js'));
    assert.ok(text.includes('script-src'));
    assert.ok(text.includes('[Warning] CORS/CSP'));
  });

  it('categorizes Auth/Permissions (401/403 and auth redirects) and suggests autoConnect / existing_profile', async () => {
    const text = await runDiagnose({
      requests: [
        createMockRequest({
          url: 'https://app.example.com/api/me',
          resourceType: 'fetch',
          status: 401,
        }),
        createMockRequest({
          url: 'https://app.example.com/dashboard',
          resourceType: 'document',
          status: 200,
          redirectChainUrls: ['https://sso.example.com/oauth/authorize'],
        }),
      ],
    });

    assert.ok(text.includes('[Blocker] Auth/Permissions'));
    assert.ok(text.includes('HTTP 401'));
    assert.ok(text.includes('/oauth/authorize'));
    assert.ok(text.includes('--autoConnect'));
    assert.ok(text.includes('existing_profile'));
  });

  it('categorizes Rate Limit (429) and extracts Retry-After and X-RateLimit-* headers', async () => {
    const text = await runDiagnose({
      requests: [
        createMockRequest({
          url: 'https://api.example.com/search',
          resourceType: 'xhr',
          status: 429,
          headers: {
            'Retry-After': '30',
            'X-RateLimit-Remaining': '0',
          },
        }),
      ],
    });

    assert.ok(text.includes('Rate Limit'));
    assert.ok(text.includes('Retry-After=30'));
    assert.ok(text.includes('backoff'));
  });

  it('categorizes Anti-bot/CAPTCHA gates as alert-only without bypass logic', async () => {
    const text = await runDiagnose({
      requests: [
        createMockRequest({
          url: 'https://protected.example.com/',
          resourceType: 'document',
          status: 403,
          headers: {
            'cf-mitigated': 'challenge',
          },
        }),
        createMockRequest({
          url: 'https://challenges.cloudflare.com/turnstile/v0/api.js',
          resourceType: 'script',
          status: 200,
        }),
      ],
    });

    assert.ok(text.includes('[Blocker] Anti-bot/CAPTCHA'));
    assert.ok(text.includes('cf-mitigated: challenge'));
    assert.ok(text.includes('no automated bypass'));
    assert.ok(text.includes('manually in a visible browser'));
  });

  it('orders findings by severity Blocker > Warning > Info and includes top 5 slow resources', async () => {
    const text = await runDiagnose({
      requests: [
        createMockRequest({
          url: 'https://example.com/missing.png',
          resourceType: 'image',
          status: 404,
        }),
        createMockRequest({
          url: 'https://example.com/',
          resourceType: 'document',
          failureErrorText: 'net::ERR_TIMED_OUT',
        }),
      ],
      consoleItems: [
        createMockConsoleError('Minor widget warning'),
        new UncaughtError(
          {
            exceptionId: 1,
            text: 'Uncaught ReferenceError: foo is not defined',
            lineNumber: 1,
            columnNumber: 1,
          } as Protocol.Runtime.ExceptionDetails,
          'target-1',
        ),
      ],
      evaluateResult: {
        ttfbMs: 80,
        domContentLoadedMs: 250,
        loadMs: 900,
        resources: [
          {
            name: 'https://example.com/a.js',
            initiatorType: 'script',
            durationMs: 100,
            transferSize: 1000,
          },
          {
            name: 'https://example.com/b.js',
            initiatorType: 'script',
            durationMs: 500,
            transferSize: 2000,
          },
          {
            name: 'https://example.com/c.css',
            initiatorType: 'link',
            durationMs: 200,
            transferSize: 500,
          },
          {
            name: 'https://example.com/d.png',
            initiatorType: 'img',
            durationMs: 700,
            transferSize: 3000,
          },
          {
            name: 'https://example.com/e.woff2',
            initiatorType: 'css',
            durationMs: 300,
            transferSize: 4000,
          },
          {
            name: 'https://example.com/f.json',
            initiatorType: 'fetch',
            durationMs: 400,
            transferSize: 600,
          },
        ],
      },
    });

    const blockerIdx = text.indexOf('[Blocker]');
    const warningIdx = text.indexOf('[Warning]');
    assert.ok(blockerIdx !== -1 && warningIdx !== -1);
    assert.ok(blockerIdx < warningIdx);

    assert.ok(text.includes('TTFB=80ms, DOMContentLoaded=250ms, Load=900ms'));
    assert.ok(text.includes('700ms [img] (3000 B) https://example.com/d.png'));
    assert.ok(
      text.includes('500ms [script] (2000 B) https://example.com/b.js'),
    );
    assert.ok(!text.includes('https://example.com/a.js'));
  });

  it('filters by focusUrlPattern and falls back gracefully when page.evaluate fails', async () => {
    const text = await runDiagnose({
      requests: [
        createMockRequest({
          url: 'https://api.target.com/v1/data',
          resourceType: 'fetch',
          status: 500,
        }),
        createMockRequest({
          url: 'https://other.com/ignored',
          resourceType: 'fetch',
          failureErrorText: 'net::ERR_CONNECTION_REFUSED',
        }),
      ],
      evaluateError: new Error('Execution context was destroyed'),
      params: {
        focusUrlPattern: '*api.target.com*',
        includePreservedRequests: false,
        includeTimingSummary: true,
      },
    });

    assert.ok(text.includes('Inspected: 1 network request(s)'));
    assert.ok(text.includes('https://api.target.com/v1/data'));
    assert.ok(!text.includes('ERR_CONNECTION_REFUSED'));
    assert.ok(
      text.includes(
        'Timing fallback: Timing evaluation failed (Execution context was destroyed)',
      ),
    );
  });

  it('respects McpResponse 8800B Head-Tail cap when many errors exist', async () => {
    const manyErrors = Array.from({length: 80}, (_, i) =>
      createMockConsoleError(
        `Unique runtime failure #${i}: ${'x'.repeat(180)}`,
        `https://example.com/chunk-${i}.js`,
      ),
    );
    const text = await runDiagnose({
      consoleItems: manyErrors,
      params: {includeTimingSummary: false},
    });

    assert.ok(
      Buffer.byteLength(text, 'utf8') <= DEFAULT_RESPONSE_MAX_BYTES,
      `Expected <= ${DEFAULT_RESPONSE_MAX_BYTES} bytes, got ${Buffer.byteLength(text, 'utf8')}`,
    );
    assert.ok(text.includes('truncated'));
    assert.ok(!text.includes('## Timing Summary'));
  });
});
