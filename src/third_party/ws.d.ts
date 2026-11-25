/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

declare module 'ws' {
  export interface ClientOptions {
    followRedirects?: boolean;
    perMessageDeflate?: boolean;
    allowSynchronousEvents?: boolean;
    maxPayload?: number;
    handshakeTimeout?: number;
    headers?: Record<string, string>;
  }

  export default class WebSocket {
    constructor(
      address: string,
      protocols?: string | string[],
      options?: ClientOptions,
    );
    addEventListener(
      type: 'open' | 'close',
      listener: () => void,
    ): void;
    addEventListener(
      type: 'error',
      listener: (event: unknown) => void,
    ): void;
    removeEventListener(
      type: 'open' | 'close',
      listener: () => void,
    ): void;
    removeEventListener(
      type: 'error',
      listener: (event: unknown) => void,
    ): void;
    on(event: 'error', listener: (err: unknown) => void): this;
    terminate(): void;
    close(): void;
  }
}
