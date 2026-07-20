import assert from "node:assert/strict";
import { buildServerRequestResponse } from "../src/server-request.mjs";

assert.deepEqual(buildServerRequestResponse({ method: "item/commandExecution/requestApproval", params: {} }, { decision: "accept" }), { decision: "accept" });
assert.deepEqual(
  buildServerRequestResponse({ method: "item/commandExecution/requestApproval", params: { proposedExecpolicyAmendment: ["git", "status"] } }, { decision: "always" }),
  { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["git", "status"] } } },
);
assert.deepEqual(
  buildServerRequestResponse({ method: "item/tool/requestUserInput", params: { questions: [{ id: "mode", header: "模式" }, { id: "note", header: "备注" }] } }, { answers: { mode: "安全", note: ["继续"] } }),
  { answers: { mode: { answers: ["安全"] }, note: { answers: ["继续"] } } },
);
assert.deepEqual(
  buildServerRequestResponse({ method: "item/permissions/requestApproval", params: { permissions: { network: { enabled: true } } } }, { decision: "acceptForSession" }),
  { permissions: { network: { enabled: true } }, scope: "session", strictAutoReview: null },
);
assert.deepEqual(
  buildServerRequestResponse(
    {
      method: "mcpServer/elicitation/request",
      params: {
        mode: "form",
        requestedSchema: {
          type: "object",
          required: ["count"],
          properties: {
            count: { type: "integer" },
            enabled: { type: "boolean" },
            color: { enum: ["red", "blue"] },
          },
        },
      },
    },
    { action: "accept", content: { count: "3", enabled: "true", color: "blue" } },
  ),
  { action: "accept", content: { count: 3, enabled: true, color: "blue" } },
);
assert.throws(() => buildServerRequestResponse({ method: "item/tool/requestUserInput", params: { questions: [{ id: "q", header: "问题" }] } }, { answers: {} }), /请回答/);

console.log("SERVER_REQUEST_TEST_OK");
