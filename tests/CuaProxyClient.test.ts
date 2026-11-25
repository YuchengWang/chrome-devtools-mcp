/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import {describe, it} from 'node:test';

import sinon from 'sinon';

import {BrowserManager, connectTransport} from '../src/BrowserManager.js';
import {CuaProxyClient} from '../src/CuaProxyClient.js';
import {
  puppeteer,
  type ConnectionTransport,
} from '../src/third_party/browser.js';

import {createMockPuppeteerBrowser, createMockServerConfig} from './mocks.js';
import {createTempDir} from './utils.js';

function writeMockCuaScript(dirPath: string, body: string): string {
  const scriptPath = path.join(dirPath, 'mock-cua-ycwang.mjs');
  const fullScript = `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';

const args = process.argv.slice(2);
if (args[0] !== 'mcp' || !args.includes('--grant') || !args.includes('existing-profile')) {
  process.stderr.write('Unexpected args: ' + JSON.stringify(args) + '\\n');
  process.exit(2);
}

${body}
`;
  fs.writeFileSync(scriptPath, fullScript, {mode: 0o755});
  return scriptPath;
}

function stubConnectTransport() {
  const transport: ConnectionTransport = {
    send: sinon.stub(),
    close: sinon.stub(),
  };
  const terminate = sinon.stub();
  const createStub = sinon
    .stub(connectTransport, 'create')
    .resolves({transport, terminate});
  return {createStub, transport, terminate};
}

describe('CuaProxyClient and BrowserManager --cuaProxy', () => {
  it('reuses a single long-lived cua-ycwang stdio child, launches Chrome when absent, and cleans up on close()', async () => {
    using tempDir = createTempDir('cdm-cua-launch-');
    const logPath = path.join(tempDir.path, 'calls.log');
    const cuaCommand = writeMockCuaScript(
      tempDir.path,
      `
const logPath = ${JSON.stringify(logPath)};
let chromeOpen = false;
let prepareCount = 0;

const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
rl.on('line', line => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.id === undefined) {
    fs.appendFileSync(logPath, JSON.stringify({pid: process.pid, method: req.method}) + '\\n');
    return;
  }
  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: {protocolVersion: '2024-11-05', capabilities: {tools: {}}},
    }) + '\\n');
    return;
  }
  if (req.method === 'tools/call') {
    const {name, arguments: toolArgs} = req.params;
    fs.appendFileSync(logPath, JSON.stringify({pid: process.pid, name, args: toolArgs}) + '\\n');
    if (name === 'list_windows') {
      const windows = chromeOpen
        ? [{window_id: 77, pid: 4321, is_on_screen: true, z_index: 2}]
        : [];
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: {content: [{type: 'text', text: 'windows'}], isError: false, structuredContent: {windows}},
      }) + '\\n');
      return;
    }
    if (name === 'launch_app') {
      chromeOpen = true;
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          content: [{type: 'text', text: 'launched'}],
          isError: false,
          structuredContent: {pid: 4321, windows: []},
        },
      }) + '\\n');
      return;
    }
    if (name === 'browser_prepare') {
      prepareCount++;
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          content: [{type: 'text', text: 'ok'}],
          isError: false,
          structuredContent: {
            status: 'ok',
            prepared: true,
            ws_endpoint: 'ws://127.0.0.1:18881/devtools/browser/tok' + prepareCount,
          },
        },
      }) + '\\n');
    }
  }
});
`,
    );

    const browser1 = createMockPuppeteerBrowser();
    const {createStub} = stubConnectTransport();
    const connectStub = sinon.stub(puppeteer, 'connect').resolves(browser1);

    const manager = new BrowserManager(
      createMockServerConfig({
        cuaProxy: true,
        cuaCommand,
      }),
    );

    const acquired = await manager.ensureBrowser();
    assert.strictEqual(acquired, browser1);
    // Repeated ensureBrowser() while connected returns cached browser without re-calling cua.
    assert.strictEqual(await manager.ensureBrowser(), browser1);
    sinon.assert.calledOnce(createStub);
    assert.strictEqual(
      createStub.firstCall.args[0],
      'ws://127.0.0.1:18881/devtools/browser/tok1',
    );
    sinon.assert.calledOnce(connectStub);

    await manager.close();
    sinon.assert.calledOnce(browser1.disconnect);

    const entries = fs
      .readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    const pids = new Set(entries.map(e => e['pid']));
    assert.strictEqual(pids.size, 1, 'Expected a single child PID');
    assert.deepStrictEqual(
      entries.map(e => e['name'] ?? e['method']),
      [
        'notifications/initialized',
        'list_windows',
        'launch_app',
        'list_windows',
        'browser_prepare',
      ],
    );
  });

  it('self-heals on ECONNREFUSED and disconnected TTL expiry without restarting chrome-devtools-mcp', async () => {
    using tempDir = createTempDir('cdm-cua-heal-');
    const logPath = path.join(tempDir.path, 'heal.log');
    const cuaCommand = writeMockCuaScript(
      tempDir.path,
      `
const logPath = ${JSON.stringify(logPath)};
let prepareCount = 0;

const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
rl.on('line', line => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.id === undefined) return;
  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: {protocolVersion: '2024-11-05', capabilities: {tools: {}}},
    }) + '\\n');
    return;
  }
  if (req.method === 'tools/call') {
    const {name, arguments: toolArgs} = req.params;
    fs.appendFileSync(logPath, JSON.stringify({pid: process.pid, name, session: toolArgs?.session}) + '\\n');
    if (name === 'list_windows') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          content: [{type: 'text', text: 'ok'}],
          isError: false,
          structuredContent: {
            windows: [{window_id: 101, pid: 9001, is_on_screen: true, z_index: 1}],
          },
        },
      }) + '\\n');
      return;
    }
    if (name === 'browser_prepare') {
      prepareCount++;
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          content: [{type: 'text', text: 'ok'}],
          isError: false,
          structuredContent: {
            status: 'ok',
            prepared: true,
            ws_endpoint: 'ws://127.0.0.1:1900' + prepareCount + '/devtools/browser/tok' + prepareCount,
          },
        },
      }) + '\\n');
    }
  }
});
`,
    );

    const browser1 = createMockPuppeteerBrowser();
    let browser1Connected = true;
    sinon.stub(browser1, 'connected').get(() => browser1Connected);
    const browser2 = createMockPuppeteerBrowser();
    const {createStub, transport, terminate} = stubConnectTransport();
    const refusedErr = Object.assign(
      new Error('connect ECONNREFUSED 127.0.0.1:19001'),
      {code: 'ECONNREFUSED'},
    );
    // Call 1 fails with ECONNREFUSED (expired ws_endpoint_1), call 2 recovers on ws_endpoint_2,
    // then browser1 disconnects (30m/8h TTL expiry), call 3 recovers silently on ws_endpoint_3.
    createStub.onCall(0).rejects(refusedErr);
    createStub.onCall(1).resolves({transport, terminate});
    createStub.onCall(2).resolves({transport, terminate});

    const connectStub = sinon.stub(puppeteer, 'connect');
    connectStub.onFirstCall().resolves(browser1);
    connectStub.onSecondCall().resolves(browser2);

    const manager = new BrowserManager(
      createMockServerConfig({
        cuaProxy: true,
        cuaCommand,
      }),
    );

    const first = await manager.ensureBrowser();
    assert.strictEqual(first, browser1);
    assert.strictEqual(
      createStub.getCall(0).args[0],
      'ws://127.0.0.1:19001/devtools/browser/tok1',
    );
    assert.strictEqual(
      createStub.getCall(1).args[0],
      'ws://127.0.0.1:19002/devtools/browser/tok2',
    );

    // Simulate 30m/8h TTL expiry closing the proxy socket -> Puppeteer 'disconnected'.
    browser1Connected = false;
    browser1.emit('disconnected', undefined);

    const second = await manager.ensureBrowser();
    assert.strictEqual(second, browser2);
    assert.strictEqual(
      createStub.getCall(2).args[0],
      'ws://127.0.0.1:19003/devtools/browser/tok3',
    );

    await manager.close();

    const entries = fs
      .readFileSync(logPath, 'utf8')
      .trim()
      .split('\n')
      .map(line => JSON.parse(line) as Record<string, unknown>);
    const pids = new Set(entries.map(e => e['pid']));
    assert.strictEqual(
      pids.size,
      1,
      'Long-lived cua-ycwang child must be reused across self-healing',
    );
  });

  it('respawns cua-ycwang if the child process exits and rotates ended sessions', async () => {
    using tempDir = createTempDir('cdm-cua-respawn-');
    const statePath = path.join(tempDir.path, 'state.json');
    fs.writeFileSync(statePath, JSON.stringify({starts: 0}));
    const cuaCommand = writeMockCuaScript(
      tempDir.path,
      `
const statePath = ${JSON.stringify(statePath)};
const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
state.starts++;
const startNum = state.starts;
fs.writeFileSync(statePath, JSON.stringify(state));

const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
rl.on('line', line => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.id === undefined) return;
  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: {protocolVersion: '2024-11-05', capabilities: {tools: {}}},
    }) + '\\n');
    return;
  }
  if (req.method === 'tools/call') {
    const {name, arguments: toolArgs} = req.params;
    if (name === 'list_windows') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          content: [{type: 'text', text: 'ok'}],
          isError: false,
          structuredContent: {
            windows: [{window_id: 22, pid: 2222, is_on_screen: true, z_index: 0}],
          },
        },
      }) + '\\n');
      return;
    }
    if (name === 'browser_prepare') {
      if (startNum === 2 && toolArgs.session === 'cua-proxy-1') {
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0',
          id: req.id,
          result: {
            content: [{type: 'text', text: "session 'cua-proxy-1' has ended"}],
            isError: true,
            structuredContent: {code: 'session_ended'},
          },
        }) + '\\n');
        return;
      }
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          content: [{type: 'text', text: 'ok'}],
          isError: false,
          structuredContent: {
            status: 'ok',
            prepared: true,
            ws_endpoint: 'ws://127.0.0.1:1910' + startNum + '/devtools/browser/respawn' + startNum,
          },
        },
      }) + '\\n');
      if (startNum === 1) {
        // Simulate unexpected child crash shortly after handing out endpoint 1.
        setTimeout(() => process.exit(1), 20);
      }
    }
  }
});
`,
    );

    const browser1 = createMockPuppeteerBrowser();
    let browser1Connected = true;
    sinon.stub(browser1, 'connected').get(() => browser1Connected);
    const browser2 = createMockPuppeteerBrowser();
    stubConnectTransport();
    const connectStub = sinon.stub(puppeteer, 'connect');
    connectStub.onFirstCall().resolves(browser1);
    connectStub.onSecondCall().resolves(browser2);

    const manager = new BrowserManager(
      createMockServerConfig({cuaProxy: true, cuaCommand}),
    );

    assert.strictEqual(await manager.ensureBrowser(), browser1);
    await new Promise(resolve => setTimeout(resolve, 60));

    browser1Connected = false;
    browser1.emit('disconnected', undefined);

    assert.strictEqual(await manager.ensureBrowser(), browser2);
    const finalState = JSON.parse(fs.readFileSync(statePath, 'utf8')) as {
      starts: number;
    };
    assert.strictEqual(finalState.starts, 2);
    await manager.close();
  });

  it('prefers explicit wsEndpoint or isolated over cuaProxy', async () => {
    using tempDir = createTempDir('cdm-cua-override-');
    const markerPath = path.join(tempDir.path, 'spawned.txt');
    const cuaCommand = writeMockCuaScript(
      tempDir.path,
      `fs.writeFileSync(${JSON.stringify(markerPath)}, 'spawned');`,
    );

    const browserWs = createMockPuppeteerBrowser();
    const browserIso = createMockPuppeteerBrowser();
    stubConnectTransport();
    sinon.stub(puppeteer, 'connect').resolves(browserWs);
    sinon.stub(puppeteer, 'launch').resolves(browserIso);

    const wsManager = new BrowserManager(
      createMockServerConfig({
        cuaProxy: true,
        cuaCommand,
        wsEndpoint: 'ws://127.0.0.1:19999/devtools/browser/explicit',
      }),
    );
    assert.strictEqual(await wsManager.ensureBrowser(), browserWs);
    assert.strictEqual(fs.existsSync(markerPath), false);
    await wsManager.close();

    const isoManager = new BrowserManager(
      createMockServerConfig({
        cuaProxy: true,
        cuaCommand,
        isolated: true,
        headless: true,
      }),
    );
    assert.strictEqual(await isoManager.ensureBrowser(), browserIso);
    assert.strictEqual(fs.existsSync(markerPath), false);
    await isoManager.close();
  });

  it('aborts hung cua-ycwang calls when AbortSignal fires', async () => {
    using tempDir = createTempDir('cdm-cua-abort-');
    const cuaCommand = writeMockCuaScript(
      tempDir.path,
      `
const rl = readline.createInterface({input: process.stdin, crlfDelay: Infinity});
rl.on('line', line => {
  if (!line.trim()) return;
  const req = JSON.parse(line);
  if (req.id === undefined) return;
  if (req.method === 'initialize') {
    process.stdout.write(JSON.stringify({
      jsonrpc: '2.0',
      id: req.id,
      result: {protocolVersion: '2024-11-05', capabilities: {tools: {}}},
    }) + '\\n');
    return;
  }
  if (req.method === 'tools/call') {
    const {name} = req.params;
    if (name === 'list_windows') {
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0',
        id: req.id,
        result: {
          content: [{type: 'text', text: 'ok'}],
          isError: false,
          structuredContent: {
            windows: [{window_id: 1, pid: 100, is_on_screen: true}],
          },
        },
      }) + '\\n');
    }
    // Intentionally hang on browser_prepare.
  }
});
`,
    );

    const client = new CuaProxyClient({cuaCommand});
    const controller = new AbortController();
    const acquirePromise = client.acquireWsEndpoint({
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error('timed out')), 40);
    await assert.rejects(acquirePromise, /timed out/);
    await client.close();
  });
});
