/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';
import type {ConnectBrowserOptions} from '../types.js';
import {parseWsHeaders} from '../utils/url.js';

import {ToolCategory} from './categories.js';
import {
  defineBrowserlessTool,
  type BrowserlessToolFactory,
} from './ToolDefinition.js';

export const connectBrowser: BrowserlessToolFactory = defineBrowserlessTool(
  () => ({
    name: 'connect_browser',
    description:
      'Dynamically connect or hot-switch to another Chrome browser instance at runtime without restarting chrome-devtools-mcp. Supports attaching via wsEndpoint (such as a local proxy from cua-ycwang:browser_prepare) or browserUrl, or launching an isolated/incognito/userDataDir Chrome instance.',
    annotations: {
      category: ToolCategory.NAVIGATION,
      readOnlyHint: false,
    },
    schema: {
      wsEndpoint: zod
        .string()
        .optional()
        .describe(
          'WebSocket endpoint (ws:// or wss://) to connect to, such as the restricted local loopback proxy ws_endpoint returned by cua-ycwang:browser_prepare.',
        ),
      browserUrl: zod
        .string()
        .optional()
        .describe(
          'HTTP/HTTPS remote debugging URL (e.g., http://127.0.0.1:9222) to attach to.',
        ),
      wsHeaders: zod
        .string()
        .optional()
        .describe(
          'Optional JSON object string of custom headers when connecting via wsEndpoint or browserUrl.',
        ),
      userDataDir: zod
        .string()
        .optional()
        .describe('User data directory to launch Chrome with.'),
      channel: zod
        .enum(['canary', 'dev', 'beta', 'stable'])
        .optional()
        .describe('Chrome release channel when launching Chrome.'),
      isolated: zod
        .boolean()
        .optional()
        .describe(
          'Launch a separate Chrome instance using a clean temporary profile that is cleaned up on switch/shutdown.',
        ),
      incognito: zod
        .boolean()
        .optional()
        .describe(
          'Launch the browser window in incognito mode (--incognito). Defaults isolated=true when userDataDir is omitted.',
        ),
      headless: zod
        .boolean()
        .optional()
        .describe('Override headless mode when launching an isolated browser.'),
    },
    blockedByDialog: false,
    concurrency: 'exclusive',
    verifyFilesSchema: {},
    handler: async (request, response, context) => {
      const {
        wsEndpoint,
        browserUrl,
        wsHeaders,
        userDataDir,
        channel,
        isolated,
        incognito,
        headless,
      } = request.params;
      const parsedHeaders = parseWsHeaders(wsHeaders);
      const options: ConnectBrowserOptions = {
        ...(wsEndpoint !== undefined ? {wsEndpoint} : {}),
        ...(browserUrl !== undefined ? {browserUrl} : {}),
        ...(parsedHeaders !== undefined ? {wsHeaders: parsedHeaders} : {}),
        ...(userDataDir !== undefined ? {userDataDir} : {}),
        ...(channel !== undefined ? {channel} : {}),
        ...(isolated !== undefined ? {isolated} : {}),
        ...(incognito !== undefined ? {incognito} : {}),
        ...(headless !== undefined ? {headless} : {}),
      };
      await context.connectBrowser(options);

      if (options.wsEndpoint) {
        response.appendResponseLine(
          'Connected and switched active browser to the provided wsEndpoint.',
        );
      } else if (options.browserUrl) {
        response.appendResponseLine(
          `Connected and switched active browser to ${options.browserUrl}.`,
        );
      } else {
        const modeDesc = options.incognito ? 'incognito isolated' : 'isolated';
        response.appendResponseLine(
          `Launched and switched active browser to a ${modeDesc} session.`,
        );
      }
      response.setIncludePages(true);
      response.setListThirdPartyDeveloperTools();
      response.setListWebMcpTools();
    },
  }),
);
