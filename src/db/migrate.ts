import { FileMigrationProvider, Migrator } from "kysely/migration";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Kysely } from "kysely";
import type { Database } from "./types.js";

export async function migrateToLatest(db: Kysely<Database>): Promise<void> {
  const migrationFolder = fileURLToPath(new URL("./migrations", import.meta.url));
  const migrator = new Migrator({
    db,
    provider: new FileMigrationProvider({ fs, path, migrationFolder }),
  });
  const { error, results } = await migrator.migrateToLatest();
  for (const result of results ?? []) {
    if (result.status === "Error") throw new Error(`Migration failed: ${result.migrationName}`);
  }
  if (error)
    throw error instanceof Error ? error : new Error("Migration failed with an unknown error");
}
