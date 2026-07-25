import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createIndex("source_snapshot_source_ref_idx")
    .ifNotExists()
    .on("source_snapshot")
    .column("source_ref")
    .execute();
  await db.schema
    .createIndex("tombstone_source_ref_idx")
    .ifNotExists()
    .on("tombstone")
    .column("source_ref")
    .execute();
  await db.schema
    .createIndex("evidence_fragment_snapshot_id_idx")
    .ifNotExists()
    .on("evidence_fragment")
    .column("snapshot_id")
    .execute();
  await db.schema
    .createIndex("trace_edge_from_id_idx")
    .ifNotExists()
    .on("trace_edge")
    .column("from_id")
    .execute();
  await db.schema
    .createIndex("trace_edge_to_id_idx")
    .ifNotExists()
    .on("trace_edge")
    .column("to_id")
    .execute();
  await db.schema.createIndex("job_run_id_idx").ifNotExists().on("job").column("run_id").execute();
  await db.schema
    .createIndex("outbox_delivery_idx")
    .ifNotExists()
    .on("outbox")
    .columns(["kind", "delivered_at", "created_at"])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const index of [
    "outbox_delivery_idx",
    "job_run_id_idx",
    "trace_edge_to_id_idx",
    "trace_edge_from_id_idx",
    "evidence_fragment_snapshot_id_idx",
    "tombstone_source_ref_idx",
    "source_snapshot_source_ref_idx",
  ]) {
    await db.schema.dropIndex(index).ifExists().execute();
  }
}
