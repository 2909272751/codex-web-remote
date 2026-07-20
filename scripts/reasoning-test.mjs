import assert from "node:assert/strict";
import {
  appendReasoningDelta,
  createReasoningState,
  ensureReasoningPart,
  mergeCompletedReasoning,
  reasoningTextFromItem,
  visibleReasoningText,
} from "../public/reasoning-state.js";

const stream = createReasoningState({ status: "inProgress" });
ensureReasoningPart(stream, "summary", 1);
appendReasoningDelta(stream, "summary", 1, "第二段");
appendReasoningDelta(stream, "summary", 0, "第一段");
appendReasoningDelta(stream, "content", 0, "不应覆盖摘要");
assert.equal(visibleReasoningText(stream), "第一段\n\n第二段");

mergeCompletedReasoning(stream, {
  type: "reasoning",
  status: "completed",
  summary: [{ type: "summary_text", text: "正式摘要" }],
  content: [{ type: "reasoning_text", text: "公开推理文本" }],
});
assert.equal(stream.status, "completed");
assert.equal(visibleReasoningText(stream), "正式摘要");
assert.equal(reasoningTextFromItem({ content: [{ text: "仅内容" }] }), "仅内容");
console.log("REASONING_TEST_OK");
