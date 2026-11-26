# Fork Changelog (`ycwang` / `develop`)

This fork tracks custom optimizations on `develop` over upstream `chrome-devtools-mcp` `v1.14.0`.

## `chrome-devtools-mcp-v1.14.0-ycwang.3` (2026-11-26)

### Commits over upstream `1.14.0`

1. **`5be1663` — `feat(cdp): add realtime WS/SSE/XHR capture, dialog/download/filechooser/auth queues, DOM wait, and network_monitors hot config`**
   - **Realtime WebSocket / SSE / XHR Capture**: Added `RealtimeNetworkCollector`, `RingBuffer`, and tools `list_websocket_connections`, `poll_ws_frames`, `poll_sse_events`, `wait_for_network_response`, `poll_network_alerts`, and `poll_monitor_events`.
   - **HTTP Auth, Dialog, Download & FileChooser Queues**: Added `handle_auth_challenge`, `wait_for_dialog` (plus enhanced `handle_dialog`), `list_downloads`, `wait_for_download` (`--interceptDownloads`), and `handle_file_chooser` (`--interceptFileChooser`).
   - **Shadow DOM-Aware `wait_for_dom`**: Added `wait_for_dom` supporting deep Shadow DOM traversal via `>>>` combinators.
   - **Hot-Reloaded `network_monitors.json`**: Added `NetworkMonitorsConfig` and `ConfigWatcher` for live-reloaded network monitoring rules, alert thresholds, and interception defaults.

2. **`7982fb3` — `feat(browser): add --cuaProxy auto-attach with TTL self-healing and harden connect_browser`**
   - Added `--cuaProxy` and `--cuaCommand` flags (`CuaProxyClient`) to auto-attach to the user's running Chrome profile (`existing_profile`) via `cua-ycwang`, with TTL self-healing and automatic proxy recovery without duplicate consent prompts.
   - Hardened `connect_browser` runtime switching and target synchronization.

3. **`ffe235f` — `style: apply prettier formatting across tools and formatters`**
   - Applied Prettier formatting across modified tools, formatters, and test files.

4. **`210713d` — `fix(browser): report disconnected navigation errors and wsEndpoint ECONNREFUSED clearly`**
   - Improved error reporting for disconnected navigation attempts and `wsEndpoint` `ECONNREFUSED` failures in `BrowserManager` and `pages.ts`.

5. **`d634c18` — `feat(browser): add connect_browser hot-switch tool with incognito and wsEndpoint support`**
   - Added `connect_browser` tool for runtime hot-switching between `wsEndpoint` proxies, `--isolated`, and `--incognito` browser sessions without restarting the MCP server.

6. **`610c4a5` — `feat(snapshot): add outlineOnly, formsOnly, and roles hierarchical filtering`** *(tagged `chrome-devtools-mcp-v1.14.0-ycwang.2`)*
   - Extended `take_snapshot` (and `batch_actions` snapshot steps) with `outlineOnly`, `formsOnly`, `roles`, and `rootUid` hierarchical filtering to reduce snapshot token footprint.

7. **`1c768f7` — `feat(mcp): add 8.8KB folding, screenshot isolation, snapshot pruning, batch_actions, diagnose_page_load, and connect abort`** *(tagged `chrome-devtools-mcp-v1.14.0-ycwang.1`)*
   - **8.8 KB Response Folding**: Automatically folds oversized MCP responses (>8.8 KB) to disk with preview/path metadata in `McpResponse`.
   - **Screenshot Isolation (`inline: false`)**: Supports saving screenshots to file without inline base64 payloads in tool responses.
   - **Snapshot Pruning**: Prunes redundant accessibility tree noise in `SnapshotFormatter`.
   - **Batch & Diagnostics Tools**: Added `batch_actions` for multi-step action/snapshot execution and `diagnose_page_load` for page-load timing, console, and network diagnostics, plus connect abort handling.
