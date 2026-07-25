import { sql, type Kysely } from "kysely";
import type { EvidenceRetriever } from "../domain/ports.js";
import type { EvidenceClass, EvidenceRef } from "../domain/types.js";
import { SECTION_CATALOG } from "../render/catalog.js";
import type { Database } from "./types.js";

export interface RetrievedEvidence extends EvidenceRef {
  readonly text: string;
}

export type EvidenceEmbedder = (
  inputs: readonly string[],
) => Promise<readonly (readonly number[])[]>;

export class PostgresEvidenceRetriever implements EvidenceRetriever {
  public constructor(
    private readonly db: Kysely<Database>,
    private readonly maxPackSize = 80,
    private readonly embedder?: EvidenceEmbedder,
    private readonly embeddingVersion = "default",
    private readonly embeddingBatchSize = 25,
  ) {}

  public async buildPack(
    sectionKey: string,
    traceNodeIds: readonly string[],
    options: { readonly rank?: boolean } = {},
  ): Promise<readonly RetrievedEvidence[]> {
    const definition = SECTION_CATALOG.find((section) => section.key === sectionKey);
    if (!definition) throw new Error(`Unknown section: ${sectionKey}`);
    if (traceNodeIds.length === 0) return [];
    const visited = new Set(traceNodeIds);
    const authorized = new Set<string>();
    let frontier = [...traceNodeIds];
    for (let depth = 0; depth < 3 && frontier.length > 0; depth += 1) {
      const edgeRows = await this.db
        .selectFrom("trace_edge")
        .select(["from_id", "to_id", "supporting_evidence_ids"])
        .where((expression) =>
          expression.or([
            expression("from_id", "in", frontier),
            expression("to_id", "in", frontier),
          ]),
        )
        .execute();
      const next: string[] = [];
      for (const edge of edgeRows) {
        for (const id of edge.supporting_evidence_ids) authorized.add(id);
        for (const node of [edge.from_id, edge.to_id]) {
          if (!visited.has(node)) {
            visited.add(node);
            next.push(node);
          }
        }
      }
      frontier = next;
    }
    const authorizedIds = [...authorized];
    const authorizedRefs = [
      ...visited,
      ...[...visited].flatMap((id) => [`work-item:${id}`, `pull-request:${id}`, `commit:${id}`]),
    ];
    const rows = await this.db
      .selectFrom("evidence_fragment")
      .innerJoin("source_snapshot", "source_snapshot.id", "evidence_fragment.snapshot_id")
      .innerJoin("projection", "projection.snapshot_id", "source_snapshot.id")
      .select([
        "evidence_fragment.id as fragment_id",
        "evidence_fragment.locator as fragment_locator",
        "evidence_fragment.redacted_text",
        "evidence_fragment.excerpt_hash",
        "evidence_fragment.embedding",
        "evidence_fragment.embedding_version",
        "source_snapshot.source_ref",
        "source_snapshot.revision",
        "source_snapshot.source_type",
        "source_snapshot.pinned_url",
      ])
      .where((expression) =>
        authorizedIds.length > 0
          ? expression.or([
              expression("source_snapshot.id", "in", authorizedIds),
              expression("source_snapshot.source_ref", "in", authorizedRefs),
            ])
          : expression("source_snapshot.source_ref", "in", authorizedRefs),
      )
      .where("source_snapshot.source_type", "in", [...definition.allowedEvidenceClasses])
      .orderBy("source_snapshot.source_ref")
      .orderBy("source_snapshot.revision")
      .orderBy("evidence_fragment.locator")
      .execute();
    const evidence = rows.map((row) => ({
      id: row.fragment_id,
      sourceRef: row.source_ref,
      revision: row.revision,
      sourceType: row.source_type as EvidenceClass,
      locator: row.fragment_locator,
      pinnedUrl: row.pinned_url,
      excerptHash: row.excerpt_hash,
      text: row.redacted_text,
    }));
    if (options.rank === false) return evidence;
    const embedder = this.embedder;
    if (!embedder || evidence.length === 0) return evidence.slice(0, this.maxPackSize);
    const [queryVector] = await embedder([sectionKey]);
    if (!queryVector || queryVector.length === 0) {
      throw new Error("Embedding provider did not return a query vector");
    }
    const missing = rows.filter(
      (row) => row.embedding === null || row.embedding_version !== this.embeddingVersion,
    );
    if (missing.length > 0) {
      const embedded: Array<{ id: string; value: string }> = [];
      for (const chunk of chunked(missing, this.embeddingBatchSize)) {
        const vectors = await embedder(chunk.map((row) => row.redacted_text));
        if (vectors.length !== chunk.length) {
          throw new Error("Embedding provider returned an unexpected number of vectors");
        }
        for (let index = 0; index < chunk.length; index += 1) {
          const vector = vectors[index];
          const row = chunk[index];
          if (!vector || !row || vector.length !== queryVector.length) {
            throw new Error("Embedding provider returned inconsistent vector dimensions");
          }
          embedded.push({ id: row.fragment_id, value: vectorLiteral(vector) });
        }
      }
      await this.db.transaction().execute(async (transaction) => {
        for (const fragment of embedded) {
          await transaction
            .updateTable("evidence_fragment")
            .set({
              embedding: fragment.value,
              embedding_version: this.embeddingVersion,
            })
            .where("id", "=", fragment.id)
            .execute();
        }
      });
    }
    const ids = evidence.map((item) => item.id);
    const ranked = await sql<{ id: string }>`
      select id
      from evidence_fragment
      where id = any(${ids})
      order by embedding <=> ${vectorLiteral(queryVector)}::vector, id
    `.execute(this.db);
    const byId = new Map(evidence.map((item) => [item.id, item]));
    return ranked.rows
      .flatMap((row) => {
        const item = byId.get(row.id);
        return item ? [item] : [];
      })
      .slice(0, this.maxPackSize);
  }
}

function vectorLiteral(vector: readonly number[]): string {
  if (
    vector.length === 0 ||
    vector.some((value) => !Number.isFinite(value) || value < -1e6 || value > 1e6)
  ) {
    throw new Error("Embedding vector contains invalid values");
  }
  return `[${vector.join(",")}]`;
}

function chunked<T>(items: readonly T[], size: number): readonly T[][] {
  const normalizedSize = Number.isSafeInteger(size) && size > 0 ? size : 25;
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += normalizedSize) {
    chunks.push(items.slice(index, index + normalizedSize));
  }
  return chunks;
}
