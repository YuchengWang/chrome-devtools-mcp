/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';
import {compileRegex, getErrorMessage} from '../utils/errorHandling.js';

import {ToolCategory} from './categories.js';
import {defineTool, type ToolFactory} from './ToolDefinition.js';

const DEFAULT_WAIT_DOWNLOAD_TIMEOUT_MS = 30_000;

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

export const listDownloads: ToolFactory = defineTool(() => ({
  name: 'list_downloads',
  description:
    'List tracked browser downloads captured via CDP Browser.downloadWillBegin and Browser.downloadProgress.',
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  schema: {
    state: zod
      .enum(['inProgress', 'completed', 'canceled'])
      .optional()
      .describe('Filter downloads by state.'),
    limit: zod
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Maximum number of recent downloads to return.'),
  },
  blockedByDialog: false,
  concurrency: 'exclusive',
  verifyFilesSchema: {},
  handler: async (request, response, context) => {
    await context.enableDownloads();
    const downloads = context.getDownloads({
      state: request.params.state,
      limit: request.params.limit,
    });
    const downloadDir = context.getDownloadDirectory();
    if (downloads.length === 0) {
      response.appendResponseLine(
        `No downloads recorded${downloadDir ? ` (downloadDir=${downloadDir})` : ''}.`,
      );
      return;
    }
    response.appendResponseLine(
      `Downloads (${downloads.length}${downloadDir ? `, downloadDir=${downloadDir}` : ''}):`,
    );
    for (const item of downloads) {
      const pathPart = item.filePath ? ` filePath=${item.filePath}` : '';
      response.appendResponseLine(
        `- [${item.guid}] ${item.state.toUpperCase()} "${item.suggestedFilename}" ` +
          `(${item.receivedBytes}/${item.totalBytes} bytes)${pathPart} url=${item.url}`,
      );
    }
  },
}));

export const waitForDownload: ToolFactory = defineTool(() => ({
  name: 'wait_for_download',
  description:
    'Wait for a browser download to finish (or match an already completed download) and return its suggestedFilename and saved filePath.',
  annotations: {
    category: ToolCategory.NETWORK,
    readOnlyHint: true,
  },
  schema: {
    guid: zod
      .string()
      .optional()
      .describe('Specific download GUID to wait for.'),
    filenameRegex: optionalRegexSchema(
      'Regular expression matched against suggestedFilename.',
    ),
    urlRegex: optionalRegexSchema(
      'Regular expression matched against the download URL.',
    ),
    timeoutMs: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        `Timeout in milliseconds (default: ${DEFAULT_WAIT_DOWNLOAD_TIMEOUT_MS}).`,
      ),
    includeExistingCompleted: zod
      .boolean()
      .optional()
      .describe(
        'If true (default), resolve immediately when a matching completed download already exists.',
      ),
    sinceTimestamp: zod
      .number()
      .min(0)
      .optional()
      .describe('Only match downloads started at or after this epoch ms.'),
  },
  blockedByDialog: false,
  concurrency: 'exclusive',
  verifyFilesSchema: {},
  handler: async (request, response, context) => {
    const entry = await context.waitForDownload({
      guid: request.params.guid,
      filenameRegex: request.params.filenameRegex
        ? compileRegex(request.params.filenameRegex)
        : undefined,
      urlRegex: request.params.urlRegex
        ? compileRegex(request.params.urlRegex)
        : undefined,
      timeoutMs: request.params.timeoutMs ?? DEFAULT_WAIT_DOWNLOAD_TIMEOUT_MS,
      includeExistingCompleted: request.params.includeExistingCompleted,
      sinceTimestamp: request.params.sinceTimestamp,
    });

    response.appendResponseLine(
      `Download completed: guid=${entry.guid}, suggestedFilename="${entry.suggestedFilename}", ` +
        `bytes=${entry.receivedBytes}/${entry.totalBytes}` +
        `${entry.filePath ? `, filePath=${entry.filePath}` : ''}, url=${entry.url}`,
    );
  },
}));
