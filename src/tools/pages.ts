/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ParsedArguments} from '../config/mcp-options.js';
import {zod} from '../third_party/index.js';
import type {CdpPage} from '../third_party/browser.js';
import {
  compileRegex,
  getErrorMessage,
  isDetachedNavigationError,
} from '../utils/errorHandling.js';
import {logger} from '../utils/logger.js';
import {validateUrl} from '../utils/url.js';

import {ToolCategory} from './categories.js';
import {
  CLOSE_PAGE_ERROR,
  type Context,
  type ContextPage,
  definePageTool,
  defineTool,
  type PageToolFactory,
  timeoutSchema,
  type ToolFactory,
} from './ToolDefinition.js';

function isBrowserDisconnected(page: ContextPage): boolean {
  return page.pptrPage.browser()?.connected === false;
}

function disconnectedNavigationError(
  actionDescription: string,
  cause: unknown,
): Error {
  const detail = cause instanceof Error ? cause.message : String(cause);
  return new Error(
    `Browser CDP connection disconnected during ${actionDescription} (${detail}). ` +
      'The underlying Chrome or local CDP proxy connection closed; re-run browser_prepare (if using cua-ycwang) and connect_browser to re-attach.',
    {cause},
  );
}

async function tryRecoverDetachedNavigation(
  actionDescription: string,
  error: unknown,
  page: ContextPage,
  context: Context,
): Promise<{recovered: boolean; targetId: string; error: Error}> {
  const detail = getErrorMessage(error);
  const targetId = page.targetId;
  const recovery = await context
    .rebindPageByTargetId(targetId, {previousPage: page})
    .catch(() => undefined);
  if (recovery?.recovered) {
    return {
      recovered: true,
      targetId,
      error: new Error(
        `Navigation detached during ${actionDescription} (${detail}). ` +
          `Self-healed target ${targetId} to latest active frame ` +
          `(frameId=${recovery.frameId ?? 'unknown'}, url=${recovery.url ?? 'unknown'}) ` +
          'and invalidated stale snapshots; retry or call take_snapshot.',
        {cause: error},
      ),
    };
  }
  const fallbackNote = recovery?.fallbackPage
    ? ` Selected fallback page ${recovery.fallbackPage.id} (${recovery.fallbackPage.url()}).`
    : ' Call list_pages to see open pages.';
  return {
    recovered: false,
    targetId,
    error: new Error(
      `Navigation detached during ${actionDescription} (${detail}) on target ${targetId}; ` +
        `could not rebind the detached frame.${fallbackNote}`,
      {cause: error},
    ),
  };
}

export const listPages: ToolFactory = defineTool((args: ParsedArguments) => {
  return {
    name: 'list_pages',
    description: `Get a list of pages${args?.categoryExtensions ? ' including extension service workers' : ''} open in the browser.`,
    annotations: {
      category: ToolCategory.NAVIGATION,
      readOnlyHint: true,
    },
    schema: {},
    blockedByDialog: false,
    concurrency: 'exclusive',
    verifyFilesSchema: {},
    handler: async (_request, response) => {
      response.setIncludePages(true);
      response.setListThirdPartyDeveloperTools();
      response.setListWebMcpTools();
    },
  };
});

export const selectPage: ToolFactory = defineTool((args: ParsedArguments) => ({
  name: 'select_page',
  description: `Select a page as a context for future tool calls.`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: true,
  },
  schema: {
    pageId: zod
      .number()
      .describe(
        `The ID of the page to select. Call ${listPages(args).name} to get available pages.`,
      ),
    bringToFront: zod
      .boolean()
      .optional()
      .describe('Whether to focus the page and bring it to the top.'),
  },
  blockedByDialog: false,
  concurrency: 'exclusive',
  verifyFilesSchema: {},
  handler: async (request, response, context) => {
    const page = context.getPageById(request.params.pageId);
    await page.init({emulateFocus: true});
    context.selectPage(page);
    response.setIncludePages(true);
    response.setListThirdPartyDeveloperTools();
    response.setListWebMcpTools();
    if (request.params.bringToFront) {
      await page.pptrPage.bringToFront();
    }
  },
}));

export const closePage: ToolFactory = defineTool(() => ({
  name: 'close_page',
  description: `Closes the page by its index. The last open page cannot be closed.`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: false,
  },
  schema: {
    pageId: zod
      .number()
      .describe('The ID of the page to close. Call list_pages to list pages.'),
  },
  blockedByDialog: false,
  concurrency: 'exclusive',
  verifyFilesSchema: {},
  handler: async (request, response, context) => {
    try {
      await context.closePage(request.params.pageId);
    } catch (err) {
      if (err.message === CLOSE_PAGE_ERROR) {
        response.appendResponseLine(err.message);
      } else {
        throw err;
      }
    }
    response.setIncludePages(true);
    response.setListThirdPartyDeveloperTools();
  },
}));

export const newPage: ToolFactory = defineTool((args: ParsedArguments) => {
  return {
    name: 'new_page',
    description: `Open a new tab and load a URL. Use project URL if not specified otherwise.${
      args?.backgroundNewPages ? ' The tab always opens in the background.' : ''
    }`,
    annotations: {
      category: ToolCategory.NAVIGATION,
      readOnlyHint: false,
    },
    schema: {
      url: zod.string().describe('URL to load in a new page.'),
      // With --backgroundNewPages the server decides, so the model is not offered the choice.
      ...(args?.backgroundNewPages
        ? {}
        : {
            background: zod
              .boolean()
              .optional()
              .describe(
                'Whether to open the page in the background without bringing it to the front. Default is false (foreground).',
              ),
          }),
      isolatedContext: zod
        .string()
        .optional()
        .describe(
          'If specified, the page is created in an isolated browser context with the given name. ' +
            'Pages in the same browser context share cookies and storage. ' +
            'Pages in different browser contexts are fully isolated (useful for clean-slate testing of cookies and authentication).',
        ),
      ...timeoutSchema,
    },
    blockedByDialog: false,
    concurrency: 'exclusive',
    verifyFilesSchema: {},
    handler: async (request, response, context) => {
      validateUrl(request.params.url, {
        javascriptEvaluation: args?.javascriptEvaluation,
        categoryExtensions: args?.categoryExtensions,
        fileNavigations: args?.fileNavigations,
      });

      let previousPage: ContextPage | undefined;
      try {
        previousPage = context.getSelectedMcpPage();
      } catch {
        // Nothing is selected, so there is no selection to restore on failure.
      }
      const page = await context.newPage(
        args?.backgroundNewPages
          ? true
          : (request.params as {background?: boolean}).background,
        request.params.isolatedContext,
      );
      response.includeConsoleErrorsFrom(page);

      try {
        await page.waitForEventsAfterAction(
          async () => {
            await page.pptrPage.goto(request.params.url, {
              timeout: request.params.timeout,
            });
          },
          {timeout: request.params.timeout},
        );
      } catch (error) {
        if (isBrowserDisconnected(page)) {
          throw disconnectedNavigationError('new_page', error);
        }
        if (isDetachedNavigationError(error)) {
          const recovered = await tryRecoverDetachedNavigation(
            'new_page',
            error,
            page,
            context,
          );
          if (recovered.recovered) {
            response.setIncludePages(true);
            throw recovered.error;
          }
        }
        // A dialog-blocked load stays open for handle_dialog. Otherwise cleanup is
        // best-effort: the navigation error is always what gets rethrown.
        if (page.getDialog()) {
          response.setIncludePages(true);
        } else {
          try {
            if (previousPage && !previousPage.isClosed()) {
              context.selectPage(previousPage);
            }
          } catch {
            // Keep the new tab selected.
          }
          try {
            await context.closePage(page.id);
          } catch {
            // The tab survived, so list pages to tell the caller its pageId.
            response.setIncludePages(true);
          }
        }
        throw error;
      }

      response.setIncludePages(true);
      response.setListThirdPartyDeveloperTools();
    },
  };
});

export const navigatePage: PageToolFactory = definePageTool(
  (args: ParsedArguments) => {
    return {
      name: 'navigate_page',
      description: `Go to a URL, or back, forward, or reload. Use project URL if not specified otherwise.`,
      annotations: {
        category: ToolCategory.NAVIGATION,
        readOnlyHint: false,
      },
      schema: {
        type: zod
          .enum(['url', 'back', 'forward', 'reload'])
          .optional()
          .describe(
            'Navigate the page by URL, back or forward in history, or reload.',
          ),
        url: zod.string().optional().describe('Target URL (only type=url)'),
        ignoreCache: zod
          .boolean()
          .optional()
          .describe('Whether to ignore cache on reload.'),
        handleBeforeUnload: zod
          .enum(['accept', 'dismiss'])
          .optional()
          .describe(
            'Whether to auto accept or beforeunload dialogs triggered by this navigation. Default is accept.',
          ),
        ...(args?.javascriptEvaluation !== false
          ? {
              initScript: zod
                .string()
                .optional()
                .describe(
                  'A JavaScript script to be executed on each new document before any other scripts for the next navigation.',
                ),
            }
          : {}),
        ...timeoutSchema,
      },
      blockedByDialog: false,
      concurrency: 'page',
      verifyFilesSchema: {},
      handler: async (request, response, context) => {
        const page = request.page;
        const options = {
          timeout: request.params.timeout,
        };

        if (!request.params.type && !request.params.url) {
          throw new Error('Either URL or a type is required.');
        }

        if (!request.params.type) {
          request.params.type = 'url';
        }

        if (request.params.url) {
          validateUrl(request.params.url, {
            javascriptEvaluation: args?.javascriptEvaluation,
            categoryExtensions: args?.categoryExtensions,
            fileNavigations: args?.fileNavigations,
          });
        }

        let initScriptId: string | undefined;
        if (request.params.initScript) {
          const {identifier} = await page.pptrPage.evaluateOnNewDocument(
            request.params.initScript,
          );
          initScriptId = identifier;
        }

        const runNavigationStep = async (
          actionFn: () => Promise<unknown>,
          successMessage: () => string,
          failurePrefix: string,
        ): Promise<void> => {
          try {
            await actionFn();
            response.appendResponseLine(successMessage());
          } catch (error) {
            if (isBrowserDisconnected(page)) {
              throw error;
            }
            const detail = getErrorMessage(error);
            if (isDetachedNavigationError(error)) {
              const recovery = await context
                .rebindPageByTargetId(page.targetId, {previousPage: page})
                .catch(() => undefined);
              if (recovery?.recovered) {
                response.appendResponseLine(
                  `${failurePrefix}: ${detail}. Self-healed: re-bound target ${recovery.targetId} ` +
                    `to latest active frame (frameId=${recovery.frameId ?? 'unknown'}, url=${recovery.url ?? 'unknown'}) ` +
                    'and invalidated stale snapshots; retry or call take_snapshot.',
                );
              } else {
                response.appendResponseLine(
                  `${failurePrefix}: ${detail}. Detached frame could not be rebound on target ${page.targetId}; call list_pages.`,
                );
              }
              return;
            }
            response.appendResponseLine(`${failurePrefix}: ${detail}.`);
          }
        };

        try {
          const action = request.params.handleBeforeUnload ?? 'accept';
          const result = await page.waitForEventsAfterAction(
            async () => {
              switch (request.params.type) {
                case 'url': {
                  const targetUrl = request.params.url;
                  if (!targetUrl) {
                    throw new Error(
                      'A URL is required for navigation of type=url.',
                    );
                  }
                  await runNavigationStep(
                    () => page.pptrPage.goto(targetUrl, options),
                    () => `Successfully navigated to ${targetUrl}.`,
                    'Unable to navigate in the selected page',
                  );
                  break;
                }
                case 'back':
                  await runNavigationStep(
                    () => page.pptrPage.goBack(options),
                    () =>
                      `Successfully navigated back to ${page.pptrPage.url()}.`,
                    'Unable to navigate back in the selected page',
                  );
                  break;
                case 'forward':
                  await runNavigationStep(
                    () => page.pptrPage.goForward(options),
                    () =>
                      `Successfully navigated forward to ${page.pptrPage.url()}.`,
                    'Unable to navigate forward in the selected page',
                  );
                  break;
                case 'reload':
                  await runNavigationStep(
                    () =>
                      page.pptrPage.reload({
                        ...options,
                        ignoreCache: request.params.ignoreCache,
                      }),
                    () => `Successfully reloaded the page.`,
                    'Unable to reload the selected page',
                  );
                  break;
              }
            },
            {
              timeout: request.params.timeout,
              handleDialog: {beforeunload: action},
            },
          );
          if (result.dialogHandled) {
            response.appendResponseLine(
              `${action === 'dismiss' ? 'Dismissed' : 'Accepted'} a beforeunload dialog.`,
            );
            page.clearDialog();
          }
        } catch (error) {
          if (isBrowserDisconnected(page)) {
            throw disconnectedNavigationError('navigate_page', error);
          }
          if (isDetachedNavigationError(error)) {
            const recovered = await tryRecoverDetachedNavigation(
              'navigate_page',
              error,
              page,
              context,
            );
            response.setIncludePages(true);
            throw recovered.error;
          }
          throw error;
        } finally {
          if (initScriptId && !isBrowserDisconnected(page)) {
            await page.pptrPage
              .removeScriptToEvaluateOnNewDocument(initScriptId)
              .catch(error => {
                logger?.(`Failed to remove init script`, error);
              });
          }
        }

        response.setIncludePages(true);
        response.setListThirdPartyDeveloperTools();
        response.setListWebMcpTools();
      },
    };
  },
);

export const resizePage: PageToolFactory = definePageTool(() => ({
  name: 'resize_page',
  description:
    'Requests the specified page dimensions. Chrome may enforce a minimum window size, so the resulting page dimensions can differ from the requested values.',
  annotations: {
    category: ToolCategory.EMULATION,
    readOnlyHint: false,
  },
  schema: {
    width: zod.number().int().positive().describe('Page width'),
    height: zod.number().int().positive().describe('Page height'),
  },
  blockedByDialog: false,
  concurrency: 'exclusive',
  verifyFilesSchema: {},
  handler: async (request, response) => {
    const page = request.page;

    try {
      const browser = page.pptrPage.browser();
      const windowId = await page.pptrPage.windowId();

      const bounds = await browser.getWindowBounds(windowId);

      if (bounds.windowState === 'fullscreen') {
        // Have to call this twice on Ubuntu when the window is in fullscreen mode.
        await browser.setWindowBounds(windowId, {windowState: 'normal'});
        await browser.setWindowBounds(windowId, {windowState: 'normal'});
      } else if (bounds.windowState !== 'normal') {
        await browser.setWindowBounds(windowId, {windowState: 'normal'});
      }
    } catch {
      // Window APIs are not supported on all platforms
    }
    await page.pptrPage.resize({
      contentWidth: request.params.width,
      contentHeight: request.params.height,
    });

    response.setIncludePages(true);
  },
}));

export const handleDialog: PageToolFactory = definePageTool(() => ({
  name: 'handle_dialog',
  description: `If one or more browser dialogs are open in the queue, use this command to handle them.`,
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    action: zod
      .enum(['accept', 'dismiss'])
      .describe('Whether to dismiss or accept the dialog'),
    promptText: zod
      .string()
      .optional()
      .describe('Optional prompt text to enter into the dialog.'),
    slotIndex: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'Zero-based queue slot index to handle when multiple dialogs are queued (default: 0).',
      ),
    all: zod
      .boolean()
      .optional()
      .describe('Handle all currently queued dialogs in FIFO order.'),
  },
  blockedByDialog: false,
  concurrency: 'page',
  verifyFilesSchema: {},
  handler: async (request, response) => {
    const page = request.page;
    const {action, promptText, slotIndex, all} = request.params;

    if (!all && slotIndex === undefined) {
      const dialog = page.getDialog();
      if (!dialog) {
        throw new Error('No open dialog found');
      }

      switch (action) {
        case 'accept': {
          try {
            await dialog.accept(promptText);
          } catch (err) {
            // Likely already handled by the user outside of MCP.
            logger?.(err);
          }
          response.appendResponseLine('Successfully accepted the dialog');
          break;
        }
        case 'dismiss': {
          try {
            await dialog.dismiss();
          } catch (err) {
            // Likely already handled.
            logger?.(err);
          }
          response.appendResponseLine('Successfully dismissed the dialog');
          break;
        }
      }

      page.clearDialog();
      response.setIncludePages(true);
      return;
    }

    const dialogs = page.getDialogs();
    if (all) {
      if (dialogs.length === 0) {
        const single = page.getDialog();
        if (!single) {
          throw new Error('No open dialog found');
        }
        try {
          if (action === 'accept') {
            await single.accept(promptText);
          } else {
            await single.dismiss();
          }
        } catch (err) {
          logger?.(err);
        }
        page.clearDialog(single);
        response.appendResponseLine(
          `Successfully ${action === 'accept' ? 'accepted' : 'dismissed'} 1 dialog`,
        );
        response.setIncludePages(true);
        return;
      }
      let handledCount = 0;
      for (const entry of dialogs) {
        try {
          if (action === 'accept') {
            await entry.dialog.accept(promptText);
          } else {
            await entry.dialog.dismiss();
          }
        } catch (err) {
          logger?.(err);
        }
        page.clearDialog(entry.dialog);
        handledCount++;
      }
      response.appendResponseLine(
        `Successfully ${action === 'accept' ? 'accepted' : 'dismissed'} ${handledCount} queued dialog(s)`,
      );
      response.setIncludePages(true);
      return;
    }

    const targetIndex = slotIndex ?? 0;
    const targetEntry = dialogs[targetIndex];
    if (!targetEntry) {
      throw new Error(
        `No queued dialog at slotIndex=${targetIndex} (queueLength=${dialogs.length}).`,
      );
    }
    try {
      if (action === 'accept') {
        await targetEntry.dialog.accept(promptText);
      } else {
        await targetEntry.dialog.dismiss();
      }
    } catch (err) {
      logger?.(err);
    }
    page.clearDialog(targetEntry.dialog);
    response.appendResponseLine(
      `Successfully ${action === 'accept' ? 'accepted' : 'dismissed'} queued dialog slot ${targetIndex} (#${targetEntry.id})`,
    );
    response.setIncludePages(true);
  },
}));

export const waitForDialog: PageToolFactory = definePageTool(() => ({
  name: 'wait_for_dialog',
  description:
    'Wait for a browser dialog (alert/confirm/prompt/beforeunload) or resolve immediately with a queued dialog, optionally accepting or dismissing it.',
  annotations: {
    category: ToolCategory.INPUT,
    readOnlyHint: false,
  },
  schema: {
    type: zod
      .enum(['alert', 'confirm', 'prompt', 'beforeunload'])
      .optional()
      .describe('Filter by expected dialog type.'),
    messageRegex: zod
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
      .describe('Optional regex matched against the dialog message.'),
    timeoutMs: zod
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Timeout in milliseconds (default: 10000).'),
    action: zod
      .enum(['accept', 'dismiss'])
      .optional()
      .describe(
        'Optional action to run immediately on the matched dialog if it was queued rather than auto-handled.',
      ),
    promptText: zod
      .string()
      .optional()
      .describe('Prompt input text when action="accept" on a prompt dialog.'),
  },
  blockedByDialog: false,
  concurrency: 'page',
  verifyFilesSchema: {},
  handler: async (request, response) => {
    const page = request.page;
    const result = await page.waitForDialog({
      type: request.params.type,
      messageRegex: request.params.messageRegex
        ? compileRegex(request.params.messageRegex)
        : undefined,
      timeoutMs: request.params.timeoutMs,
    });

    if (result.autoHandled) {
      response.appendResponseLine(
        `Dialog #${result.id} (${result.type}: "${result.message}") was auto-handled by policy (${result.autoAction}).`,
      );
      response.setIncludePages(true);
      return;
    }

    if (request.params.action) {
      const entry = page.getDialogs().find(d => d.id === result.id);
      const dialog = entry?.dialog ?? page.getDialog();
      if (dialog) {
        try {
          if (request.params.action === 'accept') {
            await dialog.accept(request.params.promptText);
          } else {
            await dialog.dismiss();
          }
        } catch (err) {
          logger?.(err);
        }
        page.clearDialog(dialog);
        response.appendResponseLine(
          `Waited for and ${request.params.action === 'accept' ? 'accepted' : 'dismissed'} ${result.type} dialog (#${result.id}): "${result.message}".`,
        );
        response.setIncludePages(true);
        return;
      }
    }

    response.appendResponseLine(
      `Dialog #${result.id} (${result.type}): "${result.message}" (queueLength=${result.queueLength}).`,
    );
    response.setIncludePages(true);
  },
}));

export const getTabId: PageToolFactory = definePageTool(() => ({
  name: 'get_tab_id',
  description: `Get the tab ID of the page`,
  annotations: {
    category: ToolCategory.NAVIGATION,
    readOnlyHint: true,
    conditions: ['experimentalInteropTools'],
  },
  schema: {},
  blockedByDialog: false,
  concurrency: 'page',
  verifyFilesSchema: {},
  handler: async (request, response) => {
    const page = request.page;
    const tabId = (page.pptrPage as unknown as CdpPage)._tabId;
    response.setTabId(tabId);
    response.appendResponseLine(`Tab ID: ${tabId}`);
  },
}));
