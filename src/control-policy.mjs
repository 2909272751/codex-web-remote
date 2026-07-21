export function canAutoYieldToDesktop({
  activeTurnCount = 0,
  submissionCount = 0,
  queuedCount = 0,
  pendingRequestCount = 0,
} = {}) {
  return [activeTurnCount, submissionCount, queuedCount, pendingRequestCount]
    .every((value) => Number(value || 0) === 0);
}
