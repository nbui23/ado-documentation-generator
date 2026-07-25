import type { Kysely } from "kysely";
import { createHash } from "node:crypto";
import type { Database } from "./types.js";

const INSERT_BATCH_SIZE = 500;

export async function loadIngestCheckpoint(
  db: Kysely<Database>,
): Promise<Record<string, unknown> | null> {
  const [checkpoint, entityRows] = await Promise.all([
    db.selectFrom("checkpoint").select("value").where("name", "=", "ingest").executeTakeFirst(),
    db.selectFrom("checkpoint_entity").select(["source_ref", "value"]).execute(),
  ]);
  if (!checkpoint) return null;
  const legacyEntities = readEntities(checkpoint.value.entities);
  const entities =
    entityRows.length > 0
      ? Object.fromEntries(entityRows.map((row) => [row.source_ref, row.value]))
      : legacyEntities;
  return { ...checkpoint.value, entities };
}

export async function saveIngestCheckpoint(
  db: Kysely<Database>,
  checkpoint: Record<string, unknown>,
): Promise<void> {
  const entities = readEntities(checkpoint.entities);
  const metadata = { ...checkpoint };
  delete metadata.entities;
  const rows = Object.entries(entities)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([source_ref, value]) => ({ source_ref, value }));
  const entityFingerprint = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  const storedMetadata = { ...metadata, entityFingerprint };
  await db.transaction().execute(async (transaction) => {
    const previous = await transaction
      .selectFrom("checkpoint")
      .select("value")
      .where("name", "=", "ingest")
      .executeTakeFirst();
    if (previous?.value.entityFingerprint !== entityFingerprint) {
      const existingRows = await transaction
        .selectFrom("checkpoint_entity")
        .select(["source_ref", "value"])
        .execute();
      const existing = new Map(existingRows.map((row) => [row.source_ref, row.value]));
      const next = new Map(rows.map((row) => [row.source_ref, row.value]));
      const removed = existingRows
        .filter((row) => !next.has(row.source_ref))
        .map((row) => row.source_ref);
      const changed = rows.filter((row) => existing.get(row.source_ref) !== row.value);
      for (let index = 0; index < removed.length; index += INSERT_BATCH_SIZE) {
        await transaction
          .deleteFrom("checkpoint_entity")
          .where("source_ref", "in", removed.slice(index, index + INSERT_BATCH_SIZE))
          .execute();
      }
      for (let index = 0; index < changed.length; index += INSERT_BATCH_SIZE) {
        await transaction
          .insertInto("checkpoint_entity")
          .values(changed.slice(index, index + INSERT_BATCH_SIZE))
          .onConflict((conflict) =>
            conflict.column("source_ref").doUpdateSet({
              value: (expression) => expression.ref("excluded.value"),
            }),
          )
          .execute();
      }
    }
    await transaction
      .insertInto("checkpoint")
      .values({ name: "ingest", value: storedMetadata })
      .onConflict((conflict) =>
        conflict.column("name").doUpdateSet({ value: storedMetadata, updated_at: new Date() }),
      )
      .execute();
  });
}

function readEntities(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Ingest checkpoint entities must be a string map");
  }
  const entries = Object.entries(value);
  if (entries.some(([, revision]) => typeof revision !== "string")) {
    throw new Error("Ingest checkpoint entities must be a string map");
  }
  return Object.fromEntries(entries);
}
