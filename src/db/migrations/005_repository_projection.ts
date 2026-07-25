import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("repository_projection")
    .addColumn("id", "text", (column) => column.primaryKey())
    .addColumn("name", "text", (column) => column.notNull())
    .addColumn("default_branch", "text", (column) => column.notNull())
    .addColumn("head_revision", "text", (column) => column.notNull())
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(db.fn("now")))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("repository_projection").ifExists().execute();
}
