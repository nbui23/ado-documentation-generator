import type { SourceConnector } from "../domain/ports.js";
import type { SourceDeltaBatch, SourceSnapshotInput } from "../domain/types.js";
import { hash } from "../evidence/fragments.js";
import { redactText } from "../security/redaction.js";
import type { JiraClient } from "./client.js";

export interface JiraConfig {
  readonly cloudId: string;
  readonly siteUrl: string;
  readonly jql: string;
  readonly issueTypes: Readonly<Record<string, string>>;
  readonly fields: Readonly<Record<string, string | undefined>>;
}

interface JiraIssue {
  readonly key: string;
  readonly fields: Readonly<Record<string, unknown>> & {
    readonly issuetype?: { readonly name?: string };
    readonly updated?: string;
  };
}

interface SearchPage {
  readonly issues?: readonly JiraIssue[];
  readonly nextPageToken?: string;
  readonly isLast?: boolean;
}

interface ChangelogPage {
  readonly values?: readonly {
    readonly created?: string;
    readonly items?: readonly {
      readonly field?: string;
      readonly fieldId?: string;
      readonly fromString?: string | null;
      readonly toString?: string | null;
    }[];
  }[];
  readonly startAt?: number;
  readonly maxResults?: number;
  readonly total?: number;
  readonly isLast?: boolean;
}

const OVERLAP_MS = 5 * 60 * 1_000;

export class JiraSourceConnector implements SourceConnector {
  public constructor(
    private readonly client: JiraClient,
    private readonly config: JiraConfig,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async validateAccess(): Promise<void> {
    await this.client.get("/rest/api/3/myself");
    await this.client.post("/rest/api/3/search/jql", {
      jql: this.query(),
      fields: ["updated"],
      maxResults: 1,
    });
  }

  public discoverDefaultBranch(): Promise<{ name: string; objectId: string }> {
    return Promise.reject(new Error("Jira does not provide repository branches"));
  }

  public async fetchDelta(
    checkpoint: Record<string, unknown> | null,
    full: boolean,
  ): Promise<SourceDeltaBatch> {
    const startedAt = this.now();
    const previousEntities = recordOfStrings(checkpoint?.entities);
    const watermark = typeof checkpoint?.watermark === "string" ? checkpoint.watermark : undefined;
    const issues = await this.search(this.query(full ? undefined : watermark));
    const snapshots: SourceSnapshotInput[] = [];
    for (let index = 0; index < issues.length; index += 4) {
      snapshots.push(
        ...(await Promise.all(issues.slice(index, index + 4).map((issue) => this.snapshot(issue)))),
      );
    }
    const returnedEntities = Object.fromEntries(
      snapshots.map((snapshot) => [
        snapshot.sourceRef,
        `${snapshot.revision}:${snapshot.contentHash}`,
      ]),
    );
    const entities = full ? returnedEntities : { ...previousEntities, ...returnedEntities };
    const tombstones = full
      ? Object.keys(previousEntities)
          .filter((sourceRef) => sourceRef.startsWith("work-item:jira:"))
          .filter((sourceRef) => !(sourceRef in returnedEntities))
          .map((sourceRef) => ({
            sourceRef,
            revision: startedAt.toISOString(),
            reason: "deleted" as const,
          }))
      : [];

    return {
      snapshots: snapshots.filter(
        (snapshot) =>
          previousEntities[snapshot.sourceRef] !== `${snapshot.revision}:${snapshot.contentHash}`,
      ),
      tombstones,
      candidateCheckpoint: {
        watermark: startedAt.toISOString(),
        entities,
      },
    };
  }

  private async search(jql: string): Promise<JiraIssue[]> {
    const issues: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    do {
      const page: SearchPage = await this.client.post("/rest/api/3/search/jql", {
        jql,
        fields: [
          "issuetype",
          "updated",
          ...new Set(
            Object.values(this.config.fields).filter(
              (field): field is string => field !== undefined,
            ),
          ),
        ],
        maxResults: 100,
        ...(nextPageToken ? { nextPageToken } : {}),
      });
      issues.push(...(page.issues ?? []));
      nextPageToken = page.isLast === true ? undefined : page.nextPageToken;
    } while (nextPageToken);
    return issues;
  }

  private async snapshot(issue: JiraIssue): Promise<SourceSnapshotInput> {
    const issueType = issue.fields.issuetype?.name;
    const canonicalRole = issueType ? this.config.issueTypes[issueType] : undefined;
    if (!issueType || !canonicalRole) {
      throw new Error(`Jira issue ${issue.key} has an unmapped issue type`);
    }
    const transitions = await this.changelog(issue.key);
    const fields = Object.fromEntries(
      Object.entries(this.config.fields)
        .filter((entry): entry is [string, string] => entry[1] !== undefined)
        .map(([name, reference]) => [name, normalizeField(issue.fields[reference])]),
    );
    const content = redactText(
      JSON.stringify({ key: issue.key, issueType, canonicalRole, fields, transitions }, null, 2),
    );
    const revision = issue.fields.updated;
    if (!revision || Number.isNaN(Date.parse(revision))) {
      throw new Error(`Jira issue ${issue.key} has no valid updated timestamp`);
    }
    const key = issue.key.toUpperCase();
    return {
      sourceRef: `work-item:jira:${key}`,
      revision,
      sourceType: "work_item",
      locator: `Jira ${key} updated ${revision}`,
      pinnedUrl: `${this.config.siteUrl.replace(/\/+$/, "")}/browse/${encodeURIComponent(key)}`,
      redactedContent: content,
      contentHash: hash(content),
    };
  }

  private async changelog(key: string): Promise<unknown[]> {
    const mappedFields = new Set(
      Object.values(this.config.fields).filter((field): field is string => field !== undefined),
    );
    const transitions: unknown[] = [];
    for (let startAt = 0; ;) {
      const page = await this.client.get<ChangelogPage>(
        `/rest/api/3/issue/${encodeURIComponent(key)}/changelog`,
        { startAt: String(startAt), maxResults: "100" },
      );
      for (const history of page.values ?? []) {
        for (const item of history.items ?? []) {
          const reference = item.fieldId ?? item.field;
          if (!reference || !mappedFields.has(reference)) continue;
          const name =
            Object.entries(this.config.fields).find(([, value]) => value === reference)?.[0] ??
            reference;
          transitions.push({
            created: history.created ?? null,
            field: name,
            from: item.fromString ?? null,
            to: item.toString ?? null,
          });
        }
      }
      const count = page.values?.length ?? 0;
      startAt = (page.startAt ?? startAt) + count;
      if (
        page.isLast === true ||
        count === 0 ||
        (page.total !== undefined && startAt >= page.total) ||
        count < (page.maxResults ?? 100)
      ) {
        break;
      }
    }
    return transitions;
  }

  private query(watermark?: string): string {
    const types = Object.keys(this.config.issueTypes)
      .map((type) => `"${type.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`)
      .join(", ");
    const base = `(${this.config.jql}) AND issuetype IN (${types})`;
    if (!watermark) return `${base} ORDER BY updated ASC, key ASC`;
    const overlap = new Date(Date.parse(watermark) - OVERLAP_MS);
    if (Number.isNaN(overlap.getTime())) throw new Error("Invalid Jira checkpoint watermark");
    const jiraDate = overlap.toISOString().slice(0, 16).replace("T", " ");
    return `${base} AND updated >= "${jiraDate}" ORDER BY updated ASC, key ASC`;
  }
}

export function adfToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const node = value as { type?: unknown; text?: unknown; content?: unknown };
  if (typeof node.text === "string") return node.text;
  if (!Array.isArray(node.content)) return "";
  const separator = node.type === "doc" ? "\n" : node.type === "paragraph" ? "" : "";
  const text = node.content.map(adfToText).filter(Boolean).join(separator);
  return node.type === "paragraph" ? `${text}\n` : text;
}

function normalizeField(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeField);
  if (value && typeof value === "object" && "type" in value) return adfToText(value).trim();
  if (value && typeof value === "object" && "name" in value) {
    const name = (value as { name?: unknown }).name;
    if (typeof name === "string") return name;
  }
  if (value && typeof value === "object" && "displayName" in value) {
    const displayName = (value as { displayName?: unknown }).displayName;
    if (typeof displayName === "string") return displayName;
  }
  return value ?? null;
}

function recordOfStrings(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object") return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}
