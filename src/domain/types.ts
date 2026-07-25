export type EvidenceClass =
  "code" | "test" | "work_item" | "pull_request" | "commit" | "existing_document";

export type EvidenceLens = "intent" | "implementation" | "history" | "prior_documentation";

export interface SourceSnapshotInput {
  readonly sourceRef: string;
  readonly revision: string;
  readonly sourceType: EvidenceClass;
  readonly locator: string;
  readonly pinnedUrl: string;
  readonly redactedContent: string;
  readonly contentHash: string;
  readonly traceMetadata?: {
    readonly workItemIds?: readonly string[];
    readonly commitIds?: readonly string[];
    readonly changedPaths?: readonly string[];
  };
}

export interface SourceTombstone {
  readonly sourceRef: string;
  readonly revision: string;
  readonly reason: "deleted" | "renamed";
  readonly replacementRef?: string;
}

export interface SourceDeltaBatch {
  readonly snapshots: readonly SourceSnapshotInput[];
  readonly tombstones: readonly SourceTombstone[];
  readonly candidateCheckpoint: Record<string, unknown>;
  readonly repository?: {
    readonly id: string;
    readonly name: string;
    readonly defaultBranch: string;
    readonly headRevision: string;
  };
}

export interface EvidenceRef {
  readonly id: string;
  readonly sourceRef: string;
  readonly revision: string;
  readonly sourceType: EvidenceClass;
  readonly locator: string;
  readonly pinnedUrl: string;
  readonly excerptHash: string;
}

export interface TraceEndpoint {
  readonly type: "work_item" | "pull_request" | "commit" | "file";
  readonly id: string;
}

export interface TraceEdge {
  readonly kind: "work_item_pr" | "pr_commit" | "commit_file";
  readonly from: TraceEndpoint;
  readonly to: TraceEndpoint;
  readonly supportingEvidenceIds: readonly string[];
}

export interface SupportingQuote {
  readonly evidenceId: string;
  readonly locator: string;
  readonly quote: string;
}

export interface ClaimDraft {
  readonly text: string;
  readonly claimKind: "fact" | "conflict" | "limitation";
  readonly evidenceLens: EvidenceLens;
  readonly evidenceIds: readonly string[];
  readonly supportingQuotes: readonly SupportingQuote[];
}

export interface SectionDefinition {
  readonly key: string;
  readonly outputPath: string;
  readonly allowedEvidenceClasses: readonly EvidenceClass[];
  readonly invalidationRules: readonly InvalidationRule[];
}

export type ChangeClass = "code" | "manifest" | "config" | "test" | "work_item" | "history" | "gap";

export interface InvalidationRule {
  readonly changeClass: ChangeClass;
  readonly pathGlobs?: readonly string[];
}

export interface ImpactPlan {
  readonly changedSources: readonly string[];
  readonly impactedTraceNodes: readonly string[];
  readonly affectedSections: readonly string[];
  readonly untouchedSections: readonly string[];
}

export interface PublicationState {
  readonly pullRequestId?: number;
  readonly pullRequestStatus?: "active" | "completed" | "abandoned";
  readonly lifecycleBranch?: string;
  readonly targetHead?: string;
  readonly generatorFileHashes: Readonly<Record<string, string>>;
  readonly pendingConflicts: readonly string[];
}
