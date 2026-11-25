/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ParsedArguments} from '../config/mcp-options.js';
import {zod} from '../third_party/index.js';
import type {JSHandle} from '../third_party/browser.js';
import {isDetachedNavigationError} from '../utils/errorHandling.js';
import {validateUrl} from '../utils/url.js';

import {ToolCategory} from './categories.js';
import {definePageTool, type PageToolFactory} from './ToolDefinition.js';

// eslint-disable-next-line @local/enforce-zod-schema -- Nested action schema.
const batchActionSchema = zod.object({
  type: zod
    .enum(['navigate_page', 'click', 'fill', 'wait_for', 'evaluate_script'])
    .describe('Action type to execute.'),
  url: zod.string().optional().describe('URL for navigate_page.'),
  navType: zod
    .enum(['url', 'back', 'forward', 'reload'])
    .optional()
    .describe('Navigation type for navigate_page. Defaults to "url".'),
  ignoreCache: zod.boolean().optional().describe('For navigate_page reload.'),
  timeout: zod
    .number()
    .int()
    .optional()
    .describe('Timeout in ms for navigate_page or wait_for.'),
  uid: zod.string().optional().describe('Element uid for click or fill.'),
  dblClick: zod.boolean().optional().describe('Double click for click.'),
  value: zod.string().optional().describe('Value to fill for fill.'),
  text: zod
    .array(zod.string())
    .min(1)
    .optional()
    .describe('Texts to wait for in wait_for.'),
  visible: zod.boolean().optional().describe('Visible flag for wait_for.'),
  function: zod
    .string()
    .optional()
    .describe('JavaScript function source for evaluate_script.'),
  args: zod
    .array(zod.string())
    .optional()
    .describe('Element uids to pass to evaluate_script.'),
});

export const batchActions: PageToolFactory = definePageTool(
  (cliArgs: ParsedArguments) => ({
    name: 'batch_actions',
    description:
      'Execute a sequence of page actions (navigate_page, click, fill, wait_for, evaluate_script) atomically under the page lock, with an optional final take_snapshot.',
    annotations: {
      category: ToolCategory.INPUT,
      readOnlyHint: false,
    },
    schema: {
      actions: zod
        .array(batchActionSchema)
        .min(1)
        .describe('Ordered list of actions to execute sequentially.'),
      includeSnapshot: zod
        .boolean()
        .optional()
        .describe(
          'Whether to include a take_snapshot after all actions finish. Default is false.',
        ),
      /* eslint-disable @local/enforce-zod-schema -- Nested snapshotOptions schema. */
      snapshotOptions: zod
        .object({
          verbose: zod.boolean().optional(),
          rootUid: zod.string().optional(),
          maxDepth: zod.number().int().min(0).optional(),
          interactiveOnly: zod.boolean().optional(),
          roles: zod.array(zod.string()).optional(),
          formsOnly: zod.boolean().optional(),
          outlineOnly: zod.boolean().optional(),
        })
        /* eslint-enable @local/enforce-zod-schema */
        .optional()
        .describe('Optional parameters passed to the final take_snapshot.'),
      stopOnError: zod
        .boolean()
        .optional()
        .describe(
          'Whether to stop executing remaining actions if one fails. Default is true.',
        ),
    },
    blockedByDialog: true,
    concurrency: 'page',
    verifyFilesSchema: {},
    handler: async (request, response, context) => {
      let page = request.page;
      const stopOnError = request.params.stopOnError ?? true;

      for (let i = 0; i < request.params.actions.length; i++) {
        const action = request.params.actions[i];
        try {
          switch (action.type) {
            case 'navigate_page': {
              const navType = action.navType ?? 'url';
              if (action.url) {
                validateUrl(action.url, {
                  javascriptEvaluation: cliArgs?.javascriptEvaluation,
                  categoryExtensions: cliArgs?.categoryExtensions,
                  fileNavigations: cliArgs?.fileNavigations,
                });
              }
              const options = {
                timeout: action.timeout,
              };
              const result = await page.waitForEventsAfterAction(async () => {
                if (navType === 'url') {
                  if (!action.url) {
                    throw new Error(
                      'A URL is required for navigate_page with navType="url".',
                    );
                  }
                  await page.pptrPage.goto(action.url, options);
                } else if (navType === 'back') {
                  await page.pptrPage.goBack(options);
                } else if (navType === 'forward') {
                  await page.pptrPage.goForward(options);
                } else if (navType === 'reload') {
                  await page.pptrPage.reload({
                    ...options,
                    ignoreCache: action.ignoreCache,
                  });
                }
              });
              response.attachWaitForResult(result);
              response.appendResponseLine(
                `[${i + 1}] navigate_page (${navType}): OK (${page.pptrPage.url()})`,
              );
              break;
            }
            case 'click': {
              if (!action.uid) {
                throw new Error('uid is required for click action.');
              }
              const uid = action.uid;
              using handle = await page.getElementByUid(uid);
              const result = await page.waitForEventsAfterAction(
                async signal => {
                  await handle.asLocator().click({
                    count: action.dblClick ? 2 : 1,
                    signal,
                  });
                },
              );
              response.attachWaitForResult(result);
              response.appendResponseLine(`[${i + 1}] click (${uid}): OK`);
              break;
            }
            case 'fill': {
              if (!action.uid || action.value === undefined) {
                throw new Error('uid and value are required for fill action.');
              }
              const uid = action.uid;
              const value = action.value;
              using handle = await page.getElementByUid(uid);
              const result = await page.waitForEventsAfterAction(
                async signal => {
                  await handle.asLocator().fill(value, {signal});
                },
              );
              response.attachWaitForResult(result);
              response.appendResponseLine(`[${i + 1}] fill (${uid}): OK`);
              break;
            }
            case 'wait_for': {
              if (!action.text || action.text.length === 0) {
                throw new Error('text is required for wait_for action.');
              }
              await page.waitForTextOnPage(action.text, {
                timeout: action.timeout,
                visible: action.visible,
              });
              response.appendResponseLine(
                `[${i + 1}] wait_for (${JSON.stringify(action.text)}): OK`,
              );
              break;
            }
            case 'evaluate_script': {
              if (cliArgs?.javascriptEvaluation === false) {
                throw new Error(
                  'JavaScript evaluation is disabled by server configuration.',
                );
              }
              if (!action.function) {
                throw new Error(
                  'function is required for evaluate_script action.',
                );
              }
              const fnSource = action.function;
              using stack = new DisposableStack();
              const evalArgs: Array<JSHandle<unknown>> = [];
              for (const uid of action.args ?? []) {
                const handle = await page.getElementByUid(uid);
                stack.use(handle);
                evalArgs.push(handle);
              }
              let evalResult: unknown;
              const waitResult = await page.waitForEventsAfterAction(
                async () => {
                  const fn = await page.pptrPage.evaluateHandle(
                    `(${fnSource})`,
                  );
                  stack.use(fn);
                  evalResult = await page.pptrPage.evaluate(
                    async (targetFn, ...fnArgs) => {
                      // @ts-expect-error targetFn is evaluated from string.
                      return await targetFn(...fnArgs);
                    },
                    fn,
                    ...evalArgs,
                  );
                },
              );
              response.attachWaitForResult(waitResult);
              response.appendResponseLine(
                `[${i + 1}] evaluate_script: ${JSON.stringify(evalResult)}`,
              );
              break;
            }
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          let recoveryNote = '';
          if (
            page.pptrPage.browser()?.connected !== false &&
            isDetachedNavigationError(error)
          ) {
            const recovery = await context
              .rebindPageByTargetId(page.targetId, {previousPage: page})
              .catch(() => undefined);
            if (recovery?.recovered) {
              if (recovery.page) {
                page = recovery.page;
              }
              recoveryNote =
                ` [self-healed target ${recovery.targetId} -> frameId=${recovery.frameId ?? 'unknown'}, ` +
                `url=${recovery.url ?? 'unknown'}; snapshot invalidated]`;
              response.setIncludePages(true);
            } else {
              recoveryNote = ` [detached target ${page.targetId} could not rebind; call list_pages or take_snapshot]`;
            }
          }
          response.appendResponseLine(
            `[${i + 1}] ${action.type}: ERROR (${message})${recoveryNote}`,
          );
          if (stopOnError) {
            throw error;
          }
        }
      }

      if (request.params.includeSnapshot) {
        const opts = request.params.snapshotOptions;
        response.includeSnapshot({
          verbose: opts?.verbose ?? false,
          ...(opts?.rootUid !== undefined ? {rootUid: opts.rootUid} : {}),
          ...(opts?.maxDepth !== undefined ? {maxDepth: opts.maxDepth} : {}),
          ...(opts?.interactiveOnly !== undefined
            ? {interactiveOnly: opts.interactiveOnly}
            : {}),
          ...(opts?.roles !== undefined ? {roles: opts.roles} : {}),
          ...(opts?.formsOnly !== undefined ? {formsOnly: opts.formsOnly} : {}),
          ...(opts?.outlineOnly !== undefined
            ? {outlineOnly: opts.outlineOnly}
            : {}),
        });
      }
    },
  }),
);
