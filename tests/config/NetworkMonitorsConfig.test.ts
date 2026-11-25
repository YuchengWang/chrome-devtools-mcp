/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {describe, it} from 'node:test';

import {
  NetworkMonitorsManager,
  parseNetworkMonitorsConfig,
} from '../../src/config/NetworkMonitorsConfig.js';
import {createTempDir} from '../utils.js';

describe('NetworkMonitorsConfig', () => {
  it('parses monitors, auto_dialog_policy, and auto_auth_policy', () => {
    const parsed = parseNetworkMonitorsConfig(
      JSON.stringify({
        monitors: [
          {
            id: 'api-watch',
            types: ['xhr', 'fetch'],
            urlRegex: '/api\\/v1\\//',
            methods: ['post'],
            statuses: [200, 201],
            includeBody: true,
            jsonlPath: 'tmp/api-events.jsonl',
          },
          {
            id: 'ws-watch',
            types: ['ws'],
            urlPattern: '*://ws.example.com/*',
            wsDirection: 'received',
          },
        ],
        auto_dialog_policy: {
          default: 'queue',
          alert: 'accept',
          prompt: {
            action: 'accept',
            promptText: 'ok',
          },
          rules: [
            {
              type: 'confirm',
              url_regex: 'trusted\\.example',
              message_regex: 'Proceed',
              action: 'accept',
            },
          ],
        },
        auto_auth_policy: {
          defaultAction: 'cancel',
          queueTimeoutMs: 5000,
          rules: [
            {
              originRegex: '^https://auth\\.example\\.com$',
              source: 'Server',
              action: 'provide',
              username: 'alice',
              password: 'secret',
            },
          ],
        },
      }),
    );

    assert.equal(parsed.monitors.length, 2);
    assert.equal(parsed.monitors[0].id, 'api-watch');
    assert.deepEqual(parsed.monitors[0].methods, ['POST']);
    assert.equal(parsed.autoDialogPolicy?.alert, 'accept');
    assert.equal(parsed.autoDialogPolicy?.prompt?.promptText, 'ok');
    assert.equal(parsed.autoDialogPolicy?.rules.length, 1);
    assert.equal(parsed.autoAuthPolicy?.defaultAction, 'cancel');
    assert.equal(parsed.autoAuthPolicy?.rules[0].action, 'provide');
  });

  it('degrades gracefully when network_monitors.json is missing', () => {
    using dir = createTempDir();
    const missingPath = path.join(dir.path, 'network_monitors.json');
    using manager = new NetworkMonitorsManager({
      configPath: missingPath,
      cwd: dir.path,
      tmpDir: dir.path,
      skipDiscovery: false,
    });
    manager.start();

    const status = manager.getStatus();
    assert.equal(status.loaded, false);
    assert.equal(status.monitorCount, 0);
    assert.equal(status.lastError, undefined);
    assert.deepEqual(manager.getConfig().monitors, []);
  });

  it('buffers and writes matched events to safe tmp/ JSONL paths and hot-reloads changes', async () => {
    using dir = createTempDir();
    const configPath = path.join(dir.path, 'network_monitors.json');
    const jsonlRel = 'tmp/monitors/orders.jsonl';
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        monitors: [
          {
            id: 'orders',
            types: ['fetch', 'ws', 'sse'],
            urlRegex: 'https://api\\.example\\.com/orders',
            includeBody: true,
            jsonlPath: jsonlRel,
          },
        ],
        auto_dialog_policy: 'dismiss',
      }),
      'utf8',
    );

    using manager = new NetworkMonitorsManager({
      configPath,
      cwd: dir.path,
      tmpDir: dir.path,
      debounceMs: 30,
      skipDiscovery: false,
    });
    manager.start();

    assert.equal(manager.getStatus().loaded, true);
    assert.equal(
      manager.resolveDialogAction({
        type: 'alert',
        url: 'https://api.example.com',
        message: 'hi',
      }).action,
      'dismiss',
    );

    const matched = manager.recordEvent({
      type: 'fetch',
      url: 'https://api.example.com/orders',
      timestamp: 1234,
      method: 'POST',
      status: 201,
      body: '{"id":42}',
    });
    assert.equal(matched.length, 1);

    await manager.flush();
    const diskPath = path.join(dir.path, jsonlRel);
    const lines = fs.readFileSync(diskPath, 'utf8').trim().split('\n');
    assert.equal(lines.length, 1);
    const parsedLine = JSON.parse(lines[0]) as {
      monitorId: string;
      body: string;
    };
    assert.equal(parsedLine.monitorId, 'orders');
    assert.equal(parsedLine.body, '{"id":42}');

    const polled = manager.pollEvents({monitorId: 'orders'});
    assert.equal(polled.entries.length, 1);

    // Hot reload update via ConfigWatcher.
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        monitors: [
          {
            id: 'orders-v2',
            types: ['sse'],
            urlPattern: '*://api.example.com/*',
          },
        ],
      }),
      'utf8',
    );
    const deadline = Date.now() + 3000;
    while (
      Date.now() < deadline &&
      manager.getConfig().monitors[0]?.id !== 'orders-v2'
    ) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(manager.getConfig().monitors[0]?.id, 'orders-v2');
  });

  it('rejects path traversal in monitor jsonlPath before normalization', async () => {
    using dir = createTempDir();
    using manager = new NetworkMonitorsManager({
      configPath: path.join(dir.path, 'missing.json'),
      cwd: dir.path,
      tmpDir: dir.path,
      skipDiscovery: true,
    });
    for (const badPath of [
      '../escape.jsonl',
      'tmp/../.env',
      'tmp\\..\\.env',
      'tmp/sub\0evil.jsonl',
      'tmp/.',
      'tmp/',
    ]) {
      await assert.rejects(
        manager.resolveJsonlPath(badPath),
        /Invalid monitor jsonlPath/,
      );
    }
  });

  it('enforces realpath parent directory bounds, workspace roots, and O_NOFOLLOW with mode 0o600', async () => {
    using dir = createTempDir();
    using outsideDir = createTempDir('cdm-outside-');
    using workspaceDir = createTempDir('cdm-workspace-');

    const cwdTmp = path.join(dir.path, 'tmp');
    fs.mkdirSync(cwdTmp, {recursive: true});
    const symlinkDir = path.join(cwdTmp, 'escaped-dir');
    fs.symlinkSync(outsideDir.path, symlinkDir);

    const symlinkTarget = path.join(cwdTmp, 'symlink-target.jsonl');
    const outsideTarget = path.join(outsideDir.path, 'target.jsonl');
    fs.writeFileSync(outsideTarget, 'original\n', 'utf8');
    fs.symlinkSync(outsideTarget, symlinkTarget);

    // Even when a permissive validatePath stub simulates --allow-unrestricted-paths,
    // getAllowedRoots restricts monitor JSONL files strictly to tmp/ or workspace roots.
    const configPath = path.join(dir.path, 'monitors.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        monitors: [
          {
            id: 'symlink-target',
            types: ['fetch'],
            urlPattern: '*://symlink.example.com/*',
            jsonlPath: 'tmp/symlink-target.jsonl',
          },
          {
            id: 'safe-workspace',
            types: ['fetch'],
            urlPattern: '*://workspace.example.com/*',
            jsonlPath: path.join(workspaceDir.path, 'logs', 'events.jsonl'),
          },
        ],
      }),
      'utf8',
    );

    using manager = new NetworkMonitorsManager({
      configPath,
      cwd: dir.path,
      tmpDir: dir.path,
      skipDiscovery: false,
      validatePath: async filePath => filePath,
      getAllowedRoots: () => [workspaceDir.path],
    });
    manager.start();

    await assert.rejects(
      manager.resolveJsonlPath('tmp/escaped-dir/evil.jsonl'),
      /must reside under tmp\/ or an allowed workspace root/,
    );
    await assert.rejects(
      manager.resolveJsonlPath(path.join(outsideDir.path, 'evil.jsonl')),
      /must reside under tmp\/ or an allowed workspace root/,
    );

    // O_NOFOLLOW rejects writing through symlinked target file.
    manager.recordEvent({
      type: 'fetch',
      url: 'https://symlink.example.com/api',
      timestamp: 100,
    });
    // Safe workspace root path succeeds with 0o600 and drains #writeQueues.
    manager.recordEvent({
      type: 'fetch',
      url: 'https://workspace.example.com/api',
      timestamp: 200,
    });
    await manager.flush();

    assert.equal(manager.pendingWriteCount, 0);
    assert.equal(fs.readFileSync(outsideTarget, 'utf8'), 'original\n');
    const safeOut = path.join(workspaceDir.path, 'logs', 'events.jsonl');
    assert.ok(fs.existsSync(safeOut));
    assert.equal(fs.statSync(safeOut).mode & 0o777, 0o600);
  });

  it('strips wsPayload/sseData when includeBody is false and truncates by UTF-8 bytes when true', () => {
    using dir = createTempDir();
    const configPath = path.join(dir.path, 'monitors.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        monitors: [
          {
            id: 'no-body',
            types: ['fetch', 'ws', 'sse'],
            urlPattern: '*://nobody.example.com/*',
            includeBody: false,
          },
          {
            id: 'bounded-body',
            types: ['fetch', 'ws', 'sse'],
            urlPattern: '*://bounded.example.com/*',
            includeBody: true,
            maxBodyBytes: 10,
          },
        ],
      }),
      'utf8',
    );
    using manager = new NetworkMonitorsManager({
      configPath,
      cwd: dir.path,
      tmpDir: dir.path,
      skipDiscovery: false,
    });
    manager.start();

    manager.recordEvent({
      type: 'ws',
      url: 'wss://nobody.example.com/socket',
      timestamp: 1,
      wsDirection: 'received',
      wsPayload: 'secret-ws',
    });
    manager.recordEvent({
      type: 'sse',
      url: 'https://nobody.example.com/events',
      timestamp: 2,
      sseEventName: 'msg',
      sseData: 'secret-sse',
    });

    const noBodyPolled = manager.pollEvents({monitorId: 'no-body'});
    assert.equal(noBodyPolled.entries.length, 2);
    assert.equal(noBodyPolled.entries[0].data.wsPayload, undefined);
    assert.equal(noBodyPolled.entries[1].data.sseData, undefined);

    const multiByte = '中文测试123456'; // 18 UTF-8 bytes
    manager.recordEvent({
      type: 'ws',
      url: 'wss://bounded.example.com/socket',
      timestamp: 3,
      wsDirection: 'sent',
      wsPayload: multiByte,
    });
    manager.recordEvent({
      type: 'sse',
      url: 'https://bounded.example.com/events',
      timestamp: 4,
      sseEventName: 'msg',
      sseData: multiByte,
    });

    const boundedPolled = manager.pollEvents({monitorId: 'bounded-body'});
    assert.equal(boundedPolled.entries.length, 2);
    assert.equal(boundedPolled.entries[0].data.wsPayload, '中文测');
    assert.equal(
      Buffer.byteLength(boundedPolled.entries[0].data.wsPayload ?? '', 'utf8'),
      9,
    );
    assert.equal(boundedPolled.entries[0].data.bodyTruncated, true);
    assert.equal(boundedPolled.entries[1].data.sseData, '中文测');
    assert.equal(boundedPolled.entries[1].data.bodyTruncated, true);
  });

  it('defaults auto_auth_policy to "default" and emits onConfigChange on reload', async () => {
    using dir = createTempDir();
    const configPath = path.join(dir.path, 'monitors.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        intercept_downloads: true,
        intercept_file_chooser: true,
      }),
      'utf8',
    );
    using manager = new NetworkMonitorsManager({
      configPath,
      cwd: dir.path,
      tmpDir: dir.path,
      debounceMs: 25,
      skipDiscovery: false,
    });
    manager.start();
    let changeCount = 0;
    const unsubscribe = manager.onConfigChange(() => {
      changeCount++;
    });

    assert.equal(manager.getConfig().interceptDownloads, true);
    assert.equal(manager.getConfig().interceptFileChooser, true);
    assert.equal(
      manager.resolveAuthAction({
        url: 'https://example.com',
        origin: 'https://example.com',
        realm: 'Test',
        source: 'Server',
      }).action,
      'default',
    );

    fs.writeFileSync(
      configPath,
      JSON.stringify({
        auto_auth_policy: {rules: []},
      }),
      'utf8',
    );
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline && changeCount === 0) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(changeCount >= 1);
    assert.equal(manager.getConfig().autoAuthPolicy?.defaultAction, 'default');
    unsubscribe();
  });
});
