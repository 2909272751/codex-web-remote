import fsp from "node:fs/promises";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const [app, html, css, modern, timeline, server, projectUtils] = await Promise.all([
  fsp.readFile(path.join(root, "public", "app.js"), "utf8"),
  fsp.readFile(path.join(root, "public", "index.html"), "utf8"),
  fsp.readFile(path.join(root, "public", "layout-fix.css"), "utf8"),
  fsp.readFile(path.join(root, "public", "modern-ui.css"), "utf8"),
  fsp.readFile(path.join(root, "public", "timeline.js"), "utf8"),
  fsp.readFile(path.join(root, "server.mjs"), "utf8"),
  fsp.readFile(path.join(root, "public", "project-utils.js"), "utf8"),
]);
const pkg = JSON.parse(await fsp.readFile(path.join(root, "package.json"), "utf8"));

const checks = {
  stream_updates_are_batched: app.includes("requestAnimationFrame(flushStreamUpdates)"),
  streaming_does_not_scan_all_messages: !app.includes('document.querySelectorAll(".message.assistant")'),
  scrolling_is_tail_aware: app.includes("function isNearBottom()") && app.includes("if (!state.followTail)"),
  long_history_is_progressive: app.includes("HISTORY_BATCH_SIZE") && app.includes("renderEarlierHistory"),
  control_events_are_coalesced: app.includes("scheduleControlRefresh(modeChanged)"),
  viewport_updates_are_frame_limited: app.includes("function scheduleViewportSync()"),
  return_to_bottom_control_exists: html.includes('id="newMessagesBtn"'),
  historical_cards_use_bounded_rendering: app.includes('HISTORY_DOM_LIMIT = 120') && app.includes('trimHistoryWindow'),
  reduced_motion_is_supported: css.includes("prefers-reduced-motion:reduce"),
  thread_switch_uses_lru_cache: app.includes("THREAD_VIEW_LIMIT") && app.includes("rememberThreadView"),
  stale_switches_are_aborted: app.includes("new AbortController()") && app.includes('state.threadOpenController?.abort()') && !app.includes('await delay(120, controller.signal)'),
  cached_snapshot_loads_first: app.includes('readThreadView(id)') && app.includes('await Promise.race([restoreView(id)') && app.includes('if (cachedView) applyThreadResult'),
  heavy_timeline_bodies_are_lazy: timeline.includes("function populateBody") && timeline.includes("展开后加载详细内容"),
};

checks.modern_ui_layer_is_loaded = html.includes("/modern-ui.css") && modern.includes("--ui-accent");
checks.web_version_is_runtime_backed = html.includes('id="webVersion"') && app.includes("setWebVersion(session?.version)") && server.includes("version: currentVersion");
checks.manual_update_check_bypasses_cache = html.includes('id="updateCheckBtn"') && app.includes("loadUpdateStatus({ force: true })") && app.includes("?force=1") && server.includes('req.query?.force || ""');
checks.theme_toggle_is_persistent = app.includes("codex-web-theme") && app.includes("document.documentElement.dataset.theme");
checks.modern_ui_supports_reduced_motion = modern.includes("prefers-reduced-motion: reduce");
checks.theme_dialog_text_contrast_is_hardened = modern.includes("Theme contrast hardening") && modern.includes(".toast,") && modern.includes("color: var(--ui-text)") && modern.includes(".interaction-detail") && modern.includes(".usage-card") && modern.includes(".project-dialog");
checks.user_message_contrast_is_explicit = modern.includes("--ui-user-bg") && modern.includes("--ui-user-text") && modern.includes(".message.user { background: var(--ui-user-bg); color: var(--ui-user-text)");
checks.mobile_layout_allocates_space = modern.includes("Mobile adaptive allocation") && modern.includes("max-height: min(58dvh, 430px)") && modern.includes("max-height: min(24dvh, 156px)") && modern.includes("grid-template-columns: auto minmax(0, 1fr) auto") && html.includes(`src="/app.js?v=${pkg.version}`);
checks.login_can_remember_password = html.includes('id="rememberPassword"') && app.includes("REMEMBER_PASSWORD_KEY") && app.includes("restoreRememberedPassword") && app.includes("saveRememberedPassword");
checks.snapshot_sync_is_bounded = app.includes('limit=60') && app.includes("10_000") && server.includes("readReadonlyThreadSingleFlight");
checks.readonly_mode_uses_paged_views = app.includes('/api/v2/threads/${encodeURIComponent(id)}/view?limit=60') && server.includes('async function readableThread') && app.includes('readonly-mode');
checks.thread_list_prefetches_snapshots = app.includes("function prefetchThreadSnapshot") && app.includes('addEventListener("pointerenter", () => prefetchThreadSnapshot(thread))') && app.includes('addEventListener("touchstart", () => prefetchThreadSnapshot(thread)');
checks.readonly_preview_uses_cached_snapshot_first = app.includes('async function previewThread(thread) { return openThread(thread.id); }') && app.includes('let cachedView = readThreadView(id)') && app.includes('if (cachedView) applyThreadResult');
checks.long_history_has_bounded_dom = app.includes("HISTORY_DOM_LIMIT") && app.includes("trimHistoryWindow") && app.includes("renderLaterHistory");
checks.uploads_have_progress_and_recovery = app.includes("XMLHttpRequest") && app.includes("retryUpload") && app.includes("codex-web-draft:") && app.includes("typeof file.size !== \"number\"");
checks.upload_composer_html_is_well_formed = html.includes('<input id="fileInput" type="file" multiple hidden>') && html.includes('id="attachBtn"') && html.includes('class="attach"') && html.includes('id="sendBtn"') && html.includes('type="submit"');
checks.uploads_can_prepare_without_takeover = app.includes("const canAttach = Boolean(state.current || state.pendingThreadId)") && !app.includes("const canAttach = Boolean(state.current && !state.threadSyncing)") && !app.includes('["messageInput", "sendMode", "attachBtn", "sendBtn"');
checks.http_upload_has_safe_client_id = app.includes('createBrowserId("upload")') && app.includes('typeof globalThis.crypto?.randomUUID === "function"') && app.includes('typeof globalThis.crypto?.getRandomValues === "function"') && !app.includes("const clientId = crypto.randomUUID()");
checks.sent_messages_have_local_echo = app.includes("appendLocalUserMessage(localSubmissionText(text, attachments), id, 'sending')") && app.includes('clientMessageId: id') && app.includes("dataset.localUser");
checks.mobile_keyboard_lock_is_explicit = app.includes("function setComposerKeyboardActive") && app.includes('classList.toggle("keyboard-active"') && modern.includes("html.keyboard-active .messages") && modern.includes("overscroll-behavior: contain");
checks.long_command_output_is_collapsed = timeline.includes("function updateOutputOverflow") && timeline.includes("text.length > 6_000") && timeline.includes(".length > 120") && modern.includes(".timeline-code-long");
checks.activity_states_are_distinct = app.includes("phase-${activity.phase") && modern.includes(".activity.phase-thinking") && modern.includes(".activity.phase-commandExecution") && modern.includes(".activity.phase-approval") && modern.includes(".activity.phase-offline");
checks.shared_control_state_is_visible = app.includes("webClientCount") && html.includes('id="controlMeta"') && server.includes("sharedWebControl");
checks.selected_codex_runtime_is_visible = app.includes("c.runtime?.selected") && app.includes("runtime.selected.version") && server.includes("runtime: codex.getRuntimeStatus()");
checks.failed_thread_sync_releases_composer = app.includes("state.threadSyncing = false") && app.includes("同步失败，可重试或继续发送") && !app.includes("state.pendingThreadId = null; state.threadSyncing = true;");
checks.account_token_usage_has_source_boundaries = html.includes('id="usageHourTokens"') && app.includes("renderAccountTokenTimeline") && server.includes("recordObservedTokenUsage") && server.includes("accountUsageHistory");
checks.readonly_usage_uses_last_official_snapshot = app.includes("payload.live === false") && server.includes("accountUsageSnapshot") && !server.includes('app.get("/api/account/usage", requireAuth, requireWebMode');
checks.account_switch_restarts_safely = html.includes('id="switchAccountMenuBtn"') && app.includes("switchAccount") && server.includes('"/api/accounts/activate"') && server.includes("runAccountSwitcher") && !server.includes('app.post("/api/accounts/activate", requireAuth, requireWebMode');
checks.desktop_output_is_incrementally_streamed = server.includes("desktopLive") && server.includes("syncDesktopLiveFile") && app.includes("applyDesktopLiveEvent");
checks.reconnect_restores_task_and_uses_bounded_backoff = app.includes("restoreLastThread") && app.includes("codex-web-last-thread") && app.includes("500 * 2 ** state.reconnectCount") && app.includes("navigator.onLine !== false");
checks.takeover_keeps_the_official_task_name = server.includes("thread.name || thread.thread_name || thread.preview");
checks.readonly_snapshot_revalidates_the_source_session = server.includes("async function snapshotIsFresh") && server.includes("sourceMtimeMs") && server.includes("const cachedIsFresh = await snapshotIsFresh");
checks.stale_desktop_task_markers_do_not_block_takeover = server.includes("desktopActivityFreshMs") && server.includes("desktopLifecycleIsFresh({") && server.includes("only recent lifecycle activity may block takeover");
checks.desktop_reset_title_uses_state_database = server.includes("readAppThreadTitles(codexHomeDir") && server.includes("applyAppThreadTitles") && server.includes("name: row.title, preview: row.title");
checks.thread_titles_are_normalized_for_live_web = server.includes("result.data = await replaceThreadCache(result.data)") && server.includes("name: explicitName || title") && app.includes("function threadTitle(");
checks.reasoning_is_collapsed_by_default = app.includes("box.open = false") && !app.includes("if (working) node.open = true");
checks.reasoning_completion_keeps_the_same_node = app.includes("if (node) updateReasoningNode(node, stream)") && app.includes("state.reasoningStreams.get(id) || createReasoningState(params.item)") && !app.includes("state.reasoningStreams.get(params.item.id) || createReasoningState(params.item); mergeCompletedReasoning");
checks.reasoning_stream_keeps_text_selection = app.includes("function reasoningContentHasSelection");
checks.subagents_are_enumerated_by_parent = server.includes("parentThreadId: req.params.id") && server.includes("spawn.agent_path");
checks.thread_model_settings_survive_readonly = server.includes("reasoningEffort = payload.effort") && server.includes("function threadRuntimePayload(threadId, thread = null)");
checks.completed_internal_desktop_tools_are_hidden = timeline.includes("internalDesktopTool") && timeline.includes('status === "completed" || status === "succeeded"') && timeline.includes("return null") && app.includes("if (!fresh) {") && app.includes("old.remove()");
checks.completed_tool_cards_collapse_on_finish = app.includes("const completed = item.status === 'completed'") && app.includes("if (!completed && old.tagName === 'DETAILS'");
checks.project_catalog_uses_app_projects = server.includes('readAppProjects(codexHomeDir)') && server.includes("codex.request('project/list'") && server.includes('if (appProjects.available) return appProjects.projects');
checks.projects_support_multiple_roots = app.includes('projectMatchesThread') && projectUtils.includes('Array.isArray(project?.roots)') && projectUtils.includes('typeof root === "string"') && projectUtils.includes('root?.path');
checks.web_can_rename_threads = server.includes('thread/name/set') && app.includes('thread-action-menu') && app.includes('✎ 重命名') && app.includes('openThreadActions(thread, actions)');
checks.default_project_opens_recent_tasks = app.includes('ensureDefaultProjectSelection') && app.includes('LAST_OPENED_PROJECT_KEY') && app.includes('mostRecentProjectId') && app.includes('if (projectDefaultApplied && state.selectedProjectId) rememberLastOpenedProject');
checks.thread_list_explains_loading_and_errors = app.includes('正在读取任务…') && app.includes('threadListStatus === "error"') && app.includes('任务列表加载失败');
checks.thread_order_uses_latest_signal = projectUtils.includes('Math.max(') && server.includes('appTimestampMs(thread?.recencyAt)');

const failed = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
if (failed.length) throw new Error(`UI performance regression: ${failed.join(", ")}`);
console.log(`UI_PERFORMANCE_TEST_OK ${Object.keys(checks).join("=true ")}=true`);
