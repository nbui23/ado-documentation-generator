import { DefaultAzureCredential, getBearerTokenProvider } from "@azure/identity";
import { OpenAI } from "openai";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import type { AgentDocsConfig } from "../config/schema.js";
import { AzureDevOpsClient } from "../ado/client.js";
import { normalizeTraceSnapshots } from "../ado/normalize.js";
import { AzureDevOpsSourceConnector } from "../ado/source-connector.js";
import { acquireRuntimeLock, createDatabase, probeDatabase } from "../db/database.js";
import { PostgresEvidenceRetriever } from "../db/evidence-retriever.js";
import { PostgresEvidenceStore } from "../db/evidence-store.js";
import { loadIngestCheckpoint, saveIngestCheckpoint } from "../db/checkpoint.js";
import type { Database } from "../db/types.js";
import {
  loadPendingPublication,
  markPublicationDelivered,
  stagePublication,
} from "../db/publication-outbox.js";
import { EntraTokenProvider } from "../identity/entra.js";
import { classifySourceChange, computeImpact, sectionFingerprint } from "../incremental/impact.js";
import { SECTION_CATALOG } from "../render/catalog.js";
import { DeterministicMarkdownRenderer } from "../render/renderer.js";
import { AzureOpenAIClaimGenerator } from "../generation/azure-openai.js";
import { VerifiedClaimGenerator } from "../generation/verified-generator.js";
import { hash } from "../evidence/fragments.js";
import { AzureDevOpsPublisher } from "../publication/azure-devops-publisher.js";
import { runPipeline, type PipelineResult } from "./pipeline.js";
import type { Kysely } from "kysely";
import type { PublicationState } from "../domain/types.js";
import { createLogger } from "../observability/logger.js";

const OPENAI_SCOPE = "https://cognitiveservices.azure.com/.default";
const TEMPLATE_VERSION = "2";
const PROMPT_VERSION = "2";
const logger = createLogger();

export function azureOpenAIBaseUrl(endpoint: string): string {
  const url = new URL(endpoint);
  url.pathname = "/openai/v1/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

function providers(
  config: AgentDocsConfig,
  onAdoRetry?: ConstructorParameters<typeof AzureDevOpsClient>[4],
) {
  const credential = new DefaultAzureCredential();
  const ado = new AzureDevOpsClient(
    config.azureDevOps.organization,
    new EntraTokenProvider(credential),
    fetch,
    4,
    onAdoRetry,
  );
  const openai = new OpenAI({
    baseURL: azureOpenAIBaseUrl(config.azureOpenAI.endpoint),
    apiKey: getBearerTokenProvider(credential, OPENAI_SCOPE),
  });
  return { ado, openai };
}

export async function validateRuntime(
  config: AgentDocsConfig,
  options: { probeOpenAI?: boolean } = {},
): Promise<void> {
  const db = createDatabase();
  try {
    await probeDatabase(db);
    const { ado, openai } = providers(config);
    const source = new AzureDevOpsSourceConnector(ado, config);
    await source.validateAccess();
    const branch = await source.discoverDefaultBranch();
    await new AzureDevOpsPublisher(
      ado,
      config.azureDevOps.project,
      config.azureDevOps.repository,
      `refs/heads/${branch.name}`,
      config.documentation.root,
      config.publication.reviewers,
    ).probe();
    if (options.probeOpenAI !== false) {
      const embedding = await openai.embeddings.create({
        model: config.azureOpenAI.embeddingDeployment,
        input: "agent-docs capability probe",
        dimensions: config.azureOpenAI.embeddingDimensions,
      });
      if (embedding.data[0]?.embedding.length !== config.azureOpenAI.embeddingDimensions) {
        throw new Error("Azure OpenAI embedding deployment returned an unexpected dimension");
      }
      const generation = new AzureOpenAIClaimGenerator(
        {
          responses: {
            create: async (input) => {
              const response = await openai.responses.create(input as never);
              return { output_text: response.output_text };
            },
          },
        },
        config.azureOpenAI.generationDeployment,
      );
      await generation.generate("capability-probe", []);
    }
  } finally {
    await db.destroy();
  }
}

export async function executeRuntime(
  config: AgentDocsConfig,
  options: { full: boolean; publish: boolean },
): Promise<{ runId: string; result: PipelineResult }> {
  const runtimeLock = await acquireRuntimeLock();
  try {
    const preflightDb = createDatabase();
    let hasPendingPublication = false;
    try {
      hasPendingPublication =
        options.publish && (await loadPendingPublication(preflightDb)) !== null;
    } finally {
      await preflightDb.destroy();
    }
    await validateRuntime(config, { probeOpenAI: !hasPendingPublication });
  } catch (error) {
    await runtimeLock.release();
    throw error;
  }
  let db: Kysely<Database>;
  try {
    db = createDatabase();
  } catch (error) {
    await runtimeLock.release();
    throw error;
  }
  let run: { id: string };
  try {
    run = await db
      .insertInto("run")
      .values({
        status: "running",
        stage: "validate",
        full_run: options.full,
        publish_requested: options.publish,
        detail: {},
        completed_at: null,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
  } catch (error) {
    await db.destroy();
    await runtimeLock.release();
    throw error;
  }
  logger.info(
    { runId: run.id, full: options.full, publishRequested: options.publish },
    "run started",
  );
  const startedAt = performance.now();
  try {
    const { ado, openai } = providers(config, ({ status, attempt, delayMs }) => {
      logger.warn(
        {
          runId: run.id,
          retryClassification: status === 429 ? "rate_limit" : "server_error",
          status,
          attempt,
          delayMs,
        },
        "Azure DevOps request retry scheduled",
      );
    });
    const source = new AzureDevOpsSourceConnector(ado, config);
    const branch = await source.discoverDefaultBranch();
    const targetBranchRef = `refs/heads/${branch.name}`;
    const store = new PostgresEvidenceStore(db);
    const tokenUsage = { input: 0, output: 0, total: 0 };
    let modelCallCount = 0;
    const retriever = new PostgresEvidenceRetriever(
      db,
      80,
      async (inputs) => {
        const embeddings = await openai.embeddings.create({
          model: config.azureOpenAI.embeddingDeployment,
          input: [...inputs],
          dimensions: config.azureOpenAI.embeddingDimensions,
        });
        modelCallCount += 1;
        accumulateTokenUsage(tokenUsage, embeddings.usage);
        return embeddings.data.map((item) => item.embedding);
      },
      config.azureOpenAI.embeddingDeployment,
    );
    const rawGenerator = new AzureOpenAIClaimGenerator(
      {
        responses: {
          create: async (input) => {
            const response = await openai.responses.create(input as never);
            modelCallCount += 1;
            accumulateTokenUsage(tokenUsage, response.usage);
            return { output_text: response.output_text };
          },
        },
      },
      config.azureOpenAI.generationDeployment,
    );
    const generator = new VerifiedClaimGenerator(rawGenerator);
    const renderer = new DeterministicMarkdownRenderer();
    const publisher = new AzureDevOpsPublisher(
      ado,
      config.azureDevOps.project,
      config.azureDevOps.repository,
      targetBranchRef,
      config.documentation.root,
      config.publication.reviewers,
    );
    if (options.publish) {
      const pending = await loadPendingPublication(db);
      if (pending) {
        await publisher.probe();
        const publicationFiles = {
          ...pending.files,
          ...(await loadUnpublishedRenderFiles(db)),
        };
        const publication = await publisher.publish(
          publicationFiles,
          await loadPublicationState(db),
        );
        await materializeStoredRenders(db, config.documentation.root);
        await db.transaction().execute(async (transaction) => {
          await savePublicationState(transaction, publication, targetBranchRef);
          await markPublicationDelivered(transaction, pending.id);
          await transaction
            .insertInto("run_stage")
            .values({
              run_id: run.id,
              stage: "publish-retry",
              detail: { fileCount: Object.keys(publicationFiles).length },
            })
            .execute();
          await transaction
            .updateTable("run")
            .set({
              status: "succeeded",
              stage: "publish-retry",
              detail: { retriedStoredRender: true, publication },
              completed_at: new Date(),
            })
            .where("id", "=", run.id)
            .execute();
        });
        logger.info(
          {
            runId: run.id,
            stage: "publish-retry",
            publicationStatus: publication.pullRequestStatus,
            durationMs: Math.round(performance.now() - startedAt),
          },
          "run completed",
        );
        return {
          runId: run.id,
          result: {
            rendered: publicationFiles,
            gaps: {},
            publication,
            audit: {
              changedSources: [],
              impactedTraceNodes: [],
              affectedSections: Object.keys(publicationFiles),
              untouchedSections: [],
              evidenceCount: 0,
              modelVerificationCount: 0,
            },
          },
        };
      }
    }
    const checkpoint = await loadIngestCheckpoint(db);
    const configFingerprint = hash(JSON.stringify(config));
    const configChanged = checkpoint !== null && checkpoint.configFingerprint !== configFingerprint;
    const result = await runPipeline(
      {
        source,
        store,
        retriever,
        generator,
        renderer,
        publisher,
        normalizeTrace: (snapshots, ids) =>
          Promise.resolve(normalizeTraceSnapshots(snapshots, ids)),
        planImpact: (changedSources) =>
          Promise.resolve(
            computeImpact(
              changedSources.map(classifySourceChange),
              changedSources.map((sourceRef) =>
                sourceRef.replace(/^(work-item|pull-request|commit):/, ""),
              ),
              SECTION_CATALOG,
            ),
          ),
        loadPublicationState: () => loadPublicationState(db),
        fingerprintSection: (sectionKey, evidence) =>
          sectionFingerprint({
            evidenceRevisions: evidence.map(
              (item) => `${item.id}:${item.revision}:${item.excerptHash}`,
            ),
            configVersion: `${configFingerprint}:${sectionKey}`,
            templateVersion: TEMPLATE_VERSION,
            promptVersion: PROMPT_VERSION,
            generationDeployment: config.azureOpenAI.generationDeployment,
            embeddingDeployment: config.azureOpenAI.embeddingDeployment,
          }),
        loadRenderFingerprint: async (sectionKey) => {
          const row = await db
            .selectFrom("section_render")
            .select("fingerprint")
            .where("section_key", "=", sectionKey)
            .executeTakeFirst();
          return row?.fingerprint ?? null;
        },
        loadGapState: async () => {
          const row = await db
            .selectFrom("checkpoint")
            .select("value")
            .where("name", "=", "gap-state")
            .executeTakeFirst();
          return readGapState(row?.value);
        },
        saveGapState: async (gaps) => {
          const value = Object.fromEntries(
            Object.entries(gaps).map(([section, messages]) => [section, [...messages]]),
          );
          await db
            .insertInto("checkpoint")
            .values({ name: "gap-state", value })
            .onConflict((conflict) =>
              conflict.column("name").doUpdateSet({ value, updated_at: new Date() }),
            )
            .execute();
        },
        recordStage: async (stage, detail) => {
          await db.transaction().execute(async (transaction) => {
            await transaction.updateTable("run").set({ stage }).where("id", "=", run.id).execute();
            await transaction
              .insertInto("run_stage")
              .values({
                run_id: run.id,
                stage,
                detail: { ...detail },
              })
              .execute();
          });
          logger.info({ runId: run.id, stage, ...stageLogDetail(detail) }, "stage completed");
        },
        publicationPath: (sectionKey) => {
          const definition = SECTION_CATALOG.find((section) => section.key === sectionKey);
          if (!definition) throw new Error(`Unknown section: ${sectionKey}`);
          return definition.outputPath;
        },
        loadPendingPublicationFiles: async (rendered) => ({
          ...(await loadUnpublishedRenderFiles(db)),
          ...rendered,
        }),
        stagePublication: async (files) => {
          await stagePublication(db, run.id, files);
        },
        saveCheckpoint: async (value) => {
          await saveIngestCheckpoint(db, { ...value, configFingerprint });
        },
        saveRender: async (sectionKey, content, fingerprint, evidenceIds, claims) => {
          await db.transaction().execute(async (transaction) => {
            await transaction
              .insertInto("section_render")
              .values({
                section_key: sectionKey,
                fingerprint,
                content,
                evidence_ids: evidenceIds,
                run_id: run.id,
              })
              .onConflict((conflict) =>
                conflict.column("section_key").doUpdateSet({
                  content,
                  fingerprint,
                  evidence_ids: evidenceIds,
                  run_id: run.id,
                  rendered_at: new Date(),
                }),
              )
              .execute();
            await transaction
              .deleteFrom("section_claim")
              .where("section_key", "=", sectionKey)
              .execute();
            if (claims.length > 0) {
              await transaction
                .insertInto("section_claim")
                .values(
                  claims.map((claim, claimIndex) => ({
                    section_key: sectionKey,
                    claim_index: claimIndex,
                    claim: { ...claim },
                    run_id: run.id,
                  })),
                )
                .execute();
            }
          });
        },
      },
      {
        full: options.full || checkpoint === null || configChanged,
        publish: options.publish,
        checkpoint,
      },
    );
    if (result.publication) {
      await savePublicationState(db, result.publication, targetBranchRef);
      await db
        .updateTable("outbox")
        .set({ delivered_at: new Date() })
        .where("run_id", "=", run.id)
        .where("kind", "=", "publication")
        .execute();
    }
    await materializeStoredRenders(db, config.documentation.root);
    await db
      .updateTable("run")
      .set({
        status: "succeeded",
        stage: options.publish ? "publish" : "render",
        detail: {
          renderedSections: Object.keys(result.rendered),
          gaps: result.gaps,
          audit: result.audit,
          modelCallCount,
          tokenUsage,
          publication: result.publication ?? null,
        },
        completed_at: new Date(),
      })
      .where("id", "=", run.id)
      .execute();
    logger.info(
      {
        runId: run.id,
        stage: options.publish ? "publish" : "render",
        renderedSectionCount: Object.keys(result.rendered).length,
        gapSectionCount: Object.keys(result.gaps).length,
        publicationStatus: result.publication?.pullRequestStatus,
        evidenceCount: result.audit.evidenceCount,
        modelVerificationCount: result.audit.modelVerificationCount,
        modelCallCount,
        tokenUsage,
        durationMs: Math.round(performance.now() - startedAt),
      },
      "run completed",
    );
    return { runId: run.id, result };
  } catch (error) {
    try {
      await db
        .updateTable("run")
        .set({
          status: "failed",
          detail: { errorClass: error instanceof Error ? error.name : "UnknownError" },
          completed_at: new Date(),
        })
        .where("id", "=", run.id)
        .execute();
    } catch (auditError) {
      logger.error({ runId: run.id, error: auditError }, "failed to persist run failure audit");
    }
    logger.error(
      {
        runId: run.id,
        stage: "failed",
        durationMs: Math.round(performance.now() - startedAt),
        error,
      },
      "run failed",
    );
    throw error;
  } finally {
    try {
      await db.destroy();
    } finally {
      await runtimeLock.release();
    }
  }
}

export async function loadStoredSection(
  config: AgentDocsConfig,
  sectionKey: string,
): Promise<string> {
  const db = createDatabase();
  try {
    const row = await db
      .selectFrom("section_render")
      .select("content")
      .where("section_key", "=", sectionKey)
      .executeTakeFirst();
    if (!row) throw new Error(`Stored section not found: ${sectionKey}`);
    return row.content;
  } finally {
    await db.destroy();
  }
}

export async function inspectRun(id: string): Promise<Record<string, unknown>> {
  const db = createDatabase();
  try {
    const run = await db.selectFrom("run").selectAll().where("id", "=", id).executeTakeFirst();
    if (!run) throw new Error(`Run not found: ${id}`);
    const [
      repositories,
      projections,
      snapshots,
      edges,
      renders,
      claims,
      checkpointEntities,
      stages,
      outboxRows,
      checkpoint,
    ] = await Promise.all([
      count(db, "repository_projection"),
      count(db, "projection"),
      count(db, "source_snapshot"),
      count(db, "trace_edge"),
      count(db, "section_render"),
      count(db, "section_claim"),
      count(db, "checkpoint_entity"),
      db.selectFrom("run_stage").selectAll().where("run_id", "=", id).execute(),
      db.selectFrom("outbox").selectAll().where("run_id", "=", id).execute(),
      db.selectFrom("checkpoint").selectAll().execute(),
    ]);
    const outbox = outboxRows.map((row) => {
      const files = row.payload.files;
      const filePaths =
        typeof files === "object" && files !== null && !Array.isArray(files)
          ? Object.keys(files).sort()
          : [];
      return {
        id: row.id,
        kind: row.kind,
        deliveredAt: row.delivered_at,
        createdAt: row.created_at,
        fileCount: filePaths.length,
        filePaths,
      };
    });
    return {
      run,
      counts: {
        repositories,
        projections,
        snapshots,
        edges,
        renders,
        claims,
        checkpointEntities,
      },
      stages,
      outbox,
      checkpoint,
    };
  } finally {
    await db.destroy();
  }
}

async function loadPublicationState(db: Kysely<Database>): Promise<PublicationState | null> {
  const row = await db
    .selectFrom("publication_state")
    .select("state")
    .where("id", "=", "default")
    .executeTakeFirst();
  return (row?.state as unknown as PublicationState | undefined) ?? null;
}

async function savePublicationState(
  db: Kysely<Database>,
  state: PublicationState,
  targetBranch: string,
): Promise<void> {
  await db
    .insertInto("publication_state")
    .values({
      id: "default",
      target_branch: targetBranch,
      state: state as unknown as Record<string, unknown>,
    })
    .onConflict((conflict) =>
      conflict.column("id").doUpdateSet({
        target_branch: targetBranch,
        state: state as unknown as Record<string, unknown>,
        updated_at: new Date(),
      }),
    )
    .execute();
}

async function loadUnpublishedRenderFiles(
  db: Kysely<Database>,
): Promise<Readonly<Record<string, string>>> {
  const [state, renders] = await Promise.all([
    loadPublicationState(db),
    db.selectFrom("section_render").select(["section_key", "content"]).execute(),
  ]);
  return Object.fromEntries(
    renders.flatMap((render) => {
      const definition = SECTION_CATALOG.find((section) => section.key === render.section_key);
      if (!definition) return [];
      return state?.generatorFileHashes[definition.outputPath] === hash(render.content)
        ? []
        : [[definition.outputPath, render.content]];
    }),
  );
}

async function materializeStoredRenders(
  db: Kysely<Database>,
  documentationRoot: string,
): Promise<void> {
  const renders = await db
    .selectFrom("section_render")
    .select(["section_key", "content"])
    .execute();
  for (const render of renders) {
    const definition = SECTION_CATALOG.find((section) => section.key === render.section_key);
    if (!definition) continue;
    await writeAtomicallyIfChanged(
      resolve(documentationRoot, definition.outputPath),
      render.content,
    );
  }
}

async function writeAtomicallyIfChanged(path: string, content: string): Promise<void> {
  await assertSafeOutputPath(path);
  try {
    if ((await readFile(path, "utf8")) === content) return;
  } catch (error) {
    if (!isMissingPath(error)) throw error;
  }
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.agent-docs-${randomUUID()}.tmp`;
  let temporaryCreated = false;
  try {
    await writeFile(temporary, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    temporaryCreated = true;
    await rename(temporary, path);
  } catch (error) {
    if (temporaryCreated) await rm(temporary, { force: true });
    throw error;
  }
}

async function assertSafeOutputPath(path: string): Promise<void> {
  const workspace = await realpath(process.cwd());
  const absolute = resolve(path);
  const relativePath = relative(workspace, absolute);
  if (
    relativePath === "" ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    resolve(workspace, relativePath) !== absolute
  ) {
    throw new Error("Documentation output path escapes the repository workspace");
  }
  let current = workspace;
  for (const segment of relativePath.split(sep).slice(0, -1)) {
    current = resolve(current, segment);
    try {
      if ((await lstat(current)).isSymbolicLink()) {
        throw new Error("Documentation output path contains a symbolic link");
      }
    } catch (error) {
      if (isMissingPath(error)) return;
      throw error;
    }
  }
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function count(
  db: Kysely<Database>,
  table:
    | "repository_projection"
    | "projection"
    | "source_snapshot"
    | "trace_edge"
    | "section_render"
    | "section_claim"
    | "checkpoint_entity",
): Promise<number> {
  const result = await db
    .selectFrom(table)
    .select((expression) => expression.fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(result.count);
}

function readGapState(
  value: Record<string, unknown> | undefined,
): Readonly<Record<string, readonly string[]>> {
  if (!value) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter(
        (entry): entry is [string, string[]] =>
          Array.isArray(entry[1]) && entry[1].every((message) => typeof message === "string"),
      )
      .map(([section, messages]) => [section, [...messages]]),
  );
}

function stageLogDetail(detail: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const allowed = [
    "full",
    "snapshotCount",
    "tombstoneCount",
    "evidenceCount",
    "gapSectionCount",
    "fileCount",
  ];
  return Object.fromEntries(allowed.flatMap((key) => (key in detail ? [[key, detail[key]]] : [])));
}

function accumulateTokenUsage(
  target: { input: number; output: number; total: number },
  usage: unknown,
): void {
  if (typeof usage !== "object" || usage === null) return;
  const values = usage as Record<string, unknown>;
  target.input += numericUsage(values.input_tokens) + numericUsage(values.prompt_tokens);
  target.output += numericUsage(values.output_tokens);
  target.total += numericUsage(values.total_tokens);
}

function numericUsage(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
