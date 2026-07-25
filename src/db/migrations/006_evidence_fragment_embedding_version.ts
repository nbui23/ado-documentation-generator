import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("evidence_fragment").addColumn("embedding_version", "text").execute();
  await db.schema
    .createIndex("projection_snapshot_id_idx")
    .ifNotExists()
    .on("projection")
    .column("snapshot_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("projection_snapshot_id_idx").ifExists().execute();
  await db.schema.alterTable("evidence_fragment").dropColumn("embedding_version").execute();
}
