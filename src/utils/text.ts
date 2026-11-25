/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {StringUtilities} from '../third_party/index.js';

const VALID_PLACEHOLDER_MATCH_PATTERN =
  /\{(PLACEHOLDER_[a-zA-Z][a-zA-Z0-9_]*)\}/g;

export function substitutePlaceholders(
  rawMarkdown: string,
  substitutions?: Map<string, string>,
): string {
  if (!substitutions) {
    return rawMarkdown;
  }

  return rawMarkdown.replace(
    VALID_PLACEHOLDER_MATCH_PATTERN,
    (_, placeholder) => {
      return substitutions.get(placeholder) ?? '';
    },
  );
}

/**
 * Truncates `text` to at most `maxLength` UTF-16 code units and appends
 * `ellipsis` when anything was cut off. The cut uses devtools-frontend's
 * `StringUtilities.truncateToCodeUnitLength`, which moves back to the last
 * grapheme boundary at or before the limit, so surrogate pairs and emoji
 * sequences stay whole and the result never contains a lone surrogate, which
 * `JSON.stringify` serializes as an escape like `\ud83d` that strict JSON
 * parsers (such as the one the Python MCP SDK uses) reject.
 *
 * With `includeEllipsisInLength`, the ellipsis counts toward `maxLength`.
 */
export function truncateText(
  text: string,
  maxLength: number,
  {
    ellipsis = '...',
    includeEllipsisInLength = false,
  }: {ellipsis?: string; includeEllipsisInLength?: boolean} = {},
): string {
  if (text.length <= maxLength) {
    return text;
  }
  const keep = includeEllipsisInLength
    ? Math.max(0, maxLength - ellipsis.length)
    : maxLength;
  return StringUtilities.truncateToCodeUnitLength(text, keep) + ellipsis;
}

const URL_SIZE_LIMIT = 255;

/**
 * Truncates a URL for tool output, such as a `data:` URL with a base64 payload.
 */
export function truncateUrl(url: string): string {
  return truncateText(url, URL_SIZE_LIMIT, {ellipsis: '... <truncated>'});
}

export const DEFAULT_RESPONSE_MAX_BYTES = 8800;

function sliceUtf8Head(buf: Buffer, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }
  let end = Math.min(buf.length, maxBytes);
  while (end > 0 && (buf[end] & 0xc0) === 0x80) {
    end--;
  }
  return buf.subarray(0, end).toString('utf8');
}

function sliceUtf8Tail(buf: Buffer, maxBytes: number): string {
  if (maxBytes <= 0) {
    return '';
  }
  let start = Math.max(0, buf.length - maxBytes);
  while (start < buf.length && (buf[start] & 0xc0) === 0x80) {
    start++;
  }
  return buf.subarray(start).toString('utf8');
}

/**
 * Folds `text` using a UTF-8 safe head-tail split so the resulting string
 * (including `buildNotice(totalBytes)`) does not exceed `maxBytes` UTF-8 bytes.
 */
export function foldHeadTailUtf8(
  text: string,
  maxBytes: number,
  buildNotice: (totalBytes: number) => string,
): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) {
    return text;
  }
  const notice = buildNotice(buf.length);
  const noticeBytes = Buffer.byteLength(notice, 'utf8');
  if (noticeBytes >= maxBytes) {
    return sliceUtf8Head(Buffer.from(notice, 'utf8'), maxBytes);
  }
  const remaining = maxBytes - noticeBytes;
  const headBudget = Math.floor(remaining * 0.6);
  const tailBudget = remaining - headBudget;
  return `${sliceUtf8Head(buf, headBudget)}${notice}${sliceUtf8Tail(buf, tailBudget)}`;
}
