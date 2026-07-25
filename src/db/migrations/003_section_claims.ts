import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("section_claim")
    .addColumn("section_key", "text", (column) => column.notNull())
    .addColumn("claim_index", "integer", (column) => column.notNull())
    .addColumn("claim", "jsonb", (column) => column.notNull())
    .addColumn("run_id", "uuid", (column) => column.notNull().references("run.id"))
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(db.fn("now")))
    .addPrimaryKeyConstraint("section_claim_pk", ["section_key", "claim_index"])
    .execute();
  await db.schema
    .createIndex("section_claim_run_id_idx")
    .on("section_claim")
    .column("run_id")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("section_claim").ifExists().cascade().execute();
}
