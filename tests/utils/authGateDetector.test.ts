/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {afterEach, describe, it} from 'node:test';

import sinon from 'sinon';

import type {Page} from '../../src/third_party/browser.js';
import {batchActions} from '../../src/tools/batch.js';
import {click} from '../../src/tools/input.js';
import {navigatePage} from '../../src/tools/pages.js';
import {
  detectAuthGate,
  formatNewTabSignal,
} from '../../src/utils/authGateDetector.js';
import {
  createHandlerMocks,
  createMockElementHandle,
  createMockMcpPage,
} from '../mocks.js';

interface MockDomConfig {
  selectors?: string[];
  buttons?: string[];
  bodyText?: string;
}

function createFakePageWithDom(url: string, dom: MockDomConfig): Page {
  return {
    url: () => url,
    isClosed: () => false,
    evaluate: async <T>(
      fn: (authUrlMatched: boolean) => T,
      authUrlMatched: boolean,
    ): Promise<T> => {
      const prevDocument = (globalThis as {document?: unknown}).document;
      const matchedSelectors = new Set(dom.selectors ?? []);
      (globalThis as {document: unknown}).document = {
        querySelector: (selector: string) => {
          for (const entry of matchedSelectors) {
            if (selector.includes(entry)) {
              return {};
            }
          }
          return null;
        },
        querySelectorAll: () =>
          (dom.buttons ?? []).map(textContent => ({textContent})),
        body: {
          innerText: dom.bodyText ?? '',
        },
      };
      try {
        return fn(authUrlMatched);
      } finally {
        if (prevDocument === undefined) {
          delete (globalThis as {document?: unknown}).document;
        } else {
          (globalThis as {document?: unknown}).document = prevDocument;
        }
      }
    },
  } as unknown as Page;
}

describe('authGateDetector', () => {
  afterEach(() => {
    sinon.restore();
  });

  it('detects TOTP/OTP input fields and emits AUTH_2FA_DETECTED signal', async () => {
    for (const selector of [
      'input[autocomplete="one-time-code"]',
      'input[name="app_otp"]',
      'input[name="otp"]',
      'input[name="totp"]',
      'input[id*="otp" i]',
      'input[id*="totp" i]',
    ]) {
      const page = createFakePageWithDom(
        'https://github.com/sessions/two-factor/app',
        {selectors: [selector]},
      );
      const result = await detectAuthGate(page);
      assert.strictEqual(result.detected, true);
      assert.strictEqual(result.kind, 'totp_input');
      assert.strictEqual(result.hasOtpInput, true);
      assert.ok(result.signal?.includes('[AUTH_2FA_DETECTED]'));
      assert.ok(result.signal?.includes('cua-ycwang:resolve_auth_site'));
      assert.ok(result.signal?.includes('cua-ycwang:type_totp_from_env'));
    }
  });

  it('detects passkey/WebAuthn switch cues on 2FA pages', async () => {
    const page = createFakePageWithDom(
      'https://github.com/sessions/two-factor/webauthn',
      {
        buttons: ['Use passkey', 'Use authenticator app'],
        bodyText: 'Verify your identity with a passkey',
      },
    );
    const result = await detectAuthGate(page);
    assert.strictEqual(result.detected, true);
    assert.strictEqual(result.kind, 'passkey_switch_required');
    assert.strictEqual(result.hasOtpInput, false);
    assert.strictEqual(result.switchHint, 'Use authenticator app');
    assert.ok(result.signal?.includes('[AUTH_2FA_DETECTED]'));
    assert.ok(result.signal?.includes('Use authenticator app'));
  });

  it('detects "Try another way" switch cue on 2FA URLs', async () => {
    const page = createFakePageWithDom(
      'https://accounts.example.com/mfa/challenge',
      {
        buttons: ['Try another way'],
        bodyText: 'Tap your security key',
      },
    );
    const result = await detectAuthGate(page);
    assert.strictEqual(result.detected, true);
    assert.strictEqual(result.kind, 'passkey_switch_required');
    assert.strictEqual(result.switchHint, 'Try another way');
  });

  it('detects password login forms', async () => {
    const page = createFakePageWithDom('https://github.com/login', {
      selectors: ['input[type="password"]'],
    });
    const result = await detectAuthGate(page);
    assert.strictEqual(result.detected, true);
    assert.strictEqual(result.kind, 'login_form');
    assert.strictEqual(result.hasPasswordInput, true);
    assert.ok(result.signal?.includes('[AUTH_2FA_DETECTED]'));
    assert.ok(result.signal?.includes('cua-ycwang:type_secret_from_env'));
  });

  it('does not trigger false positives on normal non-auth pages', async () => {
    const page = createFakePageWithDom('https://example.com/docs/getting-started', {
      buttons: ['Get started', 'Try another way'],
      bodyText: 'Welcome to the documentation.',
    });
    const result = await detectAuthGate(page);
    assert.strictEqual(result.detected, false);
    assert.strictEqual(result.kind, undefined);
    assert.strictEqual(result.hasOtpInput, false);
    assert.strictEqual(result.hasPasswordInput, false);
    assert.strictEqual(result.signal, undefined);
  });

  it('handles evaluate errors safely without throwing', async () => {
    const page = {
      url: () => 'https://example.com/login',
      isClosed: () => false,
      evaluate: async () => {
        throw new Error('Execution context was destroyed');
      },
    } as unknown as Page;

    const result = await detectAuthGate(page);
    assert.strictEqual(result.detected, false);
    assert.strictEqual(result.url, 'https://example.com/login');
  });

  it('formats NEW_TAB_OPENED signal cleanly', () => {
    const line = formatNewTabSignal(3, 'https://example.com/oauth/authorize', 'click');
    assert.ok(line.includes('[NEW_TAB_OPENED]'));
    assert.ok(line.includes('pageId=3'));
    assert.ok(line.includes('https://example.com/oauth/authorize'));
    assert.ok(line.includes('select_page({ pageId: 3 })'));
  });

  it('hooks into navigate_page to emit AUTH_2FA_DETECTED', async () => {
    const {page, context, response, args} = createHandlerMocks();
    page.pptrPage.goto.resolves(null);
    page.pptrPage.url.returns('https://github.com/sessions/two-factor');
    page.pptrPage.evaluate.resolves({
      hasOtpInput: true,
      hasPasswordInput: false,
    });

    await navigatePage(args).handler(
      {params: {type: 'url', url: 'https://github.com/sessions/two-factor'}, page},
      response,
      context,
    );

    const appended = response.appendResponseLine.args.map(a => a[0]);
    assert.ok(appended.some(line => line.includes('[AUTH_2FA_DETECTED]')));
    assert.ok(appended.some(line => line.includes('kind=totp_input')));
  });

  it('hooks into click to emit NEW_TAB_OPENED and AUTH_2FA_DETECTED on new tab', async () => {
    const {page, context, response, args} = createHandlerMocks();
    const {handle} = createMockElementHandle();
    handle.asLocator.returns({
      click: sinon.stub().resolves(),
    } as unknown as ReturnType<typeof handle.asLocator>);
    page.getElementByUid.resolves(handle);

    const newPage = createMockMcpPage({id: 2});
    newPage.pptrPage.url.returns('https://accounts.example.com/login');
    newPage.pptrPage.evaluate.resolves({
      hasOtpInput: false,
      hasPasswordInput: true,
    });

    context.getPages
      .onFirstCall()
      .returns([page])
      .onSecondCall()
      .returns([page, newPage]);

    await click(args).handler({params: {uid: '1_1'}, page}, response, context);

    const appended = response.appendResponseLine.args.map(a => a[0]);
    assert.ok(appended.some(line => line.includes('[NEW_TAB_OPENED] pageId=2')));
    assert.ok(appended.some(line => line.includes('[AUTH_2FA_DETECTED]')));
    assert.ok(appended.some(line => line.includes('kind=login_form')));
  });

  it('handles uninitialized newly opened McpPage in click without throwing', async () => {
    const {page, context, response, args} = createHandlerMocks();
    const {handle} = createMockElementHandle();
    handle.asLocator.returns({
      click: sinon.stub().resolves(),
    } as unknown as ReturnType<typeof handle.asLocator>);
    page.getElementByUid.resolves(handle);

    let initialized = false;
    const realPptrPage = createFakePageWithDom(
      'https://accounts.example.com/sessions/two-factor',
      {selectors: ['input[name="otp"]']},
    );
    const uninitializedPage = {
      id: 2,
      url: () => 'https://accounts.example.com/sessions/two-factor',
      isClosed: () => false,
      init: sinon.stub().callsFake(async () => {
        initialized = true;
      }),
      get pptrPage() {
        if (!initialized) {
          throw new Error(
            'McpPage (id=2) is not initialized. Call init() first.',
          );
        }
        return realPptrPage;
      },
    };

    context.getPages
      .onFirstCall()
      .returns([page])
      .onSecondCall()
      .returns([page, uninitializedPage as unknown as ReturnType<typeof createMockMcpPage>]);

    await click(args).handler({params: {uid: '1_2'}, page}, response, context);

    sinon.assert.calledOnce(uninitializedPage.init);
    const appended = response.appendResponseLine.args.map(a => a[0]);
    assert.ok(appended.some(line => line.includes('[NEW_TAB_OPENED] pageId=2')));
    assert.ok(appended.some(line => line.includes('[AUTH_2FA_DETECTED]')));
    assert.ok(appended.some(line => line.includes('kind=totp_input')));
  });

  it('still emits NEW_TAB_OPENED when uninitialized McpPage init() fails', async () => {
    const {page, context, response, args} = createHandlerMocks();
    const {handle} = createMockElementHandle();
    handle.asLocator.returns({
      click: sinon.stub().resolves(),
    } as unknown as ReturnType<typeof handle.asLocator>);
    page.getElementByUid.resolves(handle);

    const uninitializedPage = {
      id: 7,
      url: () => 'https://example.com/new-tab',
      isClosed: () => false,
      init: sinon.stub().rejects(new Error('Target closed')),
      get pptrPage(): Page {
        throw new Error(
          'McpPage (id=7) is not initialized. Call init() first.',
        );
      },
    };

    context.getPages
      .onFirstCall()
      .returns([page])
      .onSecondCall()
      .returns([page, uninitializedPage as unknown as ReturnType<typeof createMockMcpPage>]);

    await click(args).handler({params: {uid: '1_2'}, page}, response, context);

    const appended = response.appendResponseLine.args.map(a => a[0]);
    assert.ok(
      appended.some(line =>
        line.includes('[NEW_TAB_OPENED] pageId=7 url=https://example.com/new-tab'),
      ),
    );
  });

  it('hooks into batch_actions to emit NEW_TAB_OPENED and AUTH_2FA_DETECTED', async () => {
    const {page, context, response, args} = createHandlerMocks();
    page.pptrPage.goto.resolves(null);
    page.pptrPage.url.returns('https://example.com');
    page.pptrPage.evaluate.resolves({
      hasOtpInput: false,
      hasPasswordInput: false,
    });

    const newPage = createMockMcpPage({id: 5});
    newPage.pptrPage.url.returns('https://example.com/2fa');
    newPage.pptrPage.evaluate.resolves({
      hasOtpInput: true,
      hasPasswordInput: false,
    });

    context.getPages
      .onFirstCall()
      .returns([page])
      .onSecondCall()
      .returns([page, newPage]);

    await batchActions(args).handler(
      {
        params: {
          actions: [{type: 'navigate_page', url: 'https://example.com'}],
        },
        page,
      },
      response,
      context,
    );

    const appended = response.appendResponseLine.args.map(a => a[0]);
    assert.ok(appended.some(line => line.includes('[NEW_TAB_OPENED] pageId=5')));
    assert.ok(appended.some(line => line.includes('[AUTH_2FA_DETECTED]')));
    assert.ok(appended.some(line => line.includes('kind=totp_input')));
  });
});
