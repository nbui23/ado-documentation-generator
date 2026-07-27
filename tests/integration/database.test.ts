import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { createDatabase } from "../../src/db/database.js";
import { PostgresEvidenceStore } from "../../src/db/evidence-store.js";
import { PostgresEvidenceRetriever } from "../../src/db/evidence-retriever.js";
import { migrateToLatest } from "../../src/db/migrate.js";
import type { Database } from "../../src/db/types.js";
import {
  loadPendingPublication,
  markPublicationDelivered,
  stagePublication,
} from "../../src/db/publication-outbox.js";
import { loadIngestCheckpoint, saveIngestCheckpoint } from "../../src/db/checkpoint.js";

const configuredDatabaseUrl = process.env.DATABASE_URL;
const useTestcontainers = process.env.EDGAR_TESTCONTAINERS === "true";
const databaseSuite = configuredDatabaseUrl || useTestcontainers ? describe : describe.skip;

databaseSuite("PostgreSQL persistence", () => {
  let database: Kysely<Database>;
  let container: StartedTestContainer | undefined;

  beforeAll(async () => {
    let databaseUrl = configuredDatabaseUrl;
    if (!databaseUrl) {
      container = await new GenericContainer(
        "pgvector/pgvector:0.8.2-pg18@sha256:42e7f6b4e1eceb02ff14e3e6bc6108bbe259abbe83879dc1845d0da1ddeb555d",
      )
        .withEnvironment({
          POSTGRES_USER: "edgar",
          POSTGRES_PASSWORD: "integration-only-password",
          POSTGRES_DB: "edgar",
        })
        .withExposedPorts(5432)
        .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
        .start();
      databaseUrl = `postgresql://edgar:integration-only-password@${container.getHost()}:${String(container.getMappedPort(5432))}/edgar`;
    }
    database = createDatabase(databaseUrl);
    await migrateToLatest(database);
  }, 120_000);

  afterAll(async () => {
    await database?.destroy();
    await container?.stop();
  });

  it("migrates pgvector and idempotently stores immutable evidence", async () => {
    const extension = await sql<{ extname: string }>`
      select extname from pg_extension where extname = 'vector'
    `.execute(database);
    expect(extension.rows[0]?.extname).toBe("vector");

    const uniqueRef = `file:integration-${randomUUID()}.ts`;
    const snapshot = {
      sourceRef: uniqueRef,
      revision: "abc123",
      sourceType: "code" as const,
      locator: "src/integration.ts:L1-L1",
      pinnedUrl:
        "https://dev.azure.com/example/project/_git/repo?path=src/integration.ts&version=GCabc123",
      redactedContent: "export const integration = true;",
      contentHash: randomUUID().replaceAll("-", ""),
    };
    const store = new PostgresEvidenceStore(database);
    await store.upsertRepositoryProjection({
      id: "integration-repository",
      name: "integration",
      defaultBranch: "main",
      headRevision: snapshot.revision,
    });
    const [firstId, duplicateId] = await store.appendSnapshots([snapshot, snapshot]);
    const [secondId] = await store.appendSnapshots([snapshot]);

    expect(duplicateId).toBe(firstId);
    expect(secondId).toBe(firstId);
    const count = await database
      .selectFrom("source_snapshot")
      .select((expression) => expression.fn.countAll<number>().as("count"))
      .where("source_ref", "=", uniqueRef)
      .executeTakeFirstOrThrow();
    expect(Number(count.count)).toBe(1);
    const projection = await database
      .selectFrom("projection")
      .select(["entity_type", "entity_id", "revision", "snapshot_id"])
      .where("entity_type", "=", "file")
      .where("entity_id", "=", uniqueRef)
      .executeTakeFirstOrThrow();
    expect(projection).toMatchObject({
      entity_type: "file",
      entity_id: uniqueRef,
      revision: snapshot.revision,
      snapshot_id: firstId,
    });
    expect(
      await database
        .selectFrom("repository_projection")
        .selectAll()
        .where("id", "=", "integration-repository")
        .executeTakeFirst(),
    ).toMatchObject({
      name: "integration",
      default_branch: "main",
      head_revision: snapshot.revision,
    });
  });

  it("records completed pipeline stages without a speculative queue schema", async () => {
    const run = await database
      .insertInto("run")
      .values({
        status: "running",
        stage: "validate",
        full_run: false,
        publish_requested: false,
        detail: {},
        completed_at: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();

    await database
      .insertInto("run_stage")
      .values({ run_id: run.id, stage: "validate", detail: { checked: true } })
      .execute();

    expect(
      await database
        .selectFrom("run_stage")
        .select(["stage", "detail"])
        .where("run_id", "=", run.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ stage: "validate", detail: { checked: true } });
    const legacyTable = await sql<{ name: string | null }>`
      select to_regclass('public.job')::text as name
    `.execute(database);
    expect(legacyTable.rows[0]?.name).toBeNull();
  });

  it("retains tombstoned audit snapshots while excluding them from future evidence packs", async () => {
    const uniqueRef = `src/deleted-${randomUUID()}.ts`;
    const snapshot = {
      sourceRef: uniqueRef,
      revision: "deleted-revision",
      sourceType: "code" as const,
      locator: `${uniqueRef}:L1`,
      pinnedUrl: `https://dev.azure.com/example/project/_git/repo?path=${encodeURIComponent(uniqueRef)}&version=GCdeleted`,
      redactedContent: "export const deletedEvidence = true;",
      contentHash: randomUUID().replaceAll("-", ""),
    };
    const store = new PostgresEvidenceStore(database);
    await store.appendSnapshots([snapshot]);
    const retriever = new PostgresEvidenceRetriever(database);

    expect(await retriever.buildPack("developer/overview", [uniqueRef])).not.toHaveLength(0);
    await store.appendTombstones([
      {
        sourceRef: uniqueRef,
        revision: "deletion-revision",
        reason: "deleted",
      },
    ]);

    expect(await retriever.buildPack("developer/overview", [uniqueRef])).toEqual([]);
    const retained = await database
      .selectFrom("source_snapshot")
      .select("id")
      .where("source_ref", "=", uniqueRef)
      .executeTakeFirst();
    expect(retained).toBeTruthy();
  });

  it("persists fragment embeddings and ranks an authorized pack with pgvector", async () => {
    const prefix = randomUUID();
    const snapshots = [
      {
        sourceRef: `src/${prefix}-primary.ts`,
        revision: "1",
        sourceType: "code" as const,
        locator: "L1",
        pinnedUrl: "https://dev.azure.com/example/project/_git/repo?path=primary&version=GC1",
        redactedContent: "primary evidence",
        contentHash: `${prefix}a`.replaceAll("-", ""),
      },
      {
        sourceRef: `src/${prefix}-secondary.ts`,
        revision: "1",
        sourceType: "code" as const,
        locator: "L1",
        pinnedUrl: "https://dev.azure.com/example/project/_git/repo?path=secondary&version=GC1",
        redactedContent: "secondary evidence",
        contentHash: `${prefix}b`.replaceAll("-", ""),
      },
    ];
    await new PostgresEvidenceStore(database).appendSnapshots(snapshots);
    const embedder = vi.fn((inputs: readonly string[]) =>
      Promise.resolve(
        inputs.map((input) => {
          const vector = Array.from({ length: 1536 }, () => 0);
          vector[input.includes("secondary") ? 1 : 0] = 1;
          return vector;
        }),
      ),
    );
    const retriever = new PostgresEvidenceRetriever(database, 80, embedder, "deployment-a");

    const fingerprintEvidence = await retriever.buildPack(
      "developer/overview",
      snapshots.map((snapshot) => snapshot.sourceRef),
      { rank: false },
    );
    expect(fingerprintEvidence).toHaveLength(2);
    expect(embedder).not.toHaveBeenCalled();
    const first = await retriever.buildPack(
      "developer/overview",
      snapshots.map((snapshot) => snapshot.sourceRef),
    );
    const second = await retriever.buildPack(
      "developer/overview",
      snapshots.map((snapshot) => snapshot.sourceRef),
    );

    expect(first[0]?.sourceRef).toBe(snapshots[0]?.sourceRef);
    expect(second[0]?.sourceRef).toBe(snapshots[0]?.sourceRef);
    expect(embedder.mock.calls.map(([inputs]) => inputs.length)).toEqual([1, 2, 1]);
  });

  it("re-embeds stale cached fragments and ranks beyond the old pre-limit window", async () => {
    const prefix = randomUUID();
    const snapshots = Array.from({ length: 12 }, (_, index) => ({
      sourceRef: `src/${prefix}-${String(index + 1).padStart(2, "0")}.ts`,
      revision: "1",
      sourceType: "code" as const,
      locator: "L1",
      pinnedUrl: `https://dev.azure.com/example/project/_git/repo?path=${index + 1}&version=GC1`,
      redactedContent:
        index >= 10 ? `match section ${index + 1}` : `background evidence ${index + 1}`,
      contentHash: `${prefix}${index + 1}`.replaceAll("-", ""),
    }));
    await new PostgresEvidenceStore(database).appendSnapshots(snapshots);
    const firstEmbedder = vi.fn((inputs: readonly string[]) =>
      Promise.resolve(
        inputs.map((input) => {
          const vector = Array.from({ length: 1536 }, () => 0);
          vector[input === "developer/overview" || input.includes("match section") ? 0 : 1] = 1;
          return vector;
        }),
      ),
    );
    const secondEmbedder = vi.fn((inputs: readonly string[]) =>
      Promise.resolve(
        inputs.map((input) => {
          const vector = Array.from({ length: 1536 }, () => 0);
          vector[input === "developer/overview" || input.includes("match section") ? 0 : 1] = 1;
          return vector;
        }),
      ),
    );

    const initialRetriever = new PostgresEvidenceRetriever(
      database,
      2,
      firstEmbedder,
      "deployment-a",
    );
    const refreshedRetriever = new PostgresEvidenceRetriever(
      database,
      2,
      secondEmbedder,
      "deployment-b",
      5,
    );

    await initialRetriever.buildPack(
      "developer/overview",
      snapshots.map((snapshot) => snapshot.sourceRef),
    );
    const refreshed = await refreshedRetriever.buildPack(
      "developer/overview",
      snapshots.map((snapshot) => snapshot.sourceRef),
    );

    expect(new Set(refreshed.map((item) => item.sourceRef))).toEqual(
      new Set([snapshots[10]?.sourceRef, snapshots[11]?.sourceRef]),
    );
    expect(secondEmbedder.mock.calls.map(([inputs]) => inputs.length)).toEqual([1, 5, 5, 2]);
    expect(
      await database
        .selectFrom("evidence_fragment")
        .select("embedding_version")
        .where("embedding_version", "=", "deployment-b")
        .execute(),
    ).toHaveLength(12);
  });

  it("recovers a stored publication payload without repeating generation", async () => {
    const run = await database
      .insertInto("run")
      .values({
        status: "failed",
        stage: "publish",
        full_run: false,
        publish_requested: true,
        detail: { errorClass: "NetworkError" },
        completed_at: new Date(),
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    await stagePublication(database, run.id, {
      "developer/overview.md": "# Stored render\n",
    });

    const pending = await loadPendingPublication(database);

    expect(pending).toMatchObject({
      runId: run.id,
      files: { "developer/overview.md": "# Stored render\n" },
    });
    await markPublicationDelivered(database, pending!.id);
    expect(await loadPendingPublication(database)).toBeNull();
  });

  it("stores large ingest entity maps as normalized checkpoint rows", async () => {
    const entities = Object.fromEntries(
      Array.from({ length: 1_001 }, (_, index) => [
        `src/checkpoint-${String(index).padStart(4, "0")}.ts`,
        `revision-${index}:hash-${index}`,
      ]),
    );
    const legacy = {
      defaultBranchSha: "legacy-head",
      entities: { "src/legacy.ts": "legacy-revision:legacy-hash" },
    };
    await database.deleteFrom("checkpoint_entity").execute();
    await database
      .insertInto("checkpoint")
      .values({ name: "ingest", value: legacy })
      .onConflict((conflict) =>
        conflict.column("name").doUpdateSet({ value: legacy, updated_at: new Date() }),
      )
      .execute();
    expect(await loadIngestCheckpoint(database)).toEqual(legacy);

    await saveIngestCheckpoint(database, {
      defaultBranchSha: "checkpoint-head",
      entities,
    });

    const normalizedCheckpoint = await loadIngestCheckpoint(database);
    expect(normalizedCheckpoint).toMatchObject({
      defaultBranchSha: "checkpoint-head",
      entities,
    });
    expect(typeof normalizedCheckpoint?.entityFingerprint).toBe("string");
    const storedMetadata = await database
      .selectFrom("checkpoint")
      .select("value")
      .where("name", "=", "ingest")
      .executeTakeFirstOrThrow();
    expect(storedMetadata.value).not.toHaveProperty("entities");
    const storedEntityCount = await database
      .selectFrom("checkpoint_entity")
      .select((expression) => expression.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    expect(Number(storedEntityCount.count)).toBe(1_001);
    const firstEntityVersion = await sql<{ xmin: string }>`
      select xmin::text as xmin
      from checkpoint_entity
      where source_ref = 'src/checkpoint-0000.ts'
    `.execute(database);
    const firstChangedEntityVersion = await sql<{ xmin: string }>`
      select xmin::text as xmin
      from checkpoint_entity
      where source_ref = 'src/checkpoint-0001.ts'
    `.execute(database);
    await saveIngestCheckpoint(database, {
      defaultBranchSha: "newer-checkpoint-head",
      entities,
    });
    const secondEntityVersion = await sql<{ xmin: string }>`
      select xmin::text as xmin
      from checkpoint_entity
      where source_ref = 'src/checkpoint-0000.ts'
    `.execute(database);
    expect(secondEntityVersion.rows[0]?.xmin).toBe(firstEntityVersion.rows[0]?.xmin);
    await saveIngestCheckpoint(database, {
      defaultBranchSha: "changed-checkpoint-head",
      entities: {
        ...entities,
        "src/checkpoint-0001.ts": "changed-revision:changed-hash",
      },
    });
    const selectivelyUpdatedEntities = await sql<{
      source_ref: string;
      value: string;
      xmin: string;
    }>`
      select source_ref, value, xmin::text as xmin
      from checkpoint_entity
      where source_ref in ('src/checkpoint-0000.ts', 'src/checkpoint-0001.ts')
      order by source_ref
    `.execute(database);
    expect(selectivelyUpdatedEntities.rows[0]).toEqual({
      source_ref: "src/checkpoint-0000.ts",
      value: entities["src/checkpoint-0000.ts"],
      xmin: firstEntityVersion.rows[0]?.xmin,
    });
    expect(selectivelyUpdatedEntities.rows[1]).toMatchObject({
      source_ref: "src/checkpoint-0001.ts",
      value: "changed-revision:changed-hash",
    });
    expect(selectivelyUpdatedEntities.rows[1]?.xmin).not.toBe(
      firstChangedEntityVersion.rows[0]?.xmin,
    );
  });
});
