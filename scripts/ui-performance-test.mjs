import fsp from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const [app, html, css, modern, timeline, server] = await Promise.all([
  fsp.readFile(path.join(root, "public", "app.js"), "utf8"),
  fsp.readFile(path.join(root, "public", "index.html"), "utf8"),
  fsp.readFile(path.join(root, "public", "layout-fix.css"), "utf8"),
  fsp.readFile(path.join(root, "public", "modern-ui.css"), "utf8"),
  fsp.readFile(path.join(root, "public", "timeline.js"), "utf8"),
  fsp.readFile(path.join(root, "server.mjs"), "utf8"),
]);

const checks = {
  stream_updates_are_batched: app.includes("requestAnimationFrame(flushStreamUpdates)"),
  streaming_does_not_scan_all_messages: !app.includes('document.querySelectorAll(".message.assistant")'),
  scrolling_is_tail_aware: app.includes("function isNearBottom()") && app.includes("if (!state.followTail)"),
  long_history_is_progressive: app.includes("HISTORY_BATCH_SIZE") && app.includes("renderEarlierHistory"),
  control_events_are_coalesced: app.includes("scheduleControlRefresh(modeChanged)"),
  viewport_updates_are_frame_limited: app.includes("function scheduleViewportSync()"),
  return_to_bottom_control_exists: html.includes('id="newMessagesBtn"'),
  historical_cards_use_content_visibility: css.includes("content-visibility:auto"),
  reduced_motion_is_supported: css.includes("prefers-reduced-motion:reduce"),
  thread_switch_uses_lru_cache: app.includes("THREAD_VIEW_LIMIT") && app.includes("rememberThreadView"),
  stale_switches_are_aborted: app.includes("new AbortController()") && app.includes("await delay(120, controller.signal)"),
  cached_snapshot_loads_first: app.includes("/snapshot") && server.includes("threadSnapshotCache"),
  heavy_timeline_bodies_are_lazy: timeline.includes("function populateBody") && timeline.includes("展开后加载详细内容"),
};

checks.modern_ui_layer_is_loaded = html.includes("/modern-ui.css") && modern.includes("--ui-accent");
checks.theme_toggle_is_persistent = app.includes("codex-web-theme") && app.includes("document.documentElement.dataset.theme");
checks.modern_ui_supports_reduced_motion = modern.includes("prefers-reduced-motion: reduce");
checks.snapshot_sync_is_bounded = app.includes("snapshotTimer") && app.includes("10_000") && server.includes("readReadonlyThreadSingleFlight");
checks.readonly_mode_uses_snapshots = app.includes("/api/threads/${encodeURIComponent(thread.id)}/snapshot") && app.includes("readonly-mode");
checks.long_history_has_bounded_dom = app.includes("HISTORY_DOM_LIMIT") && app.includes("trimHistoryWindow") && app.includes("renderLaterHistory");
checks.uploads_have_progress_and_recovery = app.includes("XMLHttpRequest") && app.includes("retryUpload") && app.includes("codex-web-draft:");
checks.shared_control_state_is_visible = app.includes("webClientCount") && html.includes('id="controlMeta"') && server.includes("sharedWebControl");
checks.account_token_usage_has_source_boundaries = html.includes('id="usageHourTokens"') && app.includes("renderAccountTokenTimeline") && server.includes("recordObservedTokenUsage") && server.includes("accountUsageHistory");
checks.reconnect_restores_task_and_uses_bounded_backoff = app.includes("restoreLastThread") && app.includes("codex-web-last-thread") && app.includes("500 * 2 ** state.reconnectCount") && app.includes("navigator.onLine !== false");

const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
if (failed.length) throw new Error(`UI performance regression: ${failed.join(", ")}`);
console.log(`UI_PERFORMANCE_TEST_OK ${Object.keys(checks).join("=true ")}=true`);
