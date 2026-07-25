import type { Kysely } from "kysely";
import type { Database } from "./types.js";

export interface PendingPublication {
  readonly id: string;
  readonly runId: string;
  readonly files: Readonly<Record<string, string>>;
}

export async function stagePublication(
  db: Kysely<Database>,
  runId: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  if (Object.keys(files).length === 0) return;
  await db
    .insertInto("outbox")
    .values({
      run_id: runId,
      kind: "publication",
      payload: { files },
      delivered_at: null,
    })
    .execute();
}

export async function loadPendingPublication(
  db: Kysely<Database>,
): Promise<PendingPublication | null> {
  const row = await db
    .selectFrom("outbox")
    .select(["id", "run_id", "payload"])
    .where("kind", "=", "publication")
    .where("delivered_at", "is", null)
    .orderBy("created_at")
    .executeTakeFirst();
  if (!row) return null;
  const files = row.payload.files;
  if (
    typeof files !== "object" ||
    files === null ||
    Array.isArray(files) ||
    !Object.entries(files).every(
      ([path, content]) =>
        path.length > 0 &&
        !path.startsWith("/") &&
        !path.split(/[\\/]/).includes("..") &&
        typeof content === "string",
    )
  ) {
    throw new Error("Pending publication outbox payload is invalid");
  }
  return {
    id: row.id,
    runId: row.run_id,
    files: files as Record<string, string>,
  };
}

export async function markPublicationDelivered(
  db: Kysely<Database>,
  outboxId: string,
): Promise<void> {
  await db
    .updateTable("outbox")
    .set({ delivered_at: new Date() })
    .where("id", "=", outboxId)
    .where("delivered_at", "is", null)
    .execute();
}
