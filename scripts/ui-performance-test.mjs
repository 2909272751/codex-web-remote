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
checks.web_version_is_runtime_backed = html.includes('id="webVersion"') && app.includes("setWebVersion(session?.version)") && server.includes("mode, version: currentVersion");
checks.theme_toggle_is_persistent = app.includes("codex-web-theme") && app.includes("document.documentElement.dataset.theme");
checks.modern_ui_supports_reduced_motion = modern.includes("prefers-reduced-motion: reduce");
checks.theme_dialog_text_contrast_is_hardened = modern.includes("Theme contrast hardening") && modern.includes(".toast,") && modern.includes("color: var(--ui-text)") && modern.includes(".interaction-detail") && modern.includes(".usage-card") && modern.includes(".project-dialog");
checks.user_message_contrast_is_explicit = modern.includes("--ui-user-bg") && modern.includes("--ui-user-text") && modern.includes(".message.user { background: var(--ui-user-bg); color: var(--ui-user-text)");
checks.mobile_layout_allocates_space = modern.includes("Mobile adaptive allocation") && modern.includes("max-height: min(58dvh, 430px)") && modern.includes("max-height: min(24dvh, 156px)") && modern.includes("grid-template-columns: auto minmax(0, 1fr) auto") && html.includes("1.4.8-stability1");
checks.login_can_remember_password = html.includes('id="rememberPassword"') && app.includes("REMEMBER_PASSWORD_KEY") && app.includes("restoreRememberedPassword") && app.includes("saveRememberedPassword");
checks.snapshot_sync_is_bounded = app.includes("snapshotTimer") && app.includes("10_000") && server.includes("readReadonlyThreadSingleFlight");
checks.readonly_mode_uses_snapshots = app.includes("/api/threads/${encodeURIComponent(thread.id)}/snapshot") && app.includes("readonly-mode");
checks.thread_list_prefetches_snapshots = app.includes("function prefetchThreadSnapshot") && app.includes('addEventListener("pointerenter", () => prefetchThreadSnapshot(thread))') && app.includes('addEventListener("touchstart", () => prefetchThreadSnapshot(thread)');
checks.readonly_preview_uses_cached_snapshot_first = app.includes("const cachedView = readThreadView(thread.id)") && app.includes("cachedView?.result?.thread") && app.includes("rememberThreadView(thread.id, result") && app.includes("toast(error.message); return;");
checks.long_history_has_bounded_dom = app.includes("HISTORY_DOM_LIMIT") && app.includes("trimHistoryWindow") && app.includes("renderLaterHistory");
checks.uploads_have_progress_and_recovery = app.includes("XMLHttpRequest") && app.includes("retryUpload") && app.includes("codex-web-draft:") && app.includes("typeof file.size !== \"number\"");
checks.upload_composer_html_is_well_formed = html.includes('<input id="fileInput" type="file" multiple hidden>') && html.includes('id="attachBtn"') && html.includes('class="attach"') && html.includes('id="sendBtn"') && html.includes('type="submit"');
checks.uploads_can_prepare_without_takeover = app.includes("const canAttach = Boolean(state.current || state.pendingThreadId)") && !app.includes("const canAttach = Boolean(state.current && !state.threadSyncing)") && !app.includes('["messageInput", "sendMode", "attachBtn", "sendBtn"');
checks.http_upload_has_safe_client_id = app.includes('createBrowserId("upload")') && app.includes('typeof globalThis.crypto?.randomUUID === "function"') && app.includes('typeof globalThis.crypto?.getRandomValues === "function"') && !app.includes("const clientId = crypto.randomUUID()");
checks.sent_messages_have_local_echo = app.includes("appendLocalUserMessage(localText") && app.includes("function localSubmissionText") && app.includes("dataset.localUser");
checks.mobile_keyboard_lock_is_explicit = app.includes("function setComposerKeyboardActive") && app.includes('classList.toggle("keyboard-active"') && modern.includes("html.keyboard-active .messages") && modern.includes("overscroll-behavior: contain");
checks.long_command_output_is_collapsed = timeline.includes("function updateOutputOverflow") && timeline.includes("text.length > 6_000") && timeline.includes(".length > 120") && modern.includes(".timeline-code-long");
checks.activity_states_are_distinct = app.includes("phase-${activity.phase") && modern.includes(".activity.phase-thinking") && modern.includes(".activity.phase-commandExecution") && modern.includes(".activity.phase-approval") && modern.includes(".activity.phase-offline");
checks.shared_control_state_is_visible = app.includes("webClientCount") && html.includes('id="controlMeta"') && server.includes("sharedWebControl");
checks.account_token_usage_has_source_boundaries = html.includes('id="usageHourTokens"') && app.includes("renderAccountTokenTimeline") && server.includes("recordObservedTokenUsage") && server.includes("accountUsageHistory");
checks.readonly_usage_uses_last_official_snapshot = app.includes("payload.live === false") && server.includes("accountUsageSnapshot") && !server.includes('app.get("/api/account/usage", requireAuth, requireWebMode');
checks.account_switch_restarts_safely = html.includes('id="switchAccountMenuBtn"') && app.includes("switchAccount") && server.includes('"/api/accounts/activate"') && server.includes("runAccountSwitcher") && !server.includes('app.post("/api/accounts/activate", requireAuth, requireWebMode');
checks.desktop_output_is_incrementally_streamed = server.includes("desktopLive") && server.includes("syncDesktopLiveFile") && app.includes("applyDesktopLiveEvent");
checks.reconnect_restores_task_and_uses_bounded_backoff = app.includes("restoreLastThread") && app.includes("codex-web-last-thread") && app.includes("500 * 2 ** state.reconnectCount") && app.includes("navigator.onLine !== false");

const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
if (failed.length) throw new Error(`UI performance regression: ${failed.join(", ")}`);
console.log(`UI_PERFORMANCE_TEST_OK ${Object.keys(checks).join("=true ")}=true`);
