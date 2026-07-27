import type { AzureDevOpsClient } from "./client.js";
import type { EdgarConfig } from "../config/schema.js";
import type { SourceConnector } from "../domain/ports.js";
import type { SourceDeltaBatch, SourceSnapshotInput } from "../domain/types.js";
import { hash } from "../evidence/fragments.js";
import { isSensitivePath, redactText } from "../security/redaction.js";
import { minimatch } from "minimatch";

interface Repository {
  readonly id: string;
  readonly name?: string;
  readonly defaultBranch: string;
}

interface GitItem {
  readonly path: string;
  readonly objectId: string;
  readonly isFolder?: boolean;
  readonly isBinary?: boolean;
}

interface GitCommit {
  readonly commitId: string;
  readonly comment: string;
  readonly remoteUrl: string;
  readonly author?: { readonly date?: string };
}

interface PullRequest {
  readonly pullRequestId: number;
  readonly title: string;
  readonly description?: string;
  readonly lastMergeSourceCommit?: { readonly commitId: string };
  readonly url: string;
}

interface WorkItem {
  readonly id: number;
  readonly rev: number;
  readonly fields: Readonly<Record<string, unknown>>;
  readonly relations?: readonly { readonly rel: string; readonly url: string }[];
}

const FILE_DOWNLOAD_CONCURRENCY = 4;
const PR_ENRICH_CONCURRENCY = 4;

export class AzureDevOpsSourceConnector implements SourceConnector {
  public constructor(
    private readonly client: AzureDevOpsClient,
    private readonly config: EdgarConfig,
  ) {}

  public async validateAccess(): Promise<void> {
    await this.repository();
    const configuredFields = Object.values(this.config.azureDevOps.fields)
      .map((field) => `[${field.replaceAll("]", "]]")}]`)
      .join(", ");
    const configuredTypes = Object.keys(this.config.azureDevOps.workItemTypes)
      .map((type) => `'${type.replaceAll("'", "''")}'`)
      .join(", ");
    await this.client.send("POST", `${this.projectPath()}/_apis/wit/wiql`, {
      query:
        `SELECT TOP 1 [System.Id], [System.WorkItemType], ${configuredFields} ` +
        `FROM WorkItems WHERE [System.TeamProject] = @project ` +
        `AND [System.WorkItemType] IN (${configuredTypes})`,
    });
  }

  public async discoverDefaultBranch(): Promise<{ name: string; objectId: string }> {
    const repository = await this.repository();
    const name = repository.defaultBranch.replace(/^refs\/heads\//, "");
    const refs = await this.client.get<{ value: { name: string; objectId: string }[] }>(
      `${this.projectPath()}/_apis/git/repositories/${encodeURIComponent(repository.id)}/refs`,
      { filter: `heads/${name}` },
    );
    const ref = refs.value.find((item) => item.name === repository.defaultBranch);
    if (!ref) throw new Error(`Default branch ref not found: ${repository.defaultBranch}`);
    return { name, objectId: ref.objectId };
  }

  public async fetchDelta(
    checkpoint: Record<string, unknown> | null,
    full: boolean,
  ): Promise<SourceDeltaBatch> {
    const repository = await this.repository();
    const branch = await this.discoverDefaultBranch();
    let effectiveFull =
      full ||
      (typeof checkpoint?.defaultBranch === "string" && checkpoint.defaultBranch !== branch.name);
    const checkpointHead = checkpoint?.defaultBranchSha;
    if (!effectiveFull && typeof checkpointHead === "string") {
      try {
        const diff = await this.client.get<{ commonCommit?: string }>(
          `${this.projectPath()}/_apis/git/repositories/${encodeURIComponent(repository.id)}/diffs/commits`,
          {
            baseVersion: checkpointHead,
            baseVersionType: "commit",
            targetVersion: branch.objectId,
            targetVersionType: "commit",
          },
        );
        effectiveFull = diff.commonCommit !== checkpointHead;
      } catch {
        effectiveFull = true;
      }
    }
    const previousEntities =
      checkpoint?.entities !== null &&
      typeof checkpoint?.entities === "object" &&
      checkpoint.entities !== undefined
        ? (checkpoint.entities as Record<string, string>)
        : {};
    const historyFrom = effectiveFull
      ? this.config.azureDevOps.historyFrom
      : overlappingHistoryFrom(this.config.azureDevOps.historyFrom, checkpoint?.historyWatermark);
    const snapshots: SourceSnapshotInput[] = [];
    const items: GitItem[] = [];
    for await (const page of this.client.pages<GitItem>(
      `${this.projectPath()}/_apis/git/repositories/${encodeURIComponent(repository.id)}/items`,
      {
        recursionLevel: "Full",
        scopePath: "/",
        versionDescriptorVersion: branch.objectId,
        versionDescriptorVersionType: "commit",
      },
    )) {
      items.push(...page);
    }
    const preservedFileEntities = new Map<string, string>();
    const changedItems: GitItem[] = [];
    for (const item of items) {
      if (item.isFolder || item.isBinary === true || !this.included(item.path)) continue;
      const previousEntity = previousEntities[item.path];
      if (
        !effectiveFull &&
        previousEntity !== undefined &&
        previousEntityRevision(previousEntity) === item.objectId
      ) {
        preservedFileEntities.set(item.path, previousEntity);
        continue;
      }
      changedItems.push(item);
    }
    const fileSnapshots = await mapWithConcurrency(
      changedItems,
      FILE_DOWNLOAD_CONCURRENCY,
      async (item) => {
        const response = await this.client.get<unknown>(
          `${this.projectPath()}/_apis/git/repositories/${encodeURIComponent(repository.id)}/items`,
          {
            path: item.path,
            includeContent: "true",
            versionDescriptorVersion: branch.objectId,
            versionDescriptorVersionType: "commit",
          },
        );
        const raw = gitItemContent(response);
        if (Buffer.byteLength(raw, "utf8") > this.config.source.maxTextFileBytes) return null;
        if (!isProbablyText(raw)) return null;
        const content = redactText(raw);
        return {
          sourceRef: item.path,
          revision: item.objectId,
          sourceType: sourceTypeForPath(item.path),
          locator: item.path,
          pinnedUrl: this.pinnedFileUrl(repository.id, item.path, branch.objectId),
          redactedContent: content,
          contentHash: hash(content),
        } satisfies SourceSnapshotInput;
      },
    );
    snapshots.push(
      ...fileSnapshots.filter((snapshot): snapshot is SourceSnapshotInput => snapshot !== null),
    );
    const linkedWorkItemIds = await this.appendHistorySnapshots(
      repository.id,
      branch.objectId,
      historyFrom,
      snapshots,
    );
    await this.appendWorkItemSnapshots(snapshots, linkedWorkItemIds, historyFrom);
    const retainedCommitEntities = Object.fromEntries(
      Object.entries(previousEntities).filter(([sourceRef]) => sourceRef.startsWith("commit:")),
    );
    const retainedIncrementalWorkItems = effectiveFull
      ? {}
      : Object.fromEntries(
          Object.entries(previousEntities).filter(([sourceRef]) =>
            sourceRef.startsWith("work-item:"),
          ),
        );
    const currentEntities = {
      ...retainedCommitEntities,
      ...retainedIncrementalWorkItems,
      ...Object.fromEntries(preservedFileEntities),
      ...Object.fromEntries(
        snapshots.map((snapshot) => [
          snapshot.sourceRef,
          `${snapshot.revision}:${snapshot.contentHash}`,
        ]),
      ),
    };
    const removed = Object.keys(previousEntities).filter(
      (sourceRef) => !sourceRef.startsWith("commit:") && !(sourceRef in currentEntities),
    );
    const addedByContent = new Map(
      snapshots
        .filter((snapshot) => !(snapshot.sourceRef in previousEntities))
        .map((snapshot) => [snapshot.contentHash, snapshot.sourceRef]),
    );
    const tombstones = removed.map((sourceRef) => {
      const previousHash = previousEntities[sourceRef]?.split(":").at(-1);
      const replacementRef = previousHash ? addedByContent.get(previousHash) : undefined;
      return replacementRef
        ? {
            sourceRef,
            revision: branch.objectId,
            reason: "renamed" as const,
            replacementRef,
          }
        : {
            sourceRef,
            revision: branch.objectId,
            reason: "deleted" as const,
          };
    });
    const changedSnapshots = effectiveFull
      ? snapshots
      : snapshots.filter(
          (snapshot) =>
            previousEntities[snapshot.sourceRef] !== `${snapshot.revision}:${snapshot.contentHash}`,
        );
    return {
      snapshots: changedSnapshots,
      tombstones,
      repository: {
        id: repository.id,
        name: repository.name ?? this.config.azureDevOps.repository,
        defaultBranch: branch.name,
        headRevision: branch.objectId,
      },
      candidateCheckpoint: {
        defaultBranch: branch.name,
        defaultBranchSha: branch.objectId,
        historyWatermark: new Date().toISOString(),
        previousHead: effectiveFull ? null : (checkpoint?.defaultBranchSha ?? null),
        entities: currentEntities,
        fullResync: effectiveFull,
      },
    };
  }

  private async appendHistorySnapshots(
    repositoryId: string,
    head: string,
    historyFrom: string,
    snapshots: SourceSnapshotInput[],
  ): Promise<ReadonlySet<number>> {
    const linkedWorkItemIds = new Set<number>();
    const commits: GitCommit[] = [];
    for await (const page of this.client.pages<GitCommit>(
      `${this.projectPath()}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/commits`,
      {
        "searchCriteria.fromDate": historyFrom,
        "searchCriteria.itemVersion.version": head,
        "searchCriteria.itemVersion.versionType": "commit",
      },
    )) {
      commits.push(...page);
    }
    for (const commit of commits) {
      const changedPaths: string[] = [];
      const pageSize = 2_000;
      for (let skip = 0; ; skip += pageSize) {
        const changes = await this.client.get<{ changes: { item?: { path?: string } }[] }>(
          `${this.projectPath()}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/commits/${commit.commitId}/changes`,
          { $top: String(pageSize), $skip: String(skip) },
        );
        changedPaths.push(
          ...changes.changes
            .map((change) => change.item?.path)
            .filter((path): path is string => path !== undefined),
        );
        if (changes.changes.length < pageSize) break;
      }
      const content = redactText(commit.comment);
      const traceMetadata = { changedPaths };
      snapshots.push({
        sourceRef: `commit:${commit.commitId}`,
        revision: commit.commitId,
        sourceType: "commit",
        locator: commit.commitId,
        pinnedUrl: this.commitUrl(repositoryId, commit.commitId),
        redactedContent: content,
        contentHash: traceContentHash(content, traceMetadata),
        traceMetadata,
      });
    }
    const listedPullRequests: PullRequest[] = [];
    for await (const page of this.client.pages<PullRequest>(
      `${this.projectPath()}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests`,
      { "searchCriteria.status": "all" },
    )) {
      listedPullRequests.push(...page);
    }
    const pullRequestSnapshots = await mapWithConcurrency(
      listedPullRequests,
      PR_ENRICH_CONCURRENCY,
      async (listed) => {
        const pr = await this.client.get<PullRequest>(
          `${this.projectPath()}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests/${String(listed.pullRequestId)}`,
        );
        const [workItems, commits] = await Promise.all([
          this.client.get<{ value: { id: string }[] }>(
            `${this.projectPath()}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests/${String(pr.pullRequestId)}/workitems`,
          ),
          this.client.get<{ value: { commitId: string }[] }>(
            `${this.projectPath()}/_apis/git/repositories/${encodeURIComponent(repositoryId)}/pullrequests/${String(pr.pullRequestId)}/commits`,
          ),
        ]);
        const traceMetadata = {
          workItemIds: workItems.value.map((item) => item.id),
          commitIds: commits.value.map((item) => item.commitId),
        };
        for (const workItem of workItems.value) {
          const id = Number(workItem.id);
          if (Number.isSafeInteger(id) && id > 0) linkedWorkItemIds.add(id);
        }
        const content = redactText(`${pr.title}\n\n${pr.description ?? ""}`);
        return {
          sourceRef: `pull-request:${String(pr.pullRequestId)}`,
          revision: pr.lastMergeSourceCommit?.commitId ?? String(pr.pullRequestId),
          sourceType: "pull_request",
          locator: `PR ${String(pr.pullRequestId)}`,
          pinnedUrl:
            `${this.config.azureDevOps.organization}/${encodeURIComponent(this.config.azureDevOps.project)}` +
            `/_git/${encodeURIComponent(this.config.azureDevOps.repository)}/pullrequest/${String(pr.pullRequestId)}` +
            `?version=${encodeURIComponent(pr.lastMergeSourceCommit?.commitId ?? String(pr.pullRequestId))}`,
          redactedContent: content,
          contentHash: traceContentHash(content, traceMetadata),
          traceMetadata,
        } satisfies SourceSnapshotInput;
      },
    );
    snapshots.push(...pullRequestSnapshots);
    return linkedWorkItemIds;
  }

  private async appendWorkItemSnapshots(
    snapshots: SourceSnapshotInput[],
    linkedWorkItemIds: ReadonlySet<number>,
    historyFrom: string,
  ): Promise<void> {
    const types = Object.keys(this.config.azureDevOps.workItemTypes);
    const escapedTypes = types.map((type) => `'${type.replaceAll("'", "''")}'`).join(", ");
    const result = await this.client.send<{ workItems: { id: number }[] }>(
      "POST",
      `${this.projectPath()}/_apis/wit/wiql`,
      {
        query:
          `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project ` +
          `AND [System.WorkItemType] IN (${escapedTypes}) ` +
          `AND [System.ChangedDate] >= '${historyFrom}' ORDER BY [System.ChangedDate]`,
      },
    );
    const pending = [
      ...new Set([...result.workItems.map((item) => item.id), ...linkedWorkItemIds]),
    ];
    const visited = new Set<number>();
    while (pending.length > 0) {
      const page = pending.splice(0, 200).filter((id) => !visited.has(id));
      if (page.length === 0) continue;
      for (const id of page) visited.add(id);
      const response = await this.client.get<{ value: WorkItem[] }>(
        `${this.projectPath()}/_apis/wit/workitems`,
        { ids: page.join(","), $expand: "Relations" },
      );
      for (const item of response.value) {
        const workItemType = item.fields["System.WorkItemType"];
        const canonicalRole =
          typeof workItemType === "string"
            ? this.config.azureDevOps.workItemTypes[workItemType]
            : undefined;
        if (!canonicalRole) continue;
        const fields = this.config.azureDevOps.fields;
        const selected = Object.fromEntries(
          Object.entries(fields).map(([name, reference]) => [name, item.fields[reference] ?? null]),
        );
        const linkedIds = (item.relations ?? [])
          .map((relation) => /\/workItems\/(\d+)(?:$|[?#/])/i.exec(relation.url)?.[1])
          .filter((id): id is string => id !== undefined)
          .map(Number)
          .filter((id) => Number.isSafeInteger(id) && id > 0);
        for (const linkedId of linkedIds) {
          if (!visited.has(linkedId) && pending.length < 10_000) pending.push(linkedId);
        }
        const content = redactText(
          JSON.stringify(
            {
              workItemType,
              canonicalRole,
              fields: selected,
              relations: item.relations ?? [],
            },
            null,
            2,
          ),
        );
        snapshots.push({
          sourceRef: `work-item:${String(item.id)}`,
          revision: String(item.rev),
          sourceType: "work_item",
          locator: `Work item ${String(item.id)} revision ${String(item.rev)}`,
          pinnedUrl:
            `${this.config.azureDevOps.organization}/${encodeURIComponent(this.config.azureDevOps.project)}` +
            `/_workitems/edit/${String(item.id)}?version=${String(item.rev)}`,
          redactedContent: content,
          contentHash: hash(content),
        });
      }
    }
  }

  private included(path: string): boolean {
    const normalized = path.replace(/^\/+/, "");
    return (
      !isSensitivePath(normalized, this.config.documentation.root) &&
      this.config.source.include.some((pattern) => minimatch(normalized, pattern, { dot: true })) &&
      !this.config.source.exclude.some((pattern) => minimatch(normalized, pattern, { dot: true }))
    );
  }

  private async repository(): Promise<Repository> {
    return this.client.get<Repository>(
      `${this.projectPath()}/_apis/git/repositories/${encodeURIComponent(this.config.azureDevOps.repository)}`,
    );
  }

  private projectPath(): string {
    return `/${encodeURIComponent(this.config.azureDevOps.project)}`;
  }

  private pinnedFileUrl(repositoryId: string, path: string, revision: string): string {
    const url = new URL(
      `${this.config.azureDevOps.organization}/${encodeURIComponent(this.config.azureDevOps.project)}/_git/${encodeURIComponent(repositoryId)}`,
    );
    url.searchParams.set("path", path);
    url.searchParams.set("version", `GC${revision}`);
    return url.toString();
  }

  private commitUrl(repositoryId: string, commitId: string): string {
    return `${this.config.azureDevOps.organization}/${encodeURIComponent(this.config.azureDevOps.project)}/_git/${encodeURIComponent(repositoryId)}/commit/${commitId}?version=GC${commitId}`;
  }
}

function previousEntityRevision(value: string | undefined): string | undefined {
  return value?.split(":", 1)[0];
}

async function mapWithConcurrency<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (values.length === 0) return [];
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(concurrency, 1), values.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await mapper(values[index]!, index);
      }
    }),
  );
  return results;
}

function isProbablyText(value: string): boolean {
  if (value.includes("\0")) return false;
  if (value.length === 0) return true;
  let suspicious = 0;
  for (const character of value) {
    const point = character.codePointAt(0) ?? 0;
    if (
      (point < 0x20 && character !== "\n" && character !== "\r" && character !== "\t") ||
      point === 0x7f
    ) {
      suspicious += 1;
    }
  }
  return suspicious / value.length <= 0.01;
}

function gitItemContent(response: unknown): string {
  if (typeof response === "string") return response;
  if (
    typeof response === "object" &&
    response !== null &&
    "content" in response &&
    typeof response.content === "string"
  ) {
    return response.content;
  }
  return "";
}

function sourceTypeForPath(path: string): SourceSnapshotInput["sourceType"] {
  if (path.match(/(^|\/)(test|tests|spec)(\/|$)|\.(test|spec)\./)) return "test";
  if (path.match(/(^|\/)README|\.md$/i)) return "existing_document";
  return "code";
}

function traceContentHash(content: string, traceMetadata: object): string {
  return hash(`${content}\0${JSON.stringify(traceMetadata)}`);
}

function overlappingHistoryFrom(configuredFrom: string, watermark: unknown): string {
  if (typeof watermark !== "string") return configuredFrom;
  const configured = Date.parse(configuredFrom);
  const recorded = Date.parse(watermark);
  if (!Number.isFinite(recorded)) return configuredFrom;
  return new Date(Math.max(configured, recorded - 5 * 60 * 1_000)).toISOString();
}
