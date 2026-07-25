import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create extension if not exists vector`.execute(db);
  await sql`create extension if not exists pgcrypto`.execute(db);

  await db.schema
    .createTable("run")
    .ifNotExists()
    .addColumn("id", "uuid", (column) => column.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("stage", "text", (column) => column.notNull())
    .addColumn("full_run", "boolean", (column) => column.notNull())
    .addColumn("publish_requested", "boolean", (column) => column.notNull())
    .addColumn("detail", "jsonb", (column) => column.notNull().defaultTo("{}"))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(db.fn("now")))
    .addColumn("completed_at", "timestamptz")
    .execute();

  await db.schema
    .createTable("source_snapshot")
    .ifNotExists()
    .addColumn("id", "uuid", (column) => column.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("source_ref", "text", (column) => column.notNull())
    .addColumn("revision", "text", (column) => column.notNull())
    .addColumn("source_type", "text", (column) => column.notNull())
    .addColumn("locator", "text", (column) => column.notNull())
    .addColumn("pinned_url", "text", (column) => column.notNull())
    .addColumn("redacted_content", "text", (column) => column.notNull())
    .addColumn("content_hash", "text", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(db.fn("now")))
    .addUniqueConstraint("source_snapshot_identity", [
      "source_ref",
      "revision",
      "locator",
      "content_hash",
    ])
    .execute();

  await db.schema
    .createTable("tombstone")
    .ifNotExists()
    .addColumn("id", "uuid", (column) => column.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("source_ref", "text", (column) => column.notNull())
    .addColumn("revision", "text", (column) => column.notNull())
    .addColumn("reason", "text", (column) => column.notNull())
    .addColumn("replacement_ref", "text")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(db.fn("now")))
    .addUniqueConstraint("tombstone_identity", ["source_ref", "revision"])
    .execute();

  await db.schema
    .createTable("projection")
    .ifNotExists()
    .addColumn("entity_type", "text", (column) => column.notNull())
    .addColumn("entity_id", "text", (column) => column.notNull())
    .addColumn("revision", "text", (column) => column.notNull())
    .addColumn("snapshot_id", "uuid", (column) => column.notNull().references("source_snapshot.id"))
    .addColumn("data", "jsonb", (column) => column.notNull())
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(db.fn("now")))
    .addPrimaryKeyConstraint("projection_pk", ["entity_type", "entity_id"])
    .execute();

  await db.schema
    .createTable("trace_edge")
    .ifNotExists()
    .addColumn("id", "uuid", (column) => column.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("kind", "text", (column) => column.notNull())
    .addColumn("from_type", "text", (column) => column.notNull())
    .addColumn("from_id", "text", (column) => column.notNull())
    .addColumn("to_type", "text", (column) => column.notNull())
    .addColumn("to_id", "text", (column) => column.notNull())
    .addColumn("supporting_evidence_ids", "jsonb", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(db.fn("now")))
    .addUniqueConstraint("trace_edge_identity", [
      "kind",
      "from_type",
      "from_id",
      "to_type",
      "to_id",
    ])
    .execute();

  await db.schema
    .createTable("evidence_fragment")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("snapshot_id", "uuid", (column) => column.notNull().references("source_snapshot.id"))
    .addColumn("locator", "text", (column) => column.notNull())
    .addColumn("redacted_text", "text", (column) => column.notNull())
    .addColumn("excerpt_hash", "text", (column) => column.notNull())
    .addColumn("embedding", sql`vector(1536)`)
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(db.fn("now")))
    .execute();

  await db.schema
    .createTable("checkpoint")
    .ifNotExists()
    .addColumn("name", "text", (column) => column.primaryKey())
    .addColumn("value", "jsonb", (column) => column.notNull())
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(db.fn("now")))
    .execute();

  await db.schema
    .createTable("section_render")
    .ifNotExists()
    .addColumn("section_key", "text", (column) => column.primaryKey())
    .addColumn("fingerprint", "text", (column) => column.notNull())
    .addColumn("content", "text", (column) => column.notNull())
    .addColumn("evidence_ids", "jsonb", (column) => column.notNull())
    .addColumn("run_id", "uuid", (column) => column.notNull().references("run.id"))
    .addColumn("rendered_at", "timestamptz", (column) => column.notNull().defaultTo(db.fn("now")))
    .execute();

  await db.schema
    .createTable("job")
    .ifNotExists()
    .addColumn("id", "uuid", (column) => column.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("run_id", "uuid", (column) => column.notNull().references("run.id"))
    .addColumn("kind", "text", (column) => column.notNull())
    .addColumn("status", "text", (column) => column.notNull())
    .addColumn("attempts", "integer", (column) => column.notNull().defaultTo(0))
    .addColumn("payload", "jsonb", (column) => column.notNull())
    .addColumn("last_error_class", "text")
    .addColumn("available_at", "timestamptz", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(db.fn("now")))
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(db.fn("now")))
    .execute();

  await db.schema
    .createTable("outbox")
    .ifNotExists()
    .addColumn("id", "uuid", (column) => column.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("run_id", "uuid", (column) => column.notNull().references("run.id"))
    .addColumn("kind", "text", (column) => column.notNull())
    .addColumn("payload", "jsonb", (column) => column.notNull())
    .addColumn("delivered_at", "timestamptz")
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(db.fn("now")))
    .execute();

  await db.schema
    .createTable("publication_state")
    .ifNotExists()
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("target_branch", "text", (column) => column.notNull())
    .addColumn("state", "jsonb", (column) => column.notNull())
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(db.fn("now")))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  for (const table of [
    "publication_state",
    "outbox",
    "job",
    "section_render",
    "checkpoint",
    "evidence_fragment",
    "trace_edge",
    "projection",
    "tombstone",
    "source_snapshot",
    "run",
  ]) {
    await db.schema.dropTable(table).ifExists().cascade().execute();
  }
}
