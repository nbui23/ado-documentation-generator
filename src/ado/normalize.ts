import type { SourceSnapshotInput, TraceEdge } from "../domain/types.js";

export function normalizeTraceSnapshots(
  snapshots: readonly SourceSnapshotInput[],
  snapshotIds: readonly string[],
): readonly TraceEdge[] {
  const edges: TraceEdge[] = [];
  snapshots.forEach((snapshot, index) => {
    const evidenceId = snapshotIds[index];
    if (!evidenceId) return;
    if (snapshot.sourceType === "pull_request") {
      const prId = snapshot.sourceRef.replace(/^pull-request:/, "");
      for (const workItemId of snapshot.traceMetadata?.workItemIds ?? []) {
        edges.push({
          kind: "work_item_pr",
          from: { type: "work_item", id: String(workItemId) },
          to: { type: "pull_request", id: prId },
          supportingEvidenceIds: [evidenceId],
        });
      }
      for (const commitId of snapshot.traceMetadata?.commitIds ?? []) {
        edges.push({
          kind: "pr_commit",
          from: { type: "pull_request", id: prId },
          to: { type: "commit", id: commitId },
          supportingEvidenceIds: [evidenceId],
        });
      }
    }
    if (snapshot.sourceType === "commit") {
      const commitId = snapshot.sourceRef.replace(/^commit:/, "");
      for (const path of snapshot.traceMetadata?.changedPaths ?? []) {
        edges.push({
          kind: "commit_file",
          from: { type: "commit", id: commitId },
          to: { type: "file", id: path },
          supportingEvidenceIds: [evidenceId],
        });
      }
    }
  });
  return edges;
}
