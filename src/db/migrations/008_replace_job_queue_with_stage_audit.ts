import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("run_stage")
    .addColumn("id", "uuid", (column) => column.primaryKey().defaultTo(db.fn("gen_random_uuid")))
    .addColumn("run_id", "uuid", (column) => column.notNull().references("run.id"))
    .addColumn("stage", "text", (column) => column.notNull())
    .addColumn("detail", "jsonb", (column) => column.notNull())
    .addColumn("created_at", "timestamptz", (column) => column.notNull().defaultTo(db.fn("now")))
    .execute();
  await sql`
    insert into run_stage (id, run_id, stage, detail, created_at)
    select id, run_id, kind, payload, created_at from job
  `.execute(db);
  await db.schema.dropTable("job").execute();
  await db.schema.createIndex("run_stage_run_id_idx").on("run_stage").column("run_id").execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("job")
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
  await sql`
    insert into job (
      id, run_id, kind, status, attempts, payload, last_error_class,
      available_at, created_at, updated_at
    )
    select id, run_id, stage, 'completed', 0, detail, null, created_at, created_at, created_at
    from run_stage
  `.execute(db);
  await db.schema.dropTable("run_stage").execute();
  await db.schema.createIndex("job_run_id_idx").on("job").column("run_id").execute();
}
