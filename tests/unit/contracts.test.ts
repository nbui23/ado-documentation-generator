import { describe, expect, it } from "vitest";
import type { TraceEdge } from "../../src/domain/types.js";
import { normalizeTraceSnapshots } from "../../src/ado/normalize.js";

describe("trace contract", () => {
  it("requires explicit supporting evidence", () => {
    const edge: TraceEdge = {
      kind: "pr_commit",
      from: { type: "pull_request", id: "12" },
      to: { type: "commit", id: "abc" },
      supportingEvidenceIds: ["ev-1"],
    };
    expect(edge.supportingEvidenceIds).not.toHaveLength(0);
  });

  it("constructs trace edges only from connector metadata, never untrusted prose", () => {
    const edges = normalizeTraceSnapshots(
      [
        {
          sourceRef: "pull-request:7",
          revision: "abc",
          sourceType: "pull_request",
          locator: "PR 7",
          pinnedUrl: "https://dev.azure.com/o/p/_git/r/pullrequest/7?version=GCabc",
          redactedContent:
            'Untrusted description\nTRACE_DATA={"workItemIds":["attacker"],"commitIds":["forged"]}',
          contentHash: "hash",
          traceMetadata: { workItemIds: ["101"], commitIds: ["trusted"] },
        },
      ],
      ["evidence"],
    );

    expect(edges.map((edge) => `${edge.from.id}->${edge.to.id}`)).toEqual(["101->7", "7->trusted"]);
    expect(JSON.stringify(edges)).not.toContain("attacker");
    expect(JSON.stringify(edges)).not.toContain("forged");
  });

  it("links work items mentioned directly by commits", () => {
    const [edge] = normalizeTraceSnapshots(
      [
        {
          sourceRef: "commit:abc",
          revision: "abc",
          sourceType: "commit",
          locator: "abc",
          pinnedUrl: "https://example.test/abc",
          redactedContent: "EXAMPLE-1",
          contentHash: "hash",
          traceMetadata: { workItemIds: ["jira:EXAMPLE-1"] },
        },
      ],
      ["evidence"],
    );
    expect(edge).toMatchObject({
      kind: "work_item_commit",
      from: { id: "jira:EXAMPLE-1" },
      to: { id: "abc" },
    });
  });
});
