/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import os from 'node:os';
import process from 'node:process';
import {logger} from './logger.js';

type PermissionErrorCode = 'EPERM' | 'EACCES';

function isErrnoPermissionError(
  error: unknown,
): error is {code: PermissionErrorCode} {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error.code === 'EPERM' || error.code === 'EACCES')
  );
}

function isPuppeteerActivePortPermissionError(
  error: unknown,
): error is Error & {cause: {code: PermissionErrorCode}} {
  return (
    error instanceof Error &&
    error.message.startsWith('Could not read DevToolsActivePort for ') &&
    isErrnoPermissionError(error.cause)
  );
}

export function devToolsActivePortPermissionError(
  error: unknown,
  userDataDir?: string,
): Error | undefined {
  let code: PermissionErrorCode | undefined;
  if (userDataDir !== undefined) {
    if (error instanceof Error && isErrnoPermissionError(error)) {
      code = error.code;
    }
  } else if (isPuppeteerActivePortPermissionError(error)) {
    code = error.cause.code;
  }
  if (!code) {
    return undefined;
  }
  const prefix =
    userDataDir !== undefined
      ? `Could not connect to Chrome in ${userDataDir}`
      : 'Could not connect to Chrome';
  const hint =
    os.platform() === 'darwin' && code === 'EPERM'
      ? 'macOS blocked reading DevToolsActivePort. Grant the host ' +
        'application (such as your terminal or IDE) access to Google Chrome ' +
        'in System Settings > Privacy & Security > Files & Folders, then ' +
        'try again.'
      : 'reading DevToolsActivePort was denied by file permissions. Check ' +
        'that the current user can read the Chrome profile directory, then ' +
        'try again.';
  return new Error(`${prefix}: ${hint}`, {
    cause: error,
  });
}

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

const DETACHED_NAVIGATION_PATTERNS = [
  'navigating frame was detached',
  'navigation detached',
  'frame detached',
  'frame got detached',
  'attempted to use detached frame',
  'execution context is not available in detached frame',
  'execution context was destroyed',
  'cannot find context with specified id',
  'waiting failed: frame detached',
];

/**
 * Returns true if `err` indicates a Puppeteer/CDP frame or execution context
 * detachment while the browser target may still be alive on a newer frame.
 */
export function isDetachedNavigationError(err: unknown): boolean {
  const message = getErrorMessage(err).toLowerCase();
  return DETACHED_NAVIGATION_PATTERNS.some(pattern =>
    message.includes(pattern),
  );
}

/**
 * Validates that a string compiles cleanly as a JavaScript RegExp.
 */
export function compileRegex(pattern: string, flags?: string): RegExp {
  return new RegExp(pattern, flags);
}

export function setupUnhandledRejectionHandler(onCrash: () => void): void {
  process.on('unhandledRejection', (reason, promise) => {
    logger?.('Unhandled promise rejection:', promise, reason);
    console.error('Unhandled promise rejection:', reason);

    if (process.env['CHROME_DEVTOOLS_MCP_CRASH_ON_UNCAUGHT'] === 'true') {
      onCrash();
    }
  });
}
