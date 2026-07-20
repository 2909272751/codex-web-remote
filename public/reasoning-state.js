function flatten(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(flatten).filter(Boolean).join("\n\n");
  if (typeof value === "object") return flatten(value.text ?? value.summary ?? value.content);
  return "";
}

function indexedParts(value) {
  if (!value) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.map(flatten);
}

export function createReasoningState(item = {}) {
  return {
    status: item.status || "inProgress",
    summary: indexedParts(item.summary),
    content: indexedParts(item.content),
  };
}

export function ensureReasoningPart(state, channel, index) {
  const target = channel === "content" ? state.content : state.summary;
  const safeIndex = Math.max(0, Number.isFinite(Number(index)) ? Number(index) : target.length);
  while (target.length <= safeIndex) target.push("");
  return state;
}

export function appendReasoningDelta(state, channel, index, delta) {
  ensureReasoningPart(state, channel, index);
  const target = channel === "content" ? state.content : state.summary;
  const safeIndex = Math.max(0, Number.isFinite(Number(index)) ? Number(index) : target.length - 1);
  target[safeIndex] += String(delta || "");
  return state;
}

export function mergeCompletedReasoning(state, item = {}) {
  const completed = createReasoningState(item);
  state.status = item.status || "completed";
  if (completed.summary.some(Boolean)) state.summary = completed.summary;
  if (completed.content.some(Boolean)) state.content = completed.content;
  return state;
}

export function visibleReasoningText(state = {}) {
  const summary = (state.summary || []).filter(Boolean).join("\n\n").trim();
  if (summary) return summary;
  return (state.content || []).filter(Boolean).join("\n\n").trim();
}

export function reasoningTextFromItem(item = {}) {
  return visibleReasoningText(createReasoningState(item));
}
