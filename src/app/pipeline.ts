import type {
  ClaimGenerator,
  EvidenceRetriever,
  EvidenceStore,
  MarkdownRenderer,
  Publisher,
  SourceConnector,
} from "../domain/ports.js";
import type {
  ImpactPlan,
  PublicationState,
  SourceSnapshotInput,
  TraceEdge,
} from "../domain/types.js";

export interface PipelineDependencies {
  readonly source: SourceConnector;
  readonly store: EvidenceStore;
  readonly retriever: EvidenceRetriever;
  readonly generator: ClaimGenerator;
  readonly renderer: MarkdownRenderer;
  readonly publisher?: Publisher;
  readonly normalizeTrace: (
    snapshots: readonly SourceSnapshotInput[],
    snapshotIds: readonly string[],
  ) => Promise<readonly TraceEdge[]>;
  readonly planImpact: (changedSourceRefs: readonly string[]) => Promise<ImpactPlan>;
  readonly loadPublicationState: () => Promise<PublicationState | null>;
  readonly fingerprintSection: (
    sectionKey: string,
    evidence: readonly import("../domain/types.js").EvidenceRef[],
  ) => string;
  readonly loadRenderFingerprint: (sectionKey: string) => Promise<string | null>;
  readonly loadGapState: () => Promise<Readonly<Record<string, readonly string[]>>>;
  readonly saveGapState: (gaps: Readonly<Record<string, readonly string[]>>) => Promise<void>;
  readonly recordStage?: (
    stage: string,
    detail: Readonly<Record<string, unknown>>,
  ) => Promise<void>;
  readonly publicationPath: (sectionKey: string) => string;
  readonly loadPendingPublicationFiles: (
    rendered: Readonly<Record<string, string>>,
  ) => Promise<Readonly<Record<string, string>>>;
  readonly stagePublication: (files: Readonly<Record<string, string>>) => Promise<void>;
  readonly saveCheckpoint: (checkpoint: Record<string, unknown>) => Promise<void>;
  readonly saveRender: (
    sectionKey: string,
    content: string,
    fingerprint: string,
    evidenceIds: readonly string[],
    claims: readonly import("../domain/types.js").ClaimDraft[],
  ) => Promise<void>;
}

export interface PipelineResult {
  readonly rendered: Readonly<Record<string, string>>;
  readonly gaps: Readonly<Record<string, readonly string[]>>;
  readonly publication?: PublicationState;
  readonly audit: {
    readonly changedSources: readonly string[];
    readonly impactedTraceNodes: readonly string[];
    readonly affectedSections: readonly string[];
    readonly untouchedSections: readonly string[];
    readonly evidenceCount: number;
    readonly modelVerificationCount: number;
  };
}

export async function runPipeline(
  dependencies: PipelineDependencies,
  options: { full: boolean; publish: boolean; checkpoint: Record<string, unknown> | null },
): Promise<PipelineResult> {
  await dependencies.recordStage?.("validate", {});
  await dependencies.source.validateAccess();
  if (options.publish) {
    if (!dependencies.publisher) throw new Error("Publication requested without a publisher");
    await dependencies.publisher.probe();
  }
  await dependencies.source.discoverDefaultBranch();
  await dependencies.recordStage?.("ingest", { full: options.full });
  const delta = await dependencies.source.fetchDelta(options.checkpoint, options.full);
  if (delta.repository) {
    await dependencies.store.upsertRepositoryProjection(delta.repository);
  }
  const snapshotIds = await dependencies.store.appendSnapshots(delta.snapshots);
  await dependencies.store.appendTombstones(delta.tombstones);
  await dependencies.recordStage?.("normalize/trace", {
    snapshotCount: delta.snapshots.length,
    tombstoneCount: delta.tombstones.length,
    jiraSnapshotCount: delta.snapshots.filter((snapshot) =>
      snapshot.sourceRef.startsWith("work-item:jira:"),
    ).length,
    jiraTombstoneCount: delta.tombstones.filter((tombstone) =>
      tombstone.sourceRef.startsWith("work-item:jira:"),
    ).length,
  });
  const edges = await dependencies.normalizeTrace(delta.snapshots, snapshotIds);
  const replaceAll = options.full || delta.candidateCheckpoint.fullResync === true;
  const touchedNodeIds = [
    ...delta.snapshots
      .filter(
        (snapshot) =>
          replaceAll || snapshot.sourceType === "pull_request" || snapshot.sourceType === "commit",
      )
      .map((snapshot) => snapshot.sourceRef),
    ...delta.tombstones.map((tombstone) => tombstone.sourceRef),
  ].map((sourceRef) => sourceRef.replace(/^(work-item|pull-request|commit):/, ""));
  await dependencies.store.replaceTraceProjection(edges, touchedNodeIds, replaceAll);
  const impact = await dependencies.planImpact([
    ...delta.snapshots.map((snapshot) => snapshot.sourceRef),
    ...delta.tombstones.map((tombstone) => tombstone.sourceRef),
  ]);
  await dependencies.recordStage?.("impact", {
    changedSources: impact.changedSources,
    impactedTraceNodes: impact.impactedTraceNodes,
    affectedSections: impact.affectedSections,
    untouchedSections: impact.untouchedSections,
  });
  const rendered: Record<string, string> = {};
  const previousGaps = await dependencies.loadGapState();
  const gaps: Record<string, readonly string[]> = { ...previousGaps };
  let gapStateChanged = false;
  const retrievedEvidenceIds = new Set<string>();
  let modelVerificationCount = 0;
  const affectedSectionKeys = (
    options.full
      ? [...impact.affectedSections, ...impact.untouchedSections]
      : impact.affectedSections
  ).filter((sectionKey) => sectionKey !== "gaps" && sectionKey !== "index");
  for (const sectionKey of [...new Set(affectedSectionKeys)].sort()) {
    const fingerprintEvidence = await dependencies.retriever.buildPack(
      sectionKey,
      impact.impactedTraceNodes,
      { rank: false },
    );
    const fingerprint = dependencies.fingerprintSection(sectionKey, fingerprintEvidence);
    if ((await dependencies.loadRenderFingerprint(sectionKey)) === fingerprint) continue;
    const evidence = await dependencies.retriever.buildPack(sectionKey, impact.impactedTraceNodes);
    for (const item of evidence) retrievedEvidenceIds.add(item.id);
    const candidates = await dependencies.generator.generate(sectionKey, evidence);
    const verified = await dependencies.generator.verify(candidates, evidence);
    modelVerificationCount += 1;
    const verifiedKeys = new Set(verified.map(claimKey));
    const unsupported = candidates.filter((claim) => !verifiedKeys.has(claimKey(claim)));
    const sectionGaps = missingOutputGaps(
      evidence.length,
      candidates.length,
      verified.length,
      unsupported,
    );
    const sectionGapStateChanged = !sameStrings(gaps[sectionKey] ?? [], sectionGaps);
    if (sectionGapStateChanged) gapStateChanged = true;
    if (sectionGaps.length > 0) gaps[sectionKey] = sectionGaps;
    else delete gaps[sectionKey];
    const content = dependencies.renderer.render(sectionKey, verified, evidence);
    // Persist gap state before the render fingerprint. If render persistence then fails,
    // retrying cannot skip the section while retaining stale gap state.
    if (sectionGapStateChanged) await dependencies.saveGapState(gaps);
    await dependencies.saveRender(
      sectionKey,
      content,
      fingerprint,
      evidence.map((item) => item.id),
      verified,
    );
    rendered[dependencies.publicationPath(sectionKey)] = content;
  }
  if (affectedSectionKeys.length > 0 || gapStateChanged) {
    const gapContent = renderGaps(gaps);
    const gapFingerprint = gapStateFingerprint(gaps);
    if ((await dependencies.loadRenderFingerprint("gaps")) !== gapFingerprint) {
      await dependencies.saveRender("gaps", gapContent, gapFingerprint, [], []);
      rendered[dependencies.publicationPath("gaps")] = gapContent;
    }
    const indexContent = renderIndex(Object.keys(gaps).length > 0);
    const indexFingerprint = `index:${Object.keys(gaps).sort().join(",")}`;
    if ((await dependencies.loadRenderFingerprint("index")) !== indexFingerprint) {
      await dependencies.saveRender("index", indexContent, indexFingerprint, [], []);
      rendered[dependencies.publicationPath("index")] = indexContent;
    }
  }
  await dependencies.recordStage?.("render", {
    renderedSections: Object.keys(rendered),
    evidenceCount: retrievedEvidenceIds.size,
    gapSectionCount: Object.keys(gaps).length,
  });
  await dependencies.saveCheckpoint(delta.candidateCheckpoint);
  const audit = {
    changedSources: impact.changedSources,
    impactedTraceNodes: impact.impactedTraceNodes,
    affectedSections: [...new Set(affectedSectionKeys)].sort(),
    untouchedSections: impact.untouchedSections,
    evidenceCount: retrievedEvidenceIds.size,
    modelVerificationCount,
  };
  const publicationFiles = options.publish
    ? await dependencies.loadPendingPublicationFiles(rendered)
    : {};
  if (options.publish && Object.keys(publicationFiles).length > 0) {
    await dependencies.recordStage?.("publish", {
      fileCount: Object.keys(publicationFiles).length,
    });
    await dependencies.stagePublication(publicationFiles);
    const publisher = dependencies.publisher;
    if (!publisher) throw new Error("Publication requested without a publisher");
    const publication = await publisher.publish(
      publicationFiles,
      await dependencies.loadPublicationState(),
    );
    return { rendered, gaps, publication, audit };
  }
  return { rendered, gaps, audit };
}

function gapStateFingerprint(gaps: Readonly<Record<string, readonly string[]>>): string {
  return `gaps:${JSON.stringify(
    Object.fromEntries(
      Object.keys(gaps)
        .sort()
        .map((section) => [section, gaps[section]]),
    ),
  )}`;
}

function claimKey(claim: import("../domain/types.js").ClaimDraft): string {
  return JSON.stringify(claim);
}

function missingOutputGaps(
  evidenceCount: number,
  candidateCount: number,
  verifiedCount: number,
  unsupported: readonly import("../domain/types.js").ClaimDraft[],
): readonly string[] {
  if (evidenceCount === 0) {
    return ["No authorized evidence was available for this section."];
  }
  if (candidateCount === 0) {
    return ["No claim candidates were generated from the available evidence."];
  }
  const gaps = unsupported.map((claim) => claim.text);
  if (verifiedCount === 0) {
    return ["No claim candidates passed evidence verification.", ...gaps];
  }
  return gaps;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function renderGaps(gaps: Readonly<Record<string, readonly string[]>>): string {
  const lines = ["# Documentation Gaps", ""];
  for (const section of Object.keys(gaps).sort()) {
    lines.push(`## ${markdownLiteral(section)}`, "");
    for (const gap of gaps[section] ?? []) lines.push(`- ${markdownLiteral(gap)}`);
    lines.push("");
  }
  if (Object.keys(gaps).length === 0) lines.push("_No unsupported claim candidates._", "");
  return lines.join("\n");
}

function markdownLiteral(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_[\]{}()#+!|])/g, "\\$1")
    .replace(/\b(https?)\s*:\s*\/\//gi, "$1&#58;//");
}

function renderIndex(hasGaps: boolean): string {
  return [
    "# Generated Documentation",
    "",
    "- [Developer documentation](developer/overview.md)",
    "- [Business documentation](business/overview.md)",
    `- [Documentation gaps](gaps.md)${hasGaps ? " — review required" : ""}`,
    "",
  ].join("\n");
}
