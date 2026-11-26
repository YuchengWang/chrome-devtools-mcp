/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Page} from '../third_party/browser.js';

export type AuthGateKind =
  | 'totp_input'
  | 'passkey_switch_required'
  | 'login_form';

export interface AuthGateDetection {
  detected: boolean;
  kind?: AuthGateKind;
  url: string;
  hasOtpInput: boolean;
  hasPasswordInput: boolean;
  switchHint?: string;
  signal?: string;
}

const AUTH_URL_PATTERN =
  /\/(?:sessions\/two-factor|login|signin|oauth\/authorize|challenge|mfa|totp|2fa)(?:[/?#]|$)/i;

const EVALUATE_TIMEOUT_MS = 500;

interface DomAuthInspection {
  hasOtpInput: boolean;
  hasPasswordInput: boolean;
  switchHint?: string;
}

function formatAuthGateSignal(
  detection: Omit<AuthGateDetection, 'signal'>,
): string | undefined {
  if (!detection.detected || !detection.kind) {
    return undefined;
  }

  const serializedUrl = JSON.stringify(detection.url);

  switch (detection.kind) {
    case 'totp_input':
      return (
        `[AUTH_2FA_DETECTED] kind=totp_input url=${detection.url} — OTP/TOTP input detected. ` +
        `Call cua-ycwang:resolve_auth_site({ url: ${serializedUrl} }), focus the OTP input, ` +
        `and call cua-ycwang:bring_to_front + cua-ycwang:type_totp_from_env({ env_key, env_file, press_enter: true, min_remaining_secs: 4 }).`
      );
    case 'passkey_switch_required':
      return (
        `[AUTH_2FA_DETECTED] kind=passkey_switch_required url=${detection.url} ` +
        `switchHint=${JSON.stringify(detection.switchHint ?? '')} — 2FA page requires switching away from Passkey/WebAuthn. ` +
        `Click "${detection.switchHint ?? 'Use authenticator app'}" to switch to authenticator app, ` +
        `then call cua-ycwang:resolve_auth_site({ url: ${serializedUrl} }) and cua-ycwang:bring_to_front + cua-ycwang:type_totp_from_env.`
      );
    case 'login_form':
      return (
        `[AUTH_2FA_DETECTED] kind=login_form url=${detection.url} — Password login form detected. ` +
        `Call cua-ycwang:resolve_auth_site({ url: ${serializedUrl} }), focus the username/password inputs, ` +
        `and call cua-ycwang:bring_to_front + cua-ycwang:type_secret_from_env (do not read secrets.env directly).`
      );
  }
}

export function formatNewTabSignal(
  pageId: number,
  url: string,
  source = 'action',
): string {
  return `[NEW_TAB_OPENED] pageId=${pageId} url=${url} — A new tab was opened by ${source}. Use select_page({ pageId: ${pageId} }) to interact with it if needed.`;
}

export interface InspectablePage {
  readonly id: number;
  url?: () => string;
  init?: () => Promise<void>;
  isClosed?: () => boolean;
  readonly pptrPage: Page;
}

function getSafePageUrl(mcpPage: InspectablePage): string {
  try {
    if (typeof mcpPage.url === 'function') {
      const u = mcpPage.url();
      if (typeof u === 'string' && u.length > 0) {
        return u;
      }
    }
  } catch {
    // Ignore and fall back to pptrPage.url().
  }
  try {
    const u = mcpPage.pptrPage?.url?.();
    if (typeof u === 'string') {
      return u;
    }
  } catch {
    // McpPage may not be initialized yet.
  }
  return '';
}

async function getSafePptrPage(
  mcpPage: InspectablePage,
): Promise<Page | undefined> {
  try {
    return mcpPage.pptrPage;
  } catch {
    // Not initialized yet; try initializing if supported.
  }
  try {
    await mcpPage.init?.();
    return mcpPage.pptrPage;
  } catch {
    return undefined;
  }
}

export async function collectNewTabAndAuthSignals(options: {
  newPages: InspectablePage[];
  activePage?: InspectablePage;
  source: string;
}): Promise<string[]> {
  const lines: string[] = [];

  for (const newPage of options.newPages) {
    const pptrPage = await getSafePptrPage(newPage);
    const url = getSafePageUrl(newPage) || (pptrPage?.url?.() ?? '');
    lines.push(formatNewTabSignal(newPage.id, url, options.source));
    if (pptrPage) {
      const authGate = await detectAuthGate(pptrPage);
      if (authGate.detected && authGate.signal) {
        lines.push(authGate.signal);
      }
    }
  }

  if (
    !options.newPages.length &&
    options.activePage &&
    !options.activePage.isClosed?.()
  ) {
    const pptrPage = await getSafePptrPage(options.activePage);
    if (pptrPage) {
      const authGate = await detectAuthGate(pptrPage);
      if (authGate.detected && authGate.signal) {
        lines.push(authGate.signal);
      }
    }
  }

  return lines;
}

async function evaluateWithTimeout(
  page: Page,
  isAuthUrl: boolean,
): Promise<DomAuthInspection | undefined> {
  if (typeof page?.evaluate !== 'function') {
    return undefined;
  }
  if (typeof page.isClosed === 'function' && page.isClosed()) {
    return undefined;
  }

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const evalPromise = page.evaluate((authUrlMatched: boolean) => {
      const otpSelector = [
        'input[autocomplete="one-time-code"]',
        'input[name="app_otp"]',
        'input[name="otp"]',
        'input[name="totp"]',
        'input[id*="otp" i]',
        'input[id*="totp" i]',
      ]
        .map(sel => `${sel}:not([type="hidden"]):not([disabled])`)
        .join(', ');

      const hasOtpInput = Boolean(document.querySelector(otpSelector));
      const hasPasswordInput = Boolean(
        document.querySelector('input[type="password"]:not([disabled])'),
      );

      let switchHint: string | undefined;
      if (!hasOtpInput) {
        const candidates = document.querySelectorAll(
          'a, button, [role="button"], summary',
        );
        const bodyText = document.body?.innerText ?? '';
        const has2faContext =
          authUrlMatched ||
          /\b(?:two[- ]factor|2fa|passkey|security key|verification|authenticate)\b/i.test(
            bodyText,
          );

        for (const el of candidates) {
          const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
          if (!text || text.length > 120) {
            continue;
          }
          if (/\buse authenticator app\b|\bauthenticator app\b/i.test(text)) {
            switchHint = text;
            break;
          }
          if (has2faContext && /\btry another way\b/i.test(text)) {
            switchHint = text;
            break;
          }
        }
      }

      return {
        hasOtpInput,
        hasPasswordInput,
        ...(switchHint ? {switchHint} : {}),
      };
    }, isAuthUrl);

    const timeoutPromise = new Promise<undefined>(resolve => {
      timer = setTimeout(() => resolve(undefined), EVALUATE_TIMEOUT_MS);
    });

    const result = await Promise.race([evalPromise, timeoutPromise]);
    if (!result || typeof result !== 'object') {
      return undefined;
    }
    return result;
  } catch {
    return undefined;
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

export async function detectAuthGate(page: Page): Promise<AuthGateDetection> {
  const url = typeof page?.url === 'function' ? page.url() : '';
  const isAuthUrl = AUTH_URL_PATTERN.test(url);

  const inspection = await evaluateWithTimeout(page, isAuthUrl);
  const hasOtpInput = Boolean(inspection?.hasOtpInput);
  const hasPasswordInput = Boolean(inspection?.hasPasswordInput);
  const switchHint = inspection?.switchHint;

  let kind: AuthGateKind | undefined;
  if (hasOtpInput) {
    kind = 'totp_input';
  } else if (switchHint) {
    kind = 'passkey_switch_required';
  } else if (hasPasswordInput) {
    kind = 'login_form';
  }

  const baseDetection: Omit<AuthGateDetection, 'signal'> = {
    detected: kind !== undefined,
    ...(kind ? {kind} : {}),
    url,
    hasOtpInput,
    hasPasswordInput,
    ...(switchHint ? {switchHint} : {}),
  };

  const signal = formatAuthGateSignal(baseDetection);
  return {
    ...baseDetection,
    ...(signal ? {signal} : {}),
  };
}
