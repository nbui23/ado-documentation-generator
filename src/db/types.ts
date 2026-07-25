import type { ColumnType, Generated, Insertable, JSONColumnType, Selectable } from "kysely";

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface RunTable {
  id: Generated<string>;
  status: "running" | "failed" | "succeeded";
  stage: string;
  full_run: boolean;
  publish_requested: boolean;
  detail: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  created_at: Generated<Timestamp>;
  completed_at: Timestamp | null;
}

export interface SourceSnapshotTable {
  id: Generated<string>;
  source_ref: string;
  revision: string;
  source_type: string;
  locator: string;
  pinned_url: string;
  redacted_content: string;
  content_hash: string;
  trace_metadata: JSONColumnType<
    Record<string, unknown> | null,
    Record<string, unknown> | null,
    Record<string, unknown> | null
  >;
  created_at: Generated<Timestamp>;
}

export interface TombstoneTable {
  id: Generated<string>;
  source_ref: string;
  revision: string;
  reason: "deleted" | "renamed";
  replacement_ref: string | null;
  created_at: Generated<Timestamp>;
}

export interface ProjectionTable {
  entity_type: string;
  entity_id: string;
  revision: string;
  snapshot_id: string;
  data: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  updated_at: Generated<Timestamp>;
}

export interface RepositoryProjectionTable {
  id: string;
  name: string;
  default_branch: string;
  head_revision: string;
  updated_at: Generated<Timestamp>;
}

export interface TraceEdgeTable {
  id: Generated<string>;
  kind: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  supporting_evidence_ids: JSONColumnType<readonly string[], readonly string[], readonly string[]>;
  created_at: Generated<Timestamp>;
}

export interface EvidenceFragmentTable {
  id: string;
  snapshot_id: string;
  locator: string;
  redacted_text: string;
  excerpt_hash: string;
  embedding: string | null;
  embedding_version: string | null;
  created_at: Generated<Timestamp>;
}

export interface CheckpointTable {
  name: string;
  value: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  updated_at: Generated<Timestamp>;
}

export interface CheckpointEntityTable {
  source_ref: string;
  value: string;
}

export interface SectionRenderTable {
  section_key: string;
  fingerprint: string;
  content: string;
  evidence_ids: JSONColumnType<readonly string[], readonly string[], readonly string[]>;
  run_id: string;
  rendered_at: Generated<Timestamp>;
}

export interface SectionClaimTable {
  section_key: string;
  claim_index: number;
  claim: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  run_id: string;
  created_at: Generated<Timestamp>;
}

export interface RunStageTable {
  id: Generated<string>;
  run_id: string;
  stage: string;
  detail: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  created_at: Generated<Timestamp>;
}

export interface OutboxTable {
  id: Generated<string>;
  run_id: string;
  kind: string;
  payload: JSONColumnType<
    Record<string, unknown>,
    Record<string, unknown>,
    Record<string, unknown>
  >;
  delivered_at: Timestamp | null;
  created_at: Generated<Timestamp>;
}

export interface PublicationStateTable {
  id: string;
  target_branch: string;
  state: JSONColumnType<Record<string, unknown>, Record<string, unknown>, Record<string, unknown>>;
  updated_at: Generated<Timestamp>;
}

export interface Database {
  run: RunTable;
  source_snapshot: SourceSnapshotTable;
  tombstone: TombstoneTable;
  projection: ProjectionTable;
  repository_projection: RepositoryProjectionTable;
  trace_edge: TraceEdgeTable;
  evidence_fragment: EvidenceFragmentTable;
  checkpoint: CheckpointTable;
  checkpoint_entity: CheckpointEntityTable;
  section_render: SectionRenderTable;
  section_claim: SectionClaimTable;
  run_stage: RunStageTable;
  outbox: OutboxTable;
  publication_state: PublicationStateTable;
}

export type SourceSnapshotRow = Selectable<SourceSnapshotTable>;
export type NewSourceSnapshot = Insertable<SourceSnapshotTable>;
