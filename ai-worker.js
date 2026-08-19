/* eslint-disable no-restricted-globals */
// AI worker: runs AI build off the main thread using shared ai-core logic.

importScripts("ai-core.js");

self.onmessage = function (evt) {
  const { jobId, snapshot } = evt.data || {};
  if (!snapshot) {
    self.postMessage({ jobId, ok: false, error: "No snapshot provided" });
    return;
  }
  try {
    const rngSeed = snapshot.rngSeed >>> 0;
    snapshot.rng = AICore.mulberry32(rngSeed);
    const layout = AICore.buildAiLayoutFromSnapshot(snapshot);
    self.postMessage({
      jobId,
      ok: true,
      grid: layout.grid,
      special: layout.special,
      placementOrder: layout.placementOrder,
      profile: { ...(layout.profile || {}), worker: true },
      branchId: layout.branchId,
      branchTotal: layout.branchTotal,
      branch: layout.branch ?? null,
      lookaheadUsed: layout.lookaheadUsed || 0
    });
  } catch (err) {
    self.postMessage({ jobId, ok: false, error: err?.message || String(err) });
  }
};
