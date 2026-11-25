/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import sinon from 'sinon';

import {McpContext} from '../../src/McpContext.js';
import {McpPage} from '../../src/McpPage.js';
import {HeapSnapshotManager} from '../../src/processors/HeapSnapshotManager.js';
import {Locator, type Browser} from '../../src/third_party/browser.js';
import {ToolHandler} from '../../src/ToolHandler.js';
import {connectBrowser} from '../../src/tools/browser.js';
import {ToolCategory} from '../../src/tools/categories.js';
import {isBrowserlessTool} from '../../src/tools/ToolDefinition.js';
import {TaskRunner} from '../../src/utils/TaskRunner.js';
import {
  createHandlerMocks,
  createMockParsedArguments,
  createMockPuppeteerBrowser,
  createMockPuppeteerPage,
  createMockPuppeteerTarget,
  createMockServerConfig,
} from '../mocks.js';
import {serverHooks} from '../server.js';
import {getTextContent} from '../utils.js';

describe('browser tools', () => {
  serverHooks();

  describe('connect_browser', () => {
    it('registers as a browserless exclusive navigation tool', () => {
      const args = createMockParsedArguments();
      const tool = connectBrowser(args);
      assert.strictEqual(tool.name, 'connect_browser');
      assert.strictEqual(tool.annotations.category, ToolCategory.NAVIGATION);
      assert.strictEqual(tool.annotations.readOnlyHint, false);
      assert.strictEqual(tool.concurrency, 'exclusive');
      assert.strictEqual(isBrowserlessTool(tool), true);
    });

    it('forwards wsEndpoint and parsed wsHeaders and includes updated pages', async () => {
      const {context, response, args} = createHandlerMocks();
      const tool = connectBrowser(args);

      await tool.handler(
        {
          params: {
            wsEndpoint: 'ws://127.0.0.1:12345/devtools/browser/tok',
            wsHeaders: '{"Authorization":"Bearer abc"}',
          },
        },
        response,
        context,
      );

      sinon.assert.calledOnceWithExactly(context.connectBrowser, {
        wsEndpoint: 'ws://127.0.0.1:12345/devtools/browser/tok',
        wsHeaders: {Authorization: 'Bearer abc'},
      });
      sinon.assert.calledOnceWithExactly(response.setIncludePages, true);
      sinon.assert.calledOnce(response.setListThirdPartyDeveloperTools);
      sinon.assert.calledOnce(response.setListWebMcpTools);
    });

    it('supports isolated incognito launch options', async () => {
      const {context, response, args} = createHandlerMocks();
      const tool = connectBrowser(args);

      await tool.handler(
        {
          params: {
            isolated: true,
            incognito: true,
            headless: true,
          },
        },
        response,
        context,
      );

      sinon.assert.calledOnceWithExactly(context.connectBrowser, {
        isolated: true,
        incognito: true,
        headless: true,
      });
      sinon.assert.calledOnce(response.setIncludePages);
    });

    it('rejects malformed wsHeaders JSON before calling connectBrowser', async () => {
      const {context, response, args} = createHandlerMocks();
      const tool = connectBrowser(args);

      await assert.rejects(
        tool.handler(
          {
            params: {
              wsEndpoint: 'ws://127.0.0.1:12345/devtools/browser/tok',
              wsHeaders: 'not-json',
            },
          },
          response,
          context,
        ),
        /Invalid JSON for wsHeaders/,
      );
      sinon.assert.notCalled(context.connectBrowser);
    });

    it('executes via ToolHandler without calling ensureBrowser() first', async () => {
      const config = createMockServerConfig();
      const taskRunner = new TaskRunner();
      const heapSnapshotManager = new HeapSnapshotManager(taskRunner);
      const pptrBrowser1 = createMockPuppeteerBrowser();
      const pptrBrowser2 = createMockPuppeteerBrowser();
      const page2 = createMockPuppeteerPage();
      page2.url.returns('https://switched.example/');
      const target2 = createMockPuppeteerTarget({page: page2});
      target2.url.returns('https://switched.example/');
      pptrBrowser2.targets.returns([target2]);
      sinon.stub(McpPage.prototype, 'init').resolves();

      const getBrowser = sinon
        .stub<[], Promise<Browser>>()
        .resolves(pptrBrowser1);
      const connectBrowserStub = sinon
        .stub()
        .callsFake(async (_options, onSwitched) => {
          await onSwitched?.(pptrBrowser2);
          return pptrBrowser2;
        });

      const context = McpContext.create(
        undefined,
        {
          config,
          heapSnapshotManager,
          taskRunner,
          getBrowser,
          connectBrowser: connectBrowserStub,
        },
        Locator,
      );

      try {
        const handler = new ToolHandler(
          connectBrowser(config.resolved),
          config,
          async () => context,
          () => {},
        );

        const result = await handler.handle({
          wsEndpoint: 'ws://127.0.0.1:19999/devtools/browser/secret',
        });

        assert.notStrictEqual(result.isError, true);
        sinon.assert.notCalled(getBrowser);
        sinon.assert.calledOnce(connectBrowserStub);
        assert.deepStrictEqual(connectBrowserStub.firstCall.args[0], {
          wsEndpoint: 'ws://127.0.0.1:19999/devtools/browser/secret',
        });
        const text = getTextContent(result.content[0]);
        assert.ok(text.includes('https://switched.example/'), text);
      } finally {
        context.dispose();
        heapSnapshotManager.dispose();
      }
    });
  });
});
