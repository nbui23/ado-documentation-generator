import { describe, expect, it, vi } from "vitest";
import { JiraClient } from "../../src/jira/client.js";
import { adfToText, JiraSourceConnector } from "../../src/jira/source-connector.js";

const config = {
  cloudId: "cloud",
  siteUrl: "https://example.atlassian.net",
  jql: "project = DOC",
  issueTypes: { Story: "user_story" },
  fields: {
    title: "summary",
    description: "description",
    acceptanceCriteria: "customfield_1",
    state: "status",
    tags: "labels",
    ownership: "assignee",
  },
};

describe("JiraSourceConnector", () => {
  it("normalizes ADF recursively", () => {
    expect(
      adfToText({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "First" }] },
          {
            type: "mystery",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Second" }] }],
          },
        ],
      }),
    ).toBe("First\n\nSecond\n");
  });

  it("creates namespaced snapshots and paginates changelogs", async () => {
    const client = {
      get: vi.fn((_path: string, query?: Record<string, string>) => {
        if (query?.startAt === "0") {
          return Promise.resolve({
            startAt: 0,
            maxResults: 1,
            total: 2,
            values: [
              {
                created: "2026-01-01T00:00:00Z",
                items: [{ fieldId: "status", fromString: "Open", toString: "Done" }],
              },
            ],
          });
        }
        return Promise.resolve({
          startAt: 1,
          maxResults: 1,
          total: 2,
          values: [{ created: "later", items: [{ fieldId: "comment", toString: "secret" }] }],
        });
      }),
      post: vi.fn(() =>
        Promise.resolve({
          isLast: true,
          issues: [
            {
              key: "doc-7",
              fields: {
                issuetype: { name: "Story" },
                updated: "2026-01-02T00:00:00Z",
                summary: "A title",
                description: {
                  type: "doc",
                  content: [{ type: "paragraph", content: [{ type: "text", text: "Details" }] }],
                },
                status: { name: "Done" },
              },
            },
          ],
        }),
      ),
    };
    const connector = new JiraSourceConnector(
      client as never,
      config,
      () => new Date("2026-01-03T00:00:00Z"),
    );

    const result = await connector.fetchDelta(null, true);

    expect(result.snapshots[0]).toMatchObject({
      sourceRef: "work-item:jira:DOC-7",
      revision: "2026-01-02T00:00:00Z",
      sourceType: "work_item",
      pinnedUrl: "https://example.atlassian.net/browse/DOC-7",
    });
    expect(result.snapshots[0]?.redactedContent).toContain('"description": "Details"');
    expect(result.snapshots[0]?.redactedContent).not.toContain("secret");
    expect(client.get).toHaveBeenCalledTimes(2);
  });

  it("uses overlap incrementally and tombstones only on full runs", async () => {
    const client = {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue({ isLast: true, issues: [] }),
    };
    const connector = new JiraSourceConnector(client as never, config);
    const checkpoint = {
      watermark: "2026-01-02T00:05:00Z",
      entities: { "work-item:jira:DOC-1": "revision:hash" },
    };

    const incremental = await connector.fetchDelta(checkpoint, false);
    expect(incremental.tombstones).toEqual([]);
    expect(JSON.stringify(client.post.mock.calls[0]?.[1])).toContain(
      'updated >= \\"2026-01-02 00:00\\"',
    );

    const full = await connector.fetchDelta(checkpoint, true);
    expect(full.tombstones).toMatchObject([
      { sourceRef: "work-item:jira:DOC-1", reason: "deleted" },
    ]);
  });
});

describe("JiraClient", () => {
  it("confines requests and sends bearer authentication", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ ok: true }));
    const client = new JiraClient("cloud-id", "token", fetcher);

    await client.get("/rest/api/3/myself");

    const [url, init] = fetcher.mock.calls[0]!;
    expect((url as URL).toString()).toBe(
      "https://api.atlassian.com/ex/jira/cloud-id/rest/api/3/myself",
    );
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer token");
    expect(() => client.get("https://evil.example/path")).toThrow(
      "Absolute Jira request paths are forbidden",
    );
  });
});
