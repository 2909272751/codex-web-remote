import { canAutoYieldToDesktop } from "../src/control-policy.mjs";

if (!canAutoYieldToDesktop()) throw new Error("An idle Web backend should yield to the desktop app");

for (const key of ["activeTurnCount", "submissionCount", "queuedCount", "pendingRequestCount"]) {
  if (canAutoYieldToDesktop({ [key]: 1 })) throw new Error(`Web must not yield while ${key} is non-zero`);
}

console.log("CONTROL_POLICY_TEST_OK idle_yields=true busy_preserved=true");
