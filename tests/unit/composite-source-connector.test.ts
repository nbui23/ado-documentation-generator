import { describe, expect, it, vi } from "vitest";
import { CompositeSourceConnector } from "../../src/ingest/composite-source-connector.js";
import type { SourceConnector } from "../../src/domain/ports.js";
import type { SourceDeltaBatch } from "../../src/domain/types.js";

function connector(batch: SourceDeltaBatch): SourceConnector {
  return {
    validateAccess: vi.fn().mockResolvedValue(undefined),
    discoverDefaultBranch: vi.fn().mockResolvedValue({ name: "main", objectId: "head" }),
    fetchDelta: vi.fn().mockResolvedValue(batch),
  };
}

describe("CompositeSourceConnector", () => {
  it("partitions checkpoints, merges provider state, and enriches known Jira references", async () => {
    const azure = connector({
      snapshots: [
        {
          sourceRef: "commit:abc",
          revision: "abc",
          sourceType: "commit",
          locator: "abc",
          pinnedUrl: "https://example.test/abc",
          redactedContent: "implements old-1 and UNKNOWN-2",
          contentHash: "old-hash",
          traceMetadata: { changedPaths: ["/src/a.ts"] },
        },
      ],
      tombstones: [],
      candidateCheckpoint: {
        defaultBranchSha: "head",
        entities: { "commit:abc": "abc:old-hash" },
      },
      repository: { id: "repo", name: "repo", defaultBranch: "main", headRevision: "head" },
    });
    const jira = connector({
      snapshots: [],
      tombstones: [],
      candidateCheckpoint: {
        watermark: "now",
        entities: { "work-item:jira:OLD-1": "r:h" },
      },
    });
    const composite = new CompositeSourceConnector(azure, jira);
    const result = await composite.fetchDelta(
      {
        defaultBranchSha: "legacy",
        entities: { "/old.ts": "r:h", "work-item:jira:OLD-1": "r:h" },
      },
      false,
    );

    expect(vi.mocked(azure.fetchDelta).mock.calls[0]?.[0]).toMatchObject({
      defaultBranchSha: "legacy",
      entities: { "/old.ts": "r:h" },
    });
    expect(vi.mocked(jira.fetchDelta).mock.calls[0]?.[0]).toEqual({
      entities: { "work-item:jira:OLD-1": "r:h" },
    });
    expect(result.snapshots[0]?.traceMetadata?.workItemIds).toEqual(["jira:OLD-1"]);
    expect(result.snapshots[0]?.contentHash).toBe("old-hash");
    expect(result.candidateCheckpoint).toMatchObject({
      azureDevOps: { defaultBranchSha: "head" },
      jira: { watermark: "now" },
      entities: {
        "work-item:jira:OLD-1": "r:h",
      },
    });
    expect((result.candidateCheckpoint.entities as Record<string, string>)["commit:abc"]).toContain(
      "abc:",
    );
    expect((result.candidateCheckpoint.entities as Record<string, string>)["commit:abc"]).toBe(
      "abc:old-hash",
    );

    await composite.fetchDelta(result.candidateCheckpoint, false);
    expect(vi.mocked(azure.fetchDelta).mock.calls[1]?.[0]).toEqual({
      defaultBranchSha: "head",
      entities: { "commit:abc": "abc:old-hash" },
    });
  });

  it("validates both providers and delegates branch discovery to Azure DevOps", async () => {
    const empty = { snapshots: [], tombstones: [], candidateCheckpoint: { entities: {} } };
    const azure = connector(empty);
    const jira = connector(empty);
    const composite = new CompositeSourceConnector(azure, jira);
    await composite.validateAccess();
    await expect(composite.discoverDefaultBranch()).resolves.toEqual({
      name: "main",
      objectId: "head",
    });
    expect(azure.validateAccess).toHaveBeenCalled();
    expect(jira.validateAccess).toHaveBeenCalled();
    expect(azure.discoverDefaultBranch).toHaveBeenCalled();
    expect(jira.discoverDefaultBranch).not.toHaveBeenCalled();
  });
});
