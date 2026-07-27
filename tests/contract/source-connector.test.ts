import { describe, expect, it, vi } from "vitest";
import { AzureDevOpsClient } from "../../src/ado/client.js";
import { AzureDevOpsSourceConnector } from "../../src/ado/source-connector.js";
import { edgarConfigSchema } from "../../src/config/schema.js";

describe("Azure DevOps source connector", () => {
  it("uses per-file revisions and ingests older PR-linked work items with canonical roles", async () => {
    const requestedWorkItemPages: string[] = [];
    const commitFromDates: string[] = [];
    const includeContentPaths: string[] = [];
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url =
        typeof input === "string"
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);
      const path = url.pathname;
      if (path.endsWith("/_apis/git/repositories/repo")) {
        return json({ id: "repo-id", defaultBranch: "refs/heads/main" });
      }
      if (path.endsWith("/refs")) {
        return json({
          value: [{ name: "refs/heads/main", objectId: "head-commit" }],
        });
      }
      if (path.endsWith("/diffs/commits")) {
        return json({ commonCommit: "head-commit" });
      }
      if (path.endsWith("/items") && url.searchParams.get("includeContent") === "true") {
        includeContentPaths.push(url.searchParams.get("path") ?? "");
        return json({
          content:
            url.searchParams.get("path") === "/assets/binary.dat"
              ? "binary\0content"
              : "export const current = true;",
        });
      }
      if (path.endsWith("/items")) {
        return json({
          value: [
            { path: "/src/current.ts", objectId: "file-blob-id" },
            { path: "/assets/binary.dat", objectId: "binary-blob-id" },
          ],
        });
      }
      if (path.endsWith("/pullrequests/7/commits")) {
        return json({ value: [] });
      }
      if (path.endsWith("/commits")) {
        commitFromDates.push(url.searchParams.get("searchCriteria.fromDate") ?? "");
        return json({ value: [] });
      }
      if (path.endsWith("/pullrequests")) {
        return json({
          value: [
            {
              pullRequestId: 7,
              title: "Implement requirement",
              lastMergeSourceCommit: { commitId: "merge-commit" },
              url: "ignored",
            },
          ],
        });
      }
      if (path.endsWith("/pullrequests/7/workitems")) {
        return json({ value: [{ id: "101" }] });
      }
      if (path.endsWith("/pullrequests/7")) {
        return json({
          pullRequestId: 7,
          title: "Implement requirement",
          description: "Implementation history",
          lastMergeSourceCommit: { commitId: "merge-commit" },
          url: "ignored",
        });
      }
      if (path.endsWith("/_apis/wit/wiql") && init?.method === "POST") {
        return json({ workItems: [{ id: 202 }] });
      }
      if (path.endsWith("/_apis/wit/workitems")) {
        requestedWorkItemPages.push(url.searchParams.get("ids") ?? "");
        const ids = new Set((url.searchParams.get("ids") ?? "").split(","));
        return json({
          value: [
            ...(ids.has("101")
              ? [
                  {
                    id: 101,
                    rev: 3,
                    fields: {
                      "System.WorkItemType": "Requirement",
                      "System.Title": "Older linked requirement",
                    },
                    relations: [],
                  },
                ]
              : []),
            ...(ids.has("202")
              ? [
                  {
                    id: 202,
                    rev: 5,
                    fields: {
                      "System.WorkItemType": "Feature",
                      "System.Title": "Recently changed feature",
                    },
                    relations: [],
                  },
                ]
              : []),
          ],
        });
      }
      return Promise.reject(
        new Error(`Unexpected request: ${init?.method ?? "GET"} ${url.toString()}`),
      );
    });
    const client = new AzureDevOpsClient(
      "https://dev.azure.com/example",
      { getAzureDevOpsToken: () => Promise.resolve("token") },
      fetcher,
    );
    const connector = new AzureDevOpsSourceConnector(client, config());

    const delta = await connector.fetchDelta(null, true);

    expect(delta.repository).toEqual({
      id: "repo-id",
      name: "repo",
      defaultBranch: "main",
      headRevision: "head-commit",
    });
    expect(delta.snapshots.find((item) => item.sourceRef === "/src/current.ts")?.revision).toBe(
      "file-blob-id",
    );
    expect(delta.snapshots.some((item) => item.sourceRef === "/assets/binary.dat")).toBe(false);
    expect(requestedWorkItemPages.some((ids) => ids.includes("101"))).toBe(true);
    const linked = delta.snapshots.find((item) => item.sourceRef === "work-item:101");
    expect(linked?.redactedContent).toContain('"canonicalRole": "requirement"');

    const incremental = await connector.fetchDelta(delta.candidateCheckpoint, false);
    expect(incremental.tombstones).toEqual([]);
    expect(commitFromDates).toHaveLength(2);
    expect(includeContentPaths.filter((path) => path === "/src/current.ts")).toHaveLength(1);
    expect(Date.parse(commitFromDates[1] ?? "")).toBeGreaterThan(
      Date.parse(config().azureDevOps.historyFrom),
    );
  });

  it("tombstones removed files and work items on full resync while retaining historical commits", async () => {
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url =
        typeof input === "string"
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);
      const path = url.pathname;
      if (path.endsWith("/_apis/git/repositories/repo")) {
        return json({ id: "repo-id", defaultBranch: "refs/heads/main" });
      }
      if (path.endsWith("/refs")) {
        return json({
          value: [{ name: "refs/heads/main", objectId: "head-commit" }],
        });
      }
      if (path.endsWith("/items") && url.searchParams.get("includeContent") === "true") {
        return json({ content: "export const remaining = true;" });
      }
      if (path.endsWith("/items")) {
        return json({
          value: [{ path: "/src/remaining.ts", objectId: "remaining-blob-id" }],
        });
      }
      if (path.endsWith("/commits")) {
        return json({ value: [] });
      }
      if (path.endsWith("/pullrequests")) {
        return json({ value: [] });
      }
      if (path.endsWith("/_apis/wit/wiql") && init?.method === "POST") {
        return json({ workItems: [] });
      }
      if (path.endsWith("/_apis/wit/workitems")) {
        return json({ value: [] });
      }
      return Promise.reject(
        new Error(`Unexpected request: ${init?.method ?? "GET"} ${url.toString()}`),
      );
    });
    const client = new AzureDevOpsClient(
      "https://dev.azure.com/example",
      { getAzureDevOpsToken: () => Promise.resolve("token") },
      fetcher,
    );
    const connector = new AzureDevOpsSourceConnector(client, config());

    const delta = await connector.fetchDelta(
      {
        defaultBranch: "main",
        defaultBranchSha: "old-head",
        entities: {
          "/src/remaining.ts": "remaining-blob-id:previous-hash",
          "/src/removed.ts": "removed-blob-id:removed-hash",
          "work-item:9": "9:work-item-hash",
          "commit:historic": "historic:commit-hash",
        },
      },
      true,
    );

    expect(delta.tombstones).toEqual(
      expect.arrayContaining([
        {
          sourceRef: "/src/removed.ts",
          revision: "head-commit",
          reason: "deleted",
        },
        {
          sourceRef: "work-item:9",
          revision: "head-commit",
          reason: "deleted",
        },
      ]),
    );
    expect(delta.tombstones.some((item) => item.sourceRef === "commit:historic")).toBe(false);
    const entities = delta.candidateCheckpoint.entities as Record<string, string | undefined>;
    expect(entities).toMatchObject({
      "commit:historic": "historic:commit-hash",
    });
    expect(entities["work-item:9"]).toBeUndefined();
  });

  it("bounds concurrent file downloads and PR enrichment", async () => {
    let fileInflight = 0;
    let maxFileInflight = 0;
    let prInflight = 0;
    let maxPrInflight = 0;
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url =
        typeof input === "string"
          ? new URL(input)
          : input instanceof URL
            ? input
            : new URL(input.url);
      const path = url.pathname;
      if (path.endsWith("/_apis/git/repositories/repo")) {
        return json({ id: "repo-id", defaultBranch: "refs/heads/main" });
      }
      if (path.endsWith("/refs")) {
        return json({
          value: [{ name: "refs/heads/main", objectId: "head-commit" }],
        });
      }
      if (path.endsWith("/items") && url.searchParams.get("includeContent") === "true") {
        fileInflight += 1;
        maxFileInflight = Math.max(maxFileInflight, fileInflight);
        return delayedJson(
          { content: `export const file = ${JSON.stringify(url.searchParams.get("path"))};` },
          10,
          () => {
            fileInflight -= 1;
          },
        );
      }
      if (path.endsWith("/items")) {
        return json({
          value: Array.from({ length: 6 }, (_, index) => ({
            path: `/src/file-${String(index)}.ts`,
            objectId: `blob-${String(index)}`,
          })),
        });
      }
      if (path.endsWith("/commits")) {
        return json({ value: [] });
      }
      if (path.endsWith("/pullrequests")) {
        return json({
          value: Array.from({ length: 6 }, (_, index) => ({
            pullRequestId: index + 1,
            title: `PR ${String(index + 1)}`,
            lastMergeSourceCommit: { commitId: `merge-${String(index + 1)}` },
            url: "ignored",
          })),
        });
      }
      if (/\/pullrequests\/\d+$/.test(path)) {
        prInflight += 1;
        maxPrInflight = Math.max(maxPrInflight, prInflight);
        const id = Number(path.split("/").at(-1));
        return delayedJson(
          {
            pullRequestId: id,
            title: `PR ${String(id)}`,
            description: `Description ${String(id)}`,
            lastMergeSourceCommit: { commitId: `merge-${String(id)}` },
            url: "ignored",
          },
          10,
          () => {
            prInflight -= 1;
          },
        );
      }
      if (
        /\/pullrequests\/\d+\/workitems$/.test(path) ||
        /\/pullrequests\/\d+\/commits$/.test(path)
      ) {
        return json({ value: [] });
      }
      if (path.endsWith("/_apis/wit/wiql") && init?.method === "POST") {
        return json({ workItems: [] });
      }
      if (path.endsWith("/_apis/wit/workitems")) {
        return json({ value: [] });
      }
      return Promise.reject(
        new Error(`Unexpected request: ${init?.method ?? "GET"} ${url.toString()}`),
      );
    });
    const client = new AzureDevOpsClient(
      "https://dev.azure.com/example",
      { getAzureDevOpsToken: () => Promise.resolve("token") },
      fetcher,
    );
    const connector = new AzureDevOpsSourceConnector(client, config());

    await connector.fetchDelta(null, true);

    expect(maxFileInflight).toBeGreaterThan(1);
    expect(maxFileInflight).toBeLessThanOrEqual(4);
    expect(maxPrInflight).toBeGreaterThan(1);
    expect(maxPrInflight).toBeLessThanOrEqual(4);
  });
});

function json(body: unknown): Promise<Response> {
  return Promise.resolve(Response.json(body));
}

function delayedJson(body: unknown, delayMs: number, onSettled: () => void): Promise<Response> {
  return new Promise((resolve) => {
    setTimeout(() => {
      onSettled();
      resolve(Response.json(body));
    }, delayMs);
  });
}

function config() {
  return edgarConfigSchema.parse({
    schemaVersion: 1,
    azureDevOps: {
      organization: "https://dev.azure.com/example",
      project: "project",
      repository: "repo",
      historyFrom: "2025-01-01T00:00:00.000Z",
      workItemTypes: {
        Epic: "epic",
        Feature: "feature",
        Requirement: "requirement",
        "User Story": "user_story",
        Bug: "bug",
      },
      fields: {
        title: "System.Title",
        description: "System.Description",
        acceptanceCriteria: "Custom.AcceptanceCriteria",
        state: "System.State",
        tags: "System.Tags",
        ownership: "System.AssignedTo",
      },
    },
    azureOpenAI: {
      endpoint: "https://example.openai.azure.com",
      generationDeployment: "generation",
      embeddingDeployment: "embedding",
      embeddingDimensions: 1536,
    },
    source: { include: ["**/*"] },
    documentation: {},
  });
}
