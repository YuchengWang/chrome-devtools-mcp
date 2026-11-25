/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  parseWsHeaders,
  validateBrowserUrl,
  validateWsEndpoint,
} from '../utils/url.js';

import type {McpOptionsFor} from './category-options.js';

export interface BrowserArguments {
  autoConnect: boolean;
  browserUrl?: string;
  wsEndpoint?: string;
  wsHeaders?: Record<string, string>;
  headless: boolean;
  executablePath?: string;
  isolated: boolean;
  userDataDir?: string;
  channel?: 'canary' | 'dev' | 'beta' | 'stable';
  proxyServer?: string;
  chromeArg?: string[];
  ignoreDefaultChromeArg?: string[];
}

export type BrowserOptions = McpOptionsFor<BrowserArguments>;

export const browserOptions: BrowserOptions = {
  autoConnect: {
    type: 'boolean',
    description:
      'If specified, automatically connects to a browser (Chrome 144+) running locally from the user data directory identified by the channel param (default channel is stable). Requires the remote debugging server to be started in the Chrome instance via chrome://inspect/#remote-debugging.',
    default: false,
  },
  browserUrl: {
    type: 'string',
    description:
      'Connect to a running, debuggable Chrome instance (e.g. `http://127.0.0.1:9222`). For more details see: https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md#connecting-to-a-running-chrome-instance.',
    alias: 'u',
    coerce: (url: string | undefined): string | undefined => {
      if (!url) {
        return;
      }
      return validateBrowserUrl(url);
    },
  },
  wsEndpoint: {
    type: 'string',
    description:
      'WebSocket endpoint to connect to a running Chrome instance (e.g., ws://127.0.0.1:9222/devtools/browser/<id>). Alternative to --browserUrl.',
    alias: 'w',
    coerce: (url: string | undefined): string | undefined => {
      if (!url) {
        return;
      }
      return validateWsEndpoint(url);
    },
  },
  wsHeaders: {
    type: 'string',
    description:
      'Custom headers for WebSocket connection in JSON format (e.g., \'{"Authorization":"Bearer token"}\'). Only works with --wsEndpoint.',
    coerce: (val: unknown): Record<string, string> | undefined => {
      return parseWsHeaders(val);
    },
  },
  headless: {
    type: 'boolean',
    description: 'Whether to run in headless (no UI) mode.',
    default: false,
  },
  executablePath: {
    type: 'string',
    description: 'Path to custom Chrome executable.',
    alias: 'e',
  },
  isolated: {
    type: 'boolean',
    description:
      'If specified, creates a temporary user-data-dir that is automatically cleaned up after the browser is closed. Defaults to false.',
    default: false,
  },
  userDataDir: {
    type: 'string',
    description:
      'Path to the user data directory for Chrome. Default is $HOME/.cache/chrome-devtools-mcp/chrome-profile$CHANNEL_SUFFIX_IF_NON_STABLE',
  },
  channel: {
    type: 'string',
    description:
      'Specify a different Chrome channel that should be used. The default is the stable channel version.',
    choices: ['canary', 'dev', 'beta', 'stable'],
    default: 'stable',
  },
  proxyServer: {
    type: 'string',
    description: `Proxy server configuration for Chrome passed as --proxy-server when launching the browser. See https://www.chromium.org/developers/design-documents/network-settings/ for details.`,
  },
  chromeArg: {
    type: 'array',
    string: true,
    describe:
      'Additional arguments for Chrome. Only applies when Chrome is launched by chrome-devtools-mcp.',
  },
  ignoreDefaultChromeArg: {
    type: 'array',
    string: true,
    describe:
      'Explicitly disable default arguments for Chrome. Only applies when Chrome is launched by chrome-devtools-mcp.',
  },
};

export function getBrowserOptions(): BrowserOptions {
  return browserOptions;
}
