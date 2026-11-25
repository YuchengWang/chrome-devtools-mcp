/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import sinon from 'sinon';

import {McpResponse} from '../../src/McpResponse.js';
import {batchActions} from '../../src/tools/batch.js';
import {
  createHandlerMocks,
  createMockElementHandle,
  createMockServerConfig,
} from '../mocks.js';
import {getTextContent} from '../utils.js';

describe('batch_actions', () => {
  it('executes navigate_page, click, fill, wait_for, evaluate_script and includes snapshot', async () => {
    const {page, context, response, args} = createHandlerMocks({
      javascriptEvaluation: true,
    });
    const {handle} = createMockElementHandle();
    const clickStub = sinon.stub().resolves();
    const fillStub = sinon.stub().resolves();
    handle.asLocator.returns({
      click: clickStub,
      fill: fillStub,
    } as unknown as ReturnType<typeof handle.asLocator>);
    page.getElementByUid.resolves(handle);
    page.pptrPage.goto.resolves(null);
    page.pptrPage.url.returns('https://example.com');
    page.waitForTextOnPage.resolves();
    page.pptrPage.evaluateHandle.resolves({
      [Symbol.dispose]: () => {},
    } as unknown as Awaited<ReturnType<typeof page.pptrPage.evaluateHandle>>);
    page.pptrPage.evaluate.resolves({ok: true});

    await batchActions(args).handler(
      {
        params: {
          actions: [
            {type: 'navigate_page', url: 'https://example.com'},
            {type: 'fill', uid: '1_1', value: 'hello'},
            {type: 'click', uid: '1_2'},
            {type: 'wait_for', text: ['Done']},
            {type: 'evaluate_script', function: '() => ({ok: true})'},
          ],
          includeSnapshot: true,
          snapshotOptions: {
            interactiveOnly: true,
            maxDepth: 3,
            roles: ['button'],
            formsOnly: true,
            outlineOnly: false,
          },
        },
        page,
      },
      response,
      context,
    );

    sinon.assert.calledOnce(page.pptrPage.goto);
    sinon.assert.calledOnceWithExactly(fillStub, 'hello', {
      signal: sinon.match.any,
    });
    sinon.assert.calledOnceWithExactly(clickStub, {
      count: 1,
      signal: sinon.match.any,
    });
    sinon.assert.calledOnce(page.waitForTextOnPage);
    sinon.assert.calledOnceWithExactly(response.includeSnapshot, {
      verbose: false,
      interactiveOnly: true,
      maxDepth: 3,
      roles: ['button'],
      formsOnly: true,
      outlineOnly: false,
    });
  });

  it('continues on error when stopOnError is false and respects 8800B cap in McpResponse', async () => {
    const {page, context, args} = createHandlerMocks();
    const response = new McpResponse(createMockServerConfig());
    page.waitForTextOnPage.onFirstCall().rejects(new Error('timeout'));
    page.waitForTextOnPage.onSecondCall().resolves();

    await batchActions(args).handler(
      {
        params: {
          actions: [
            {type: 'wait_for', text: ['Missing']},
            {type: 'wait_for', text: ['Present']},
          ],
          stopOnError: false,
        },
        page,
      },
      response,
      context,
    );

    const formatted = await response.format(context, {
      detailedConsoleMessage: undefined,
      consoleMessages: undefined,
      snapshot: undefined,
    });
    const text = getTextContent(formatted.content[0]);
    assert.ok(text.includes('[1] wait_for: ERROR (timeout)'));
    assert.ok(text.includes('[2] wait_for (["Present"]): OK'));
    assert.ok(Buffer.byteLength(text, 'utf8') <= 8800);
  });
});
