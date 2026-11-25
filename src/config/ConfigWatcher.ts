/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';

import {Debouncer} from '../third_party/index.js';
import {getErrorMessage} from '../utils/errorHandling.js';
import {logger} from '../utils/logger.js';

const DEFAULT_DEBOUNCE_MS = 200;

/**
 * Returns undefined if the file cannot be read, for example while it is being
 * replaced.
 */
function readContent(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

export interface ConfigWatcherOptions {
  debounceMs?: number;
  allowMissing?: boolean;
  onDelete?: () => Promise<void> | void;
}

/**
 * Watches a config file and calls `onChange` with the new content after it was
 * modified.
 *
 * - Symlinks are resolved once on start, and the directory of the real file is
 *   watched. Watching the directory instead of the file keeps working when
 *   editors save atomically by replacing the file.
 * - Events are debounced because some platforms emit several events for a
 *   single change.
 * - Some platforms do not report the file name, such events are not filtered.
 * - `onChange` is only called if the content changed. For example, macOS can
 *   report events that happened shortly before the watcher was started.
 */
export class ConfigWatcher implements Disposable {
  readonly #configPath: string;
  readonly #onChange: (content: string) => Promise<void>;
  readonly #debounceMs: number;
  readonly #allowMissing: boolean;
  readonly #onDelete?: () => Promise<void> | void;
  #watcher?: fs.FSWatcher;
  #debounced?: ReturnType<typeof Debouncer.debounce>;
  #content?: string;
  #pending = Promise.resolve();

  constructor(
    configPath: string,
    onChange: (content: string) => Promise<void>,
    options: ConfigWatcherOptions = {},
  ) {
    this.#configPath = configPath;
    this.#onChange = onChange;
    this.#debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.#allowMissing = options.allowMissing ?? false;
    this.#onDelete = options.onDelete;
  }

  /**
   * Starts watching the config file. Throws if `configPath` does not exist
   * unless `allowMissing` is enabled.
   */
  start(): void {
    if (this.#watcher) {
      return;
    }
    let watchDir: string;
    let fileName: string;
    let targetPath: string;
    if (!this.#allowMissing) {
      targetPath = fs.realpathSync(this.#configPath);
      watchDir = path.dirname(targetPath);
      fileName = path.basename(targetPath);
      this.#content = readContent(targetPath);
    } else {
      try {
        targetPath = fs.realpathSync(this.#configPath);
        watchDir = path.dirname(targetPath);
        fileName = path.basename(targetPath);
        this.#content = readContent(targetPath);
      } catch {
        const resolved = path.resolve(this.#configPath);
        try {
          watchDir = fs.realpathSync(path.dirname(resolved));
        } catch {
          // Neither the file nor its parent directory exists; degrade gracefully.
          return;
        }
        fileName = path.basename(resolved);
        targetPath = path.join(watchDir, fileName);
        this.#content = undefined;
      }
    }

    this.#debounced = Debouncer.debounce(() => {
      let currentPath = targetPath;
      try {
        currentPath = fs.realpathSync(this.#configPath);
      } catch {
        // File may not exist yet or was removed.
      }
      const content = readContent(currentPath);
      if (content === undefined) {
        if (this.#allowMissing && this.#content !== undefined) {
          this.#content = undefined;
          if (this.#onDelete) {
            const onDelete = this.#onDelete;
            this.#pending = this.#pending
              .then(() => onDelete())
              .catch(err => {
                console.error(`Failed to reset ${this.#configPath}:`, err);
              });
          }
        }
        return;
      }
      if (content === this.#content) {
        return;
      }
      this.#content = content;
      this.#pending = this.#pending
        .then(() => this.#onChange(content))
        .catch(err => {
          console.error(`Failed to apply ${this.#configPath}:`, err);
        });
    }, this.#debounceMs);
    this.#watcher = fs.watch(
      watchDir,
      {persistent: false},
      (_eventType, changedFileName) => {
        if (changedFileName !== null && changedFileName !== fileName) {
          return;
        }
        this.#debounced?.();
      },
    );
    this.#watcher.on('error', err => {
      console.error(
        `Stopped watching ${this.#configPath}: ${getErrorMessage(err)}`,
      );
      this.dispose();
    });
    logger?.(`Watching ${targetPath} for config changes`);
  }

  dispose(): void {
    this.#debounced?.cancel();
    this.#debounced = undefined;
    this.#watcher?.close();
    this.#watcher = undefined;
  }

  [Symbol.dispose](): void {
    this.dispose();
  }
}
