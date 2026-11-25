/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {loadBrowser, zod} from '../third_party/index.js';
import {compileRegex, getErrorMessage} from '../utils/errorHandling.js';

import {ToolCategory} from './categories.js';
import {
  definePageTool,
  type PageToolFactory,
  timeoutSchema,
} from './ToolDefinition.js';

export const takeSnapshot: PageToolFactory = definePageTool(() => ({
  name: 'take_snapshot',
  description: `Take a text snapshot of the target page based on the a11y tree. The snapshot lists page elements along with a unique
identifier (uid). Always use the latest snapshot. Prefer taking a snapshot over taking a screenshot. The snapshot indicates the element selected
in the DevTools Elements panel (if any).`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    // Not read-only due to filePath param.
    readOnlyHint: false,
  },
  schema: {
    verbose: zod
      .boolean()
      .optional()
      .describe(
        'Whether to include all possible information available in the full a11y tree. Default is false.',
      ),
    filePath: zod
      .string()
      .optional()
      .describe(
        'The absolute path, or a path relative to the current working directory, to save the snapshot to instead of attaching it to the response.',
      ),
    rootUid: zod
      .string()
      .optional()
      .describe(
        'Optional uid of a subtree root node to format instead of the full page snapshot.',
      ),
    maxDepth: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Optional maximum tree depth to include relative to the root node.',
      ),
    interactiveOnly: zod
      .boolean()
      .optional()
      .describe(
        'If true, prune non-interactive wrapper nodes while preserving interactive elements.',
      ),
    roles: zod
      .array(zod.string())
      .optional()
      .describe(
        'Optional list of ARIA roles (case-insensitive) to filter snapshot nodes.',
      ),
    formsOnly: zod
      .boolean()
      .optional()
      .describe(
        'If true, filter to form controls and action buttons while excluding normal navigation links.',
      ),
    outlineOnly: zod
      .boolean()
      .optional()
      .describe(
        'If true, return only RootWebArea, landmarks, and headings with subtree node counts.',
      ),
  },
  blockedByDialog: true,
  concurrency: 'page',
  verifyFilesSchema: {
    filePath: true,
  },
  handler: async (request, response) => {
    response.includeSnapshot({
      verbose: request.params.verbose ?? false,
      filePath: request.params.filePath,
      ...(request.params.rootUid !== undefined
        ? {rootUid: request.params.rootUid}
        : {}),
      ...(request.params.maxDepth !== undefined
        ? {maxDepth: request.params.maxDepth}
        : {}),
      ...(request.params.interactiveOnly !== undefined
        ? {interactiveOnly: request.params.interactiveOnly}
        : {}),
      ...(request.params.roles !== undefined
        ? {roles: request.params.roles}
        : {}),
      ...(request.params.formsOnly !== undefined
        ? {formsOnly: request.params.formsOnly}
        : {}),
      ...(request.params.outlineOnly !== undefined
        ? {outlineOnly: request.params.outlineOnly}
        : {}),
    });
  },
}));

export const waitFor: PageToolFactory = definePageTool(() => ({
  name: 'wait_for',
  description: `Wait for the specified text to appear on the selected page. By default, hidden text is also matched. Set visible to true to wait until the matched text is visible.`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: true,
  },
  schema: {
    text: zod
      .array(zod.string())
      .min(1)
      .describe(
        'Non-empty list of texts. Resolves when any value matches an ' +
          'accessible name exactly or is a substring of DOM text. Matching ' +
          'is case-sensitive. DOM text preserves spaces and newlines, unlike ' +
          'snapshot text which may normalize whitespace. Use the original ' +
          'whitespace or a shorter distinctive substring.',
      ),
    ...timeoutSchema,
    visible: zod
      .boolean()
      .default(false)
      .optional()
      .describe(
        'If true, wait until the matching text is visible. By default, hidden text also counts.',
      ),
  },
  blockedByDialog: true,
  concurrency: 'page',
  verifyFilesSchema: {},
  handler: async (request, response) => {
    const page = request.page;
    try {
      await page.waitForTextOnPage(request.params.text, {
        timeout: request.params.timeout,
        visible: request.params.visible,
      });
    } catch (error) {
      const {TimeoutError} = await loadBrowser();
      if (error instanceof TimeoutError) {
        throw new TimeoutError(
          `${error.message}. Text matching is case-sensitive. DOM text must ` +
            'preserve spaces and newlines, whereas snapshot text may ' +
            'normalize whitespace. Try a shorter distinctive substring.',
          {cause: error},
        );
      }
      throw error;
    }

    response.appendResponseLine(
      `Element matching one of ${JSON.stringify(request.params.text)} found.`,
    );

    response.includeSnapshot();
  },
}));

export const waitForDom: PageToolFactory = definePageTool(() => ({
  name: 'wait_for_dom',
  description:
    'Wait for DOM elements matching a CSS selector (supports Open Shadow DOM `>>>` piercing) and optional frameId, visibility/detachment state, text/textRegex, or attribute assertions.',
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: true,
  },
  schema: {
    selector: zod
      .string()
      .min(1)
      .describe(
        'CSS selector, or Open Shadow DOM piercing path using `>>>` (e.g. `host-el >>> shadow-child >>> button.primary`).',
      ),
    state: zod
      .enum(['visible', 'hidden', 'attached', 'detached'])
      .optional()
      .describe('DOM state to wait for (default: "visible").'),
    frameId: zod
      .string()
      .optional()
      .describe(
        'Target frameId to restrict lookup; when omitted, searches main frame and all child frames.',
      ),
    text: zod
      .string()
      .optional()
      .describe(
        'Optional case-sensitive substring required inside element text.',
      ),
    textRegex: zod
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
      .describe('Optional regex matched against element text.'),
    attributeName: zod
      .string()
      .optional()
      .describe('Optional DOM attribute name that must exist on the element.'),
    attributeValue: zod
      .string()
      .optional()
      .describe('Optional exact attribute value (requires attributeName).'),
    ...timeoutSchema,
    pollIntervalMs: zod
      .number()
      .int()
      .min(10)
      .max(5000)
      .optional()
      .describe('Polling interval in milliseconds (default: 100).'),
    includeSnapshot: zod
      .boolean()
      .optional()
      .describe(
        'Include an accessibility snapshot once the DOM condition passes.',
      ),
  },
  blockedByDialog: true,
  concurrency: 'page',
  verifyFilesSchema: {},
  handler: async (request, response) => {
    const page = request.page;
    if (
      request.params.attributeValue !== undefined &&
      !request.params.attributeName
    ) {
      throw new Error(
        'attributeName is required when attributeValue is specified.',
      );
    }
    const textRegex = request.params.textRegex
      ? compileRegex(request.params.textRegex)
      : undefined;
    const result = await page.waitForDom({
      selector: request.params.selector,
      state: request.params.state,
      frameId: request.params.frameId,
      text: request.params.text,
      textRegex,
      attributeName: request.params.attributeName,
      attributeValue: request.params.attributeValue,
      timeoutMs: request.params.timeout,
      pollIntervalMs: request.params.pollIntervalMs,
    });
    const elementDetails = result.tagName
      ? `, first=<${result.tagName}>${result.textPreview ? ` "${result.textPreview}"` : ''}`
      : '';
    response.appendResponseLine(
      `DOM selector "${result.selector}" matched state "${result.state}" in frame ${result.frameId} ` +
        `(count=${result.count}, visibleCount=${result.visibleCount}, elapsedMs=${result.elapsedMs}${elementDetails}).`,
    );
    if (request.params.includeSnapshot) {
      response.includeSnapshot();
    }
  },
}));
