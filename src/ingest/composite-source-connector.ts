import type { SourceConnector } from "../domain/ports.js";
import type { SourceDeltaBatch, SourceSnapshotInput } from "../domain/types.js";

const JIRA_PREFIX = "work-item:jira:";
const JIRA_KEY = /\b[A-Z][A-Z0-9_]*-\d+\b/gi;

export class CompositeSourceConnector implements SourceConnector {
  public constructor(
    private readonly azureDevOps: SourceConnector,
    private readonly jira: SourceConnector,
  ) {}

  public async validateAccess(): Promise<void> {
    await Promise.all([this.azureDevOps.validateAccess(), this.jira.validateAccess()]);
  }

  public discoverDefaultBranch(): Promise<{ name: string; objectId: string }> {
    return this.azureDevOps.discoverDefaultBranch();
  }

  public async fetchDelta(
    checkpoint: Record<string, unknown> | null,
    full: boolean,
  ): Promise<SourceDeltaBatch> {
    const entities = stringMap(checkpoint?.entities);
    const azureCheckpoint = providerCheckpoint(checkpoint, "azureDevOps", entities, false);
    const jiraCheckpoint = providerCheckpoint(checkpoint, "jira", entities, true);
    const [azure, jira] = await Promise.all([
      this.azureDevOps.fetchDelta(azureCheckpoint, full),
      this.jira.fetchDelta(jiraCheckpoint, full),
    ]);
    const knownJiraKeys = jiraKeys(
      ...Object.keys(entities),
      ...Object.keys(stringMap(jira.candidateCheckpoint.entities)),
      ...jira.snapshots.map((snapshot) => snapshot.sourceRef),
    );
    const azureSnapshots = azure.snapshots.map((snapshot) =>
      enrichWithJiraKeys(snapshot, knownJiraKeys),
    );
    const azureEntities = stringMap(azure.candidateCheckpoint.entities);
    const jiraEntities = stringMap(jira.candidateCheckpoint.entities);

    return {
      snapshots: [...azureSnapshots, ...jira.snapshots],
      tombstones: [...azure.tombstones, ...jira.tombstones],
      ...(azure.repository ? { repository: azure.repository } : {}),
      candidateCheckpoint: {
        entities: { ...azureEntities, ...jiraEntities },
        azureDevOps: withoutEntities(azure.candidateCheckpoint),
        jira: withoutEntities(jira.candidateCheckpoint),
        fullResync:
          azure.candidateCheckpoint.fullResync === true ||
          jira.candidateCheckpoint.fullResync === true,
      },
    };
  }
}

function providerCheckpoint(
  checkpoint: Record<string, unknown> | null,
  provider: "azureDevOps" | "jira",
  entities: Record<string, string>,
  jira: boolean,
): Record<string, unknown> | null {
  if (!checkpoint) return null;
  const nested = record(checkpoint[provider]);
  const ownedEntities = Object.fromEntries(
    Object.entries(entities).filter(([sourceRef]) => sourceRef.startsWith(JIRA_PREFIX) === jira),
  );
  if (nested) return { ...nested, entities: ownedEntities };
  return { ...(provider === "azureDevOps" ? checkpoint : {}), entities: ownedEntities };
}

function enrichWithJiraKeys(
  snapshot: SourceSnapshotInput,
  knownKeys: ReadonlySet<string>,
): SourceSnapshotInput {
  if (snapshot.sourceType !== "pull_request" && snapshot.sourceType !== "commit") return snapshot;
  const matches = [...snapshot.redactedContent.matchAll(JIRA_KEY)]
    .map(([key]) => key.toUpperCase())
    .filter((key) => knownKeys.has(key))
    .map((key) => `jira:${key}`);
  if (matches.length === 0) return snapshot;
  const traceMetadata = {
    ...snapshot.traceMetadata,
    workItemIds: [...new Set([...(snapshot.traceMetadata?.workItemIds ?? []), ...matches])],
  };
  return {
    ...snapshot,
    traceMetadata,
  };
}

function jiraKeys(...sourceRefs: string[]): Set<string> {
  return new Set(
    sourceRefs
      .filter((sourceRef) => sourceRef.startsWith(JIRA_PREFIX))
      .map((sourceRef) => sourceRef.slice(JIRA_PREFIX.length).toUpperCase()),
  );
}

function stringMap(value: unknown): Record<string, string> {
  const object = record(value);
  if (!object) return {};
  return Object.fromEntries(
    Object.entries(object).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function withoutEntities(value: Record<string, unknown>): Record<string, unknown> {
  const metadata = { ...value };
  delete metadata.entities;
  return metadata;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
