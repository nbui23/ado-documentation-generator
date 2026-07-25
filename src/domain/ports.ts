import type {
  ClaimDraft,
  EvidenceRef,
  PublicationState,
  SourceDeltaBatch,
  SourceSnapshotInput,
  SourceTombstone,
  TraceEdge,
} from "./types.js";

export interface SourceConnector {
  validateAccess(): Promise<void>;
  discoverDefaultBranch(): Promise<{ name: string; objectId: string }>;
  fetchDelta(checkpoint: Record<string, unknown> | null, full: boolean): Promise<SourceDeltaBatch>;
}

export interface EvidenceStore {
  upsertRepositoryProjection(
    repository: NonNullable<SourceDeltaBatch["repository"]>,
  ): Promise<void>;
  appendSnapshots(snapshots: readonly SourceSnapshotInput[]): Promise<readonly string[]>;
  appendTombstones(tombstones: readonly SourceTombstone[]): Promise<void>;
  replaceTraceProjection(
    edges: readonly TraceEdge[],
    touchedNodeIds: readonly string[],
    replaceAll: boolean,
  ): Promise<void>;
}

export interface EvidenceRetriever {
  buildPack(
    sectionKey: string,
    traceNodeIds: readonly string[],
    options?: { readonly rank?: boolean },
  ): Promise<readonly EvidenceRef[]>;
}

export interface ClaimGenerator {
  generate(sectionKey: string, evidence: readonly EvidenceRef[]): Promise<readonly ClaimDraft[]>;
  verify(
    claims: readonly ClaimDraft[],
    evidence: readonly EvidenceRef[],
  ): Promise<readonly ClaimDraft[]>;
}

export interface MarkdownRenderer {
  render(
    sectionKey: string,
    claims: readonly ClaimDraft[],
    evidence: readonly EvidenceRef[],
  ): string;
}

export interface Publisher {
  probe(): Promise<void>;
  publish(
    files: Readonly<Record<string, string>>,
    priorState: PublicationState | null,
  ): Promise<PublicationState>;
}
