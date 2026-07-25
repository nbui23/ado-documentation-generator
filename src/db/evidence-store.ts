import type { Kysely } from "kysely";
import type { EvidenceStore } from "../domain/ports.js";
import type { SourceSnapshotInput, SourceTombstone, TraceEdge } from "../domain/types.js";
import type { Database } from "./types.js";
import { fragmentEvidence } from "../evidence/fragments.js";

export class PostgresEvidenceStore implements EvidenceStore {
  public constructor(private readonly db: Kysely<Database>) {}

  public async upsertRepositoryProjection(
    repository: NonNullable<import("../domain/types.js").SourceDeltaBatch["repository"]>,
  ): Promise<void> {
    const current = await this.db
      .selectFrom("repository_projection")
      .select(["name", "default_branch", "head_revision"])
      .where("id", "=", repository.id)
      .executeTakeFirst();
    if (
      current?.name === repository.name &&
      current.default_branch === repository.defaultBranch &&
      current.head_revision === repository.headRevision
    ) {
      return;
    }
    await this.db
      .insertInto("repository_projection")
      .values({
        id: repository.id,
        name: repository.name,
        default_branch: repository.defaultBranch,
        head_revision: repository.headRevision,
      })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet({
          name: repository.name,
          default_branch: repository.defaultBranch,
          head_revision: repository.headRevision,
          updated_at: new Date(),
        }),
      )
      .execute();
  }

  public async appendSnapshots(
    snapshots: readonly SourceSnapshotInput[],
  ): Promise<readonly string[]> {
    if (snapshots.length === 0) return [];
    return this.db.transaction().execute(async (transaction) => {
      const uniqueSnapshots = new Map<string, SourceSnapshotInput>();
      for (const snapshot of snapshots) uniqueSnapshots.set(snapshotKey(snapshot), snapshot);
      const snapshotIds = new Map<string, string>();
      for (const chunk of chunked([...uniqueSnapshots.values()], 200)) {
        const rows = await transaction
          .insertInto("source_snapshot")
          .values(chunk.map(snapshotRow))
          .onConflict((conflict) =>
            conflict.columns(["source_ref", "revision", "locator", "content_hash"]).doUpdateSet({
              source_ref: (expression) => expression.ref("excluded.source_ref"),
            }),
          )
          .returning(["id", "source_ref", "revision", "locator", "content_hash"])
          .execute();
        for (const row of rows) {
          snapshotIds.set(
            snapshotKey({
              sourceRef: row.source_ref,
              revision: row.revision,
              locator: row.locator,
              contentHash: row.content_hash,
            }),
            row.id,
          );
        }
      }
      if (snapshotIds.size !== uniqueSnapshots.size) {
        throw new Error("Failed to resolve every persisted source snapshot");
      }
      const fragmentRows: Array<{
        id: string;
        snapshot_id: string;
        locator: string;
        redacted_text: string;
        excerpt_hash: string;
        embedding: null;
        embedding_version: null;
      }> = [];
      const projectionRows = new Map<
        string,
        {
          entity_type: string;
          entity_id: string;
          revision: string;
          snapshot_id: string;
          data: {
            sourceRef: string;
            sourceType: SourceSnapshotInput["sourceType"];
            locator: string;
            pinnedUrl: string;
            contentHash: string;
            redactedContent: string;
            traceMetadata: SourceSnapshotInput["traceMetadata"] | null;
          };
        }
      >();
      for (const snapshot of uniqueSnapshots.values()) {
        const snapshotId = snapshotIds.get(snapshotKey(snapshot));
        if (!snapshotId) throw new Error("Persisted source snapshot is missing its identifier");
        const fragments = fragmentEvidence(snapshot);
        if (fragments.length > 0) {
          fragmentRows.push(
            ...fragments.map((fragment) => ({
              id: fragment.id,
              snapshot_id: snapshotId,
              locator: fragment.locator,
              redacted_text: fragment.text,
              excerpt_hash: fragment.excerptHash,
              embedding: null,
              embedding_version: null,
            })),
          );
        }
      }
      for (const snapshot of snapshots) {
        const snapshotId = snapshotIds.get(snapshotKey(snapshot));
        if (!snapshotId) throw new Error("Persisted source snapshot is missing its identifier");
        const projection = projectionIdentity(snapshot);
        projectionRows.set(`${projection.type}\0${projection.id}`, {
          entity_type: projection.type,
          entity_id: projection.id,
          revision: snapshot.revision,
          snapshot_id: snapshotId,
          data: {
            sourceRef: snapshot.sourceRef,
            sourceType: snapshot.sourceType,
            locator: snapshot.locator,
            pinnedUrl: snapshot.pinnedUrl,
            contentHash: snapshot.contentHash,
            redactedContent: snapshot.redactedContent,
            traceMetadata: snapshot.traceMetadata ?? null,
          },
        });
      }
      for (const chunk of chunked(fragmentRows, 200)) {
        await transaction
          .insertInto("evidence_fragment")
          .values(chunk)
          .onConflict((conflict) => conflict.column("id").doNothing())
          .execute();
      }
      for (const chunk of chunked([...projectionRows.values()], 200)) {
        await transaction
          .insertInto("projection")
          .values(chunk)
          .onConflict((conflict) =>
            conflict.columns(["entity_type", "entity_id"]).doUpdateSet({
              revision: (expression) => expression.ref("excluded.revision"),
              snapshot_id: (expression) => expression.ref("excluded.snapshot_id"),
              data: (expression) => expression.ref("excluded.data"),
              updated_at: new Date(),
            }),
          )
          .execute();
      }
      return snapshots.map((snapshot) => {
        const id = snapshotIds.get(snapshotKey(snapshot));
        if (!id) throw new Error("Persisted source snapshot is missing its identifier");
        return id;
      });
    });
  }

  public async replaceTraceProjection(
    edges: readonly TraceEdge[],
    touchedNodeIds: readonly string[],
    replaceAll: boolean,
  ): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      if (replaceAll) {
        await transaction.deleteFrom("trace_edge").execute();
      } else if (touchedNodeIds.length > 0) {
        await transaction
          .deleteFrom("trace_edge")
          .where((expression) =>
            expression.or([
              expression("from_id", "in", touchedNodeIds),
              expression("to_id", "in", touchedNodeIds),
            ]),
          )
          .execute();
      }
      if (edges.length === 0) return;
      await transaction
        .insertInto("trace_edge")
        .values(
          edges.map((edge) => ({
            kind: edge.kind,
            from_type: edge.from.type,
            from_id: edge.from.id,
            to_type: edge.to.type,
            to_id: edge.to.id,
            supporting_evidence_ids: edge.supportingEvidenceIds,
          })),
        )
        .onConflict((conflict) =>
          conflict.columns(["kind", "from_type", "from_id", "to_type", "to_id"]).doUpdateSet({
            supporting_evidence_ids: (expression) =>
              expression.ref("excluded.supporting_evidence_ids"),
          }),
        )
        .execute();
    });
  }

  public async appendTombstones(tombstones: readonly SourceTombstone[]): Promise<void> {
    if (tombstones.length === 0) return;
    await this.db.transaction().execute(async (transaction) => {
      await transaction
        .insertInto("tombstone")
        .values(
          tombstones.map((tombstone) => ({
            source_ref: tombstone.sourceRef,
            revision: tombstone.revision,
            reason: tombstone.reason,
            replacement_ref: tombstone.replacementRef ?? null,
          })),
        )
        .onConflict((conflict) => conflict.columns(["source_ref", "revision"]).doNothing())
        .execute();
      for (const tombstone of tombstones) {
        const projection = projectionIdentityFromRef(tombstone.sourceRef);
        await transaction
          .deleteFrom("projection")
          .where("entity_type", "=", projection.type)
          .where("entity_id", "=", projection.id)
          .execute();
      }
    });
  }
}

function projectionIdentity(snapshot: SourceSnapshotInput): { type: string; id: string } {
  if (snapshot.sourceType === "work_item") {
    return { type: "work_item", id: snapshot.sourceRef.replace(/^work-item:/, "") };
  }
  if (snapshot.sourceType === "pull_request") {
    return { type: "pull_request", id: snapshot.sourceRef.replace(/^pull-request:/, "") };
  }
  if (snapshot.sourceType === "commit") {
    return { type: "commit", id: snapshot.sourceRef.replace(/^commit:/, "") };
  }
  return { type: "file", id: snapshot.sourceRef };
}

function snapshotRow(snapshot: SourceSnapshotInput) {
  return {
    source_ref: snapshot.sourceRef,
    revision: snapshot.revision,
    source_type: snapshot.sourceType,
    locator: snapshot.locator,
    pinned_url: snapshot.pinnedUrl,
    redacted_content: snapshot.redactedContent,
    content_hash: snapshot.contentHash,
    trace_metadata: snapshot.traceMetadata
      ? {
          workItemIds: snapshot.traceMetadata.workItemIds,
          commitIds: snapshot.traceMetadata.commitIds,
          changedPaths: snapshot.traceMetadata.changedPaths,
        }
      : null,
  };
}

function snapshotKey(
  snapshot: Pick<SourceSnapshotInput, "sourceRef" | "revision" | "locator" | "contentHash">,
): string {
  return JSON.stringify([
    snapshot.sourceRef,
    snapshot.revision,
    snapshot.locator,
    snapshot.contentHash,
  ]);
}

function projectionIdentityFromRef(sourceRef: string): { type: string; id: string } {
  if (sourceRef.startsWith("work-item:")) {
    return { type: "work_item", id: sourceRef.slice("work-item:".length) };
  }
  if (sourceRef.startsWith("pull-request:")) {
    return { type: "pull_request", id: sourceRef.slice("pull-request:".length) };
  }
  if (sourceRef.startsWith("commit:")) {
    return { type: "commit", id: sourceRef.slice("commit:".length) };
  }
  return { type: "file", id: sourceRef };
}

function chunked<T>(items: readonly T[], size: number): readonly T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
