import { describe, expect, it, vi } from "vitest";
import { runPipeline, type PipelineDependencies } from "../../src/app/pipeline.js";
import type { SourceSnapshotInput } from "../../src/domain/types.js";

const snapshot: SourceSnapshotInput = {
  sourceRef: "src/a.ts",
  revision: "abc",
  sourceType: "code",
  locator: "src/a.ts",
  pinnedUrl: "https://dev.azure.com/o/p/_git/r?path=a&version=GCabc",
  redactedContent: "export const value = 1",
  contentHash: "hash",
};

function dependencies(affectedSections: readonly string[]): PipelineDependencies {
  const evidence = [
    {
      id: "ev",
      sourceRef: snapshot.sourceRef,
      revision: snapshot.revision,
      sourceType: snapshot.sourceType,
      locator: snapshot.locator,
      pinnedUrl: snapshot.pinnedUrl,
      excerptHash: snapshot.contentHash,
    },
  ];
  return {
    source: {
      validateAccess: vi.fn(() => Promise.resolve()),
      discoverDefaultBranch: vi.fn(() => Promise.resolve({ name: "main", objectId: "abc" })),
      fetchDelta: vi.fn(() =>
        Promise.resolve({
          snapshots: [snapshot],
          tombstones: [],
          candidateCheckpoint: { defaultBranchSha: "abc" },
        }),
      ),
    },
    store: {
      upsertRepositoryProjection: vi.fn(() => Promise.resolve()),
      appendSnapshots: vi.fn(() => Promise.resolve(["ev"])),
      appendTombstones: vi.fn(() => Promise.resolve()),
      replaceTraceProjection: vi.fn(() => Promise.resolve()),
    },
    retriever: {
      buildPack: vi.fn(() => Promise.resolve(evidence)),
    },
    generator: {
      generate: vi.fn(() => Promise.resolve([])),
      verify: vi.fn(() => Promise.resolve([])),
    },
    renderer: {
      render: vi.fn(() => "# Overview\n"),
    },
    publisher: {
      probe: vi.fn(() => Promise.resolve()),
      publish: vi.fn(() =>
        Promise.resolve({
          pullRequestId: 1,
          pullRequestStatus: "active" as const,
          lifecycleBranch: "refs/heads/docs",
          targetHead: "abc",
          generatorFileHashes: {},
          pendingConflicts: [],
        }),
      ),
    },
    normalizeTrace: vi.fn(() => Promise.resolve([])),
    planImpact: vi.fn(() =>
      Promise.resolve({
        changedSources: [snapshot.sourceRef],
        impactedTraceNodes: [],
        affectedSections,
        untouchedSections: [],
      }),
    ),
    loadPublicationState: vi.fn(() => Promise.resolve(null)),
    fingerprintSection: vi.fn(() => "fingerprint"),
    loadRenderFingerprint: vi.fn(() => Promise.resolve(null)),
    loadGapState: vi.fn(() => Promise.resolve({})),
    saveGapState: vi.fn(() => Promise.resolve()),
    publicationPath: vi.fn((sectionKey: string) => sectionKey),
    loadPendingPublicationFiles: vi.fn((rendered) => Promise.resolve(rendered)),
    stagePublication: vi.fn(() => Promise.resolve()),
    saveCheckpoint: vi.fn(() => Promise.resolve()),
    saveRender: vi.fn(() => Promise.resolve()),
  };
}

describe("pipeline integration", () => {
  it("runs stages and checkpoints a dry run without publication", async () => {
    const deps = dependencies(["developer/overview"]);
    const result = await runPipeline(deps, { full: true, publish: false, checkpoint: null });
    expect(result.rendered).toEqual({
      "developer/overview": "# Overview\n",
      gaps: "# Documentation Gaps\n\n## developer/overview\n\n- No claim candidates were generated from the available evidence.\n",
      index:
        "# Generated Documentation\n\n- [Developer documentation](developer/overview.md)\n- [Business documentation](business/overview.md)\n- [Documentation gaps](gaps.md) — review required\n",
    });
    expect(deps.source.validateAccess).toHaveBeenCalledOnce();
    expect(deps.publisher?.probe).not.toHaveBeenCalled();
    expect(deps.saveCheckpoint).toHaveBeenCalledWith({ defaultBranchSha: "abc" });
    expect(deps.saveRender).toHaveBeenCalledTimes(3);
    expect(deps.saveGapState).toHaveBeenCalledWith({
      "developer/overview": ["No claim candidates were generated from the available evidence."],
    });
  });

  it("performs zero model and publication calls for a no-op", async () => {
    const deps = dependencies([]);
    vi.mocked(deps.source.fetchDelta).mockResolvedValue({
      snapshots: [],
      tombstones: [],
      candidateCheckpoint: { defaultBranchSha: "abc" },
    });
    await runPipeline(deps, {
      full: false,
      publish: true,
      checkpoint: { defaultBranchSha: "abc" },
    });
    expect(deps.generator.generate).not.toHaveBeenCalled();
    expect(deps.publisher?.publish).not.toHaveBeenCalled();
    expect(deps.saveRender).not.toHaveBeenCalled();
    expect(deps.saveGapState).not.toHaveBeenCalled();
    expect(deps.store.replaceTraceProjection).toHaveBeenCalledWith([], [], false);
  });

  it("persists render before attempting publication", async () => {
    const deps = dependencies(["developer/overview"]);
    vi.mocked(deps.publisher!.publish).mockRejectedValueOnce(new Error("network"));
    await expect(runPipeline(deps, { full: false, publish: true, checkpoint: {} })).rejects.toThrow(
      "network",
    );
    expect(deps.saveRender).toHaveBeenCalledBefore(vi.mocked(deps.publisher!.publish));
  });

  it("publishes stored renders left unstaged by an interrupted prior run", async () => {
    const deps = dependencies([]);
    vi.mocked(deps.source.fetchDelta).mockResolvedValue({
      snapshots: [],
      tombstones: [],
      candidateCheckpoint: { defaultBranchSha: "abc" },
    });
    vi.mocked(deps.loadPendingPublicationFiles).mockResolvedValue({
      "developer/overview.md": "# Stored render\n",
    });

    const result = await runPipeline(deps, {
      full: false,
      publish: true,
      checkpoint: { defaultBranchSha: "abc" },
    });

    expect(deps.generator.generate).not.toHaveBeenCalled();
    expect(deps.stagePublication).toHaveBeenCalledWith({
      "developer/overview.md": "# Stored render\n",
    });
    expect(deps.publisher?.publish).toHaveBeenCalledWith(
      { "developer/overview.md": "# Stored render\n" },
      null,
    );
    expect(result.rendered).toEqual({});
    expect(result.publication?.pullRequestStatus).toBe("active");
  });

  it("skips model and render when the section fingerprint is unchanged", async () => {
    const deps = dependencies(["developer/overview"]);
    vi.mocked(deps.loadRenderFingerprint).mockImplementation((sectionKey) =>
      Promise.resolve(
        sectionKey === "developer/overview"
          ? "fingerprint"
          : sectionKey === "gaps"
            ? "gaps:{}"
            : "index:",
      ),
    );
    const result = await runPipeline(deps, { full: false, publish: false, checkpoint: {} });
    expect(result.rendered).toEqual({});
    expect(deps.retriever.buildPack).toHaveBeenCalledOnce();
    expect(deps.retriever.buildPack).toHaveBeenCalledWith("developer/overview", [], {
      rank: false,
    });
    expect(deps.generator.generate).not.toHaveBeenCalled();
    expect(deps.saveRender).not.toHaveBeenCalled();
  });

  it("records unsupported candidates even when other candidates verify", async () => {
    const deps = dependencies(["developer/overview"]);
    const supported = {
      text: "supported",
      claimKind: "fact" as const,
      evidenceLens: "implementation" as const,
      evidenceIds: ["ev"],
      supportingQuotes: [{ evidenceId: "ev", locator: "src/a.ts", quote: "export" }],
    };
    const unsupported = { ...supported, text: "unsupported" };
    vi.mocked(deps.generator.generate).mockResolvedValue([supported, unsupported]);
    vi.mocked(deps.generator.verify).mockResolvedValue([supported]);
    const result = await runPipeline(deps, { full: true, publish: false, checkpoint: null });
    expect(result.gaps).toEqual({ "developer/overview": ["unsupported"] });
  });

  it("renders model-controlled gap text as a non-interactive single-line literal", async () => {
    const deps = dependencies(["developer/overview"]);
    const unsupported = {
      text: "<script>alert(1)</script>\n[review](https://attacker.example/path)",
      claimKind: "fact" as const,
      evidenceLens: "implementation" as const,
      evidenceIds: ["ev"],
      supportingQuotes: [{ evidenceId: "ev", locator: "src/a.ts", quote: "export" }],
    };
    vi.mocked(deps.generator.generate).mockResolvedValue([unsupported]);
    vi.mocked(deps.generator.verify).mockResolvedValue([]);
    const result = await runPipeline(deps, {
      full: false,
      publish: false,
      checkpoint: {},
    });
    expect(result.rendered.gaps).not.toContain("<script>");
    expect(result.rendered.gaps).not.toContain("](https://");
    expect(result.rendered.gaps).not.toContain("\n\\[review");
    expect(result.rendered.gaps).toContain(
      "&lt;script&gt;alert\\(1\\)&lt;/script&gt; \\[review\\]\\(https&#58;//attacker.example/path\\)",
    );
  });

  it("preserves gaps belonging to untouched sections", async () => {
    const deps = dependencies(["developer/overview"]);
    vi.mocked(deps.loadGapState).mockResolvedValue({
      "business/requirements": ["Acceptance criteria are missing."],
    });
    const result = await runPipeline(deps, {
      full: false,
      publish: false,
      checkpoint: {},
    });
    expect(result.gaps).toEqual({
      "business/requirements": ["Acceptance criteria are missing."],
      "developer/overview": ["No claim candidates were generated from the available evidence."],
    });
    expect(deps.saveGapState).toHaveBeenCalledWith(result.gaps);
    expect(result.rendered.gaps).toContain("## business/requirements");
    expect(result.rendered.gaps).toContain("## developer/overview");
  });

  it("replaces a regenerated section's old gaps without touching other sections", async () => {
    const deps = dependencies(["developer/overview"]);
    vi.mocked(deps.loadGapState).mockResolvedValue({
      "business/requirements": ["Still unresolved."],
      "developer/overview": ["Old gap."],
    });
    const supported = {
      text: "supported",
      claimKind: "fact" as const,
      evidenceLens: "implementation" as const,
      evidenceIds: ["ev"],
      supportingQuotes: [{ evidenceId: "ev", locator: "src/a.ts", quote: "export" }],
    };
    vi.mocked(deps.generator.generate).mockResolvedValue([supported]);
    vi.mocked(deps.generator.verify).mockResolvedValue([supported]);
    const result = await runPipeline(deps, {
      full: false,
      publish: false,
      checkpoint: {},
    });
    expect(result.gaps).toEqual({
      "business/requirements": ["Still unresolved."],
    });
    expect(deps.saveGapState).toHaveBeenCalledWith(result.gaps);
  });

  it("records an explicit gap when a section has no evidence", async () => {
    const deps = dependencies(["developer/overview"]);
    vi.mocked(deps.retriever.buildPack).mockResolvedValue([]);
    const result = await runPipeline(deps, {
      full: true,
      publish: false,
      checkpoint: null,
    });
    expect(result.gaps["developer/overview"]).toEqual([
      "No authorized evidence was available for this section.",
    ]);
  });

  it("records an explicit verification gap when every candidate is rejected", async () => {
    const deps = dependencies(["developer/overview"]);
    const unsupported = {
      text: "unsupported",
      claimKind: "fact" as const,
      evidenceLens: "implementation" as const,
      evidenceIds: ["ev"],
      supportingQuotes: [{ evidenceId: "ev", locator: "src/a.ts", quote: "export" }],
    };
    vi.mocked(deps.generator.generate).mockResolvedValue([unsupported]);
    vi.mocked(deps.generator.verify).mockResolvedValue([]);
    const result = await runPipeline(deps, {
      full: true,
      publish: false,
      checkpoint: null,
    });
    expect(result.gaps["developer/overview"]).toEqual([
      "No claim candidates passed evidence verification.",
      "unsupported",
    ]);
  });

  it("attempts every content section during a full run, including sections with no changes", async () => {
    const deps = dependencies(["developer/overview"]);
    vi.mocked(deps.planImpact).mockResolvedValue({
      changedSources: [snapshot.sourceRef],
      impactedTraceNodes: [],
      affectedSections: ["developer/overview"],
      untouchedSections: ["developer/testing", "gaps", "index"],
    });
    await runPipeline(deps, {
      full: true,
      publish: false,
      checkpoint: null,
    });
    expect(deps.retriever.buildPack).toHaveBeenCalledWith("developer/overview", []);
    expect(deps.retriever.buildPack).toHaveBeenCalledWith("developer/testing", []);
    expect(deps.generator.generate).toHaveBeenCalledTimes(2);
  });

  it("persists new gap state before its section render checkpoint", async () => {
    const deps = dependencies(["developer/overview"]);
    await runPipeline(deps, {
      full: false,
      publish: false,
      checkpoint: {},
    });
    expect(deps.saveGapState).toHaveBeenCalledBefore(vi.mocked(deps.saveRender));
  });

  it("fully replaces trace state when the connector promotes an incremental run to resync", async () => {
    const deps = dependencies([]);
    vi.mocked(deps.source.fetchDelta).mockResolvedValue({
      snapshots: [snapshot],
      tombstones: [],
      candidateCheckpoint: { defaultBranchSha: "abc", fullResync: true },
    });
    await runPipeline(deps, { full: false, publish: false, checkpoint: {} });
    expect(deps.store.replaceTraceProjection).toHaveBeenCalledWith([], ["src/a.ts"], true);
  });
});
