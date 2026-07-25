import { describe, expect, it, vi } from "vitest";
import { AzureDevOpsClient } from "../../src/ado/client.js";
import { AzureDevOpsPublisher } from "../../src/publication/azure-devops-publisher.js";
import { contentHash } from "../../src/publication/state.js";

describe("Azure DevOps publication contract", () => {
  it("probes every required publication permission without mutating the repository", async () => {
    const requests: Array<{ method: string; url: string }> = [];
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({ method: init?.method ?? "GET", url });
      if (url.includes("/refs")) {
        return Promise.resolve(
          Response.json({
            value: [{ name: "refs/heads/main", objectId: "targethead" }],
          }),
        );
      }
      if (url.includes("/_apis/git/repositories/repo")) {
        return Promise.resolve(Response.json({ id: "repo-id", project: { id: "project-id" } }));
      }
      if (url.includes("/_apis/permissions/")) {
        return Promise.resolve(Response.json({ value: [true] }));
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    const publisher = new AzureDevOpsPublisher(
      new AzureDevOpsClient(
        "https://dev.azure.com/org",
        { getAzureDevOpsToken: () => Promise.resolve("token") },
        fetcher,
      ),
      "project",
      "repo",
      "refs/heads/main",
      "generated-docs",
    );

    await publisher.probe();

    expect(requests.every((request) => request.method === "GET")).toBe(true);
    expect(requests.find((request) => request.url.includes("/_apis/permissions/"))?.url).toContain(
      "tokens=repoV2%2Fproject-id%2Frepo-id",
    );
  });

  it("preserves a manually edited file and human PR description text", async () => {
    const requests: { method: string; url: string; body: string | undefined }[] = [];
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      requests.push({ method: init?.method ?? "GET", url, body: init?.body as string | undefined });
      if (url.includes("/refs")) {
        return Promise.resolve(
          Response.json({
            value: [
              {
                name: url.includes("heads%2Fdocs") ? "refs/heads/docs" : "refs/heads/main",
                objectId: url.includes("heads%2Fdocs") ? "docshead" : "targethead",
              },
            ],
          }),
        );
      }
      if (url.includes("/items")) return Promise.resolve(Response.json({ content: "human edit" }));
      if (url.includes("/pullrequests?")) {
        return Promise.resolve(
          Response.json({
            value: [
              {
                pullRequestId: 7,
                status: "active",
                sourceRefName: "refs/heads/docs",
                targetRefName: "refs/heads/main",
              },
            ],
          }),
        );
      }
      if (url.includes("/pullrequests/7") && init?.method === "GET") {
        return Promise.resolve(
          Response.json({
            pullRequestId: 7,
            status: "active",
            description: "Human intro\n\n<!-- agent-docs:start -->\nold\n<!-- agent-docs:end -->",
          }),
        );
      }
      if (url.includes("/pullrequests/7") && init?.method === "PATCH") {
        return Promise.resolve(Response.json({ pullRequestId: 7, status: "active" }));
      }
      return Promise.reject(new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`));
    });
    const client = new AzureDevOpsClient(
      "https://dev.azure.com/org",
      { getAzureDevOpsToken: () => Promise.resolve("token") },
      fetcher,
    );
    const publisher = new AzureDevOpsPublisher(
      client,
      "project",
      "repo",
      "refs/heads/main",
      "generated-docs",
    );
    const state = await publisher.publish(
      { "README.md": "new generated" },
      {
        pullRequestId: 7,
        pullRequestStatus: "active",
        lifecycleBranch: "refs/heads/docs",
        targetHead: "oldtarget",
        generatorFileHashes: { "README.md": contentHash("old generated") },
        pendingConflicts: [],
      },
    );
    expect(state.pendingConflicts).toEqual(["README.md"]);
    expect(requests.some((request) => request.url.includes("/pushes"))).toBe(false);
    const patch = requests.find((request) => request.method === "PATCH");
    expect(patch?.body).toContain("Human intro");
    expect(patch?.body).toContain("Manual conflicts preserved");
  });

  it("preserves unowned target files without creating an empty lifecycle", async () => {
    const requests: { method: string; url: string }[] = [];
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      requests.push({ method, url });
      if (url.includes("/refs")) {
        return Promise.resolve(
          Response.json({
            value: [{ name: "refs/heads/main", objectId: "targethead" }],
          }),
        );
      }
      if (url.includes("/pullrequests?")) return Promise.resolve(Response.json({ value: [] }));
      if (url.includes("/items")) {
        return Promise.resolve(Response.json({ content: "maintainer-authored documentation" }));
      }
      return Promise.reject(new Error(`Unexpected request: ${method} ${url}`));
    });
    const publisher = new AzureDevOpsPublisher(
      new AzureDevOpsClient(
        "https://dev.azure.com/org",
        { getAzureDevOpsToken: () => Promise.resolve("token") },
        fetcher,
      ),
      "project",
      "repo",
      "refs/heads/main",
      "generated-docs",
    );

    const state = await publisher.publish({ "README.md": "generated" }, null);

    expect(state.pendingConflicts).toEqual(["README.md"]);
    expect(state.pullRequestId).toBeUndefined();
    expect(requests.every(({ method }) => method === "GET")).toBe(true);
  });

  it("adds configured reviewers when creating a draft pull request", async () => {
    const requests: { method: string; url: string; body: string | undefined }[] = [];
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      requests.push({ method, url, body: init?.body as string | undefined });
      if (method === "GET" && url.includes("/refs")) {
        return Promise.resolve(
          Response.json({
            value: [{ name: "refs/heads/main", objectId: "targethead123456" }],
          }),
        );
      }
      if (method === "GET" && url.includes("/pullrequests?")) {
        return Promise.resolve(Response.json({ value: [] }));
      }
      if (method === "GET" && url.includes("/items")) {
        return Promise.resolve(Response.json({}, { status: 404 }));
      }
      if (method === "POST" && url.includes("/refs")) {
        return Promise.resolve(Response.json({ value: [] }));
      }
      if (method === "POST" && url.includes("/pushes")) {
        return Promise.resolve(Response.json({ pushId: 1 }));
      }
      if (method === "POST" && url.includes("/pullrequests")) {
        return Promise.resolve(Response.json({ pullRequestId: 42, status: "active" }));
      }
      return Promise.reject(new Error(`Unexpected request: ${method} ${url}`));
    });
    const publisher = new AzureDevOpsPublisher(
      new AzureDevOpsClient(
        "https://dev.azure.com/org",
        { getAzureDevOpsToken: () => Promise.resolve("token") },
        fetcher,
      ),
      "project",
      "repo",
      "refs/heads/main",
      "generated-docs",
      ["reviewer-one", "reviewer-two"],
    );

    const state = await publisher.publish({ "README.md": "generated" }, null);

    expect(state.pullRequestId).toBe(42);
    const create = requests.find(
      ({ method, url }) => method === "POST" && url.includes("/pullrequests"),
    );
    expect(JSON.parse(create?.body ?? "{}")).toMatchObject({
      isDraft: true,
      reviewers: [{ id: "reviewer-one" }, { id: "reviewer-two" }],
    });
  });

  it("discovers and reuses an active managed lifecycle when local state is missing", async () => {
    const requests: { method: string; url: string }[] = [];
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const method = init?.method ?? "GET";
      requests.push({ method, url });
      if (method === "GET" && url.includes("/refs")) {
        const lifecycle = url.includes("agent-docs");
        return Promise.resolve(
          Response.json({
            value: [
              {
                name: lifecycle ? "refs/heads/agent-docs/existing" : "refs/heads/main",
                objectId: lifecycle ? "lifecyclehead" : "targethead",
              },
            ],
          }),
        );
      }
      if (method === "GET" && url.includes("/pullrequests?")) {
        return Promise.resolve(
          Response.json({
            value: [
              {
                pullRequestId: 9,
                status: "active",
                sourceRefName: "refs/heads/agent-docs/existing",
                targetRefName: "refs/heads/main",
              },
            ],
          }),
        );
      }
      if (method === "GET" && url.includes("/items")) {
        return Promise.resolve(Response.json({}, { status: 404 }));
      }
      if (method === "POST" && url.includes("/pushes")) {
        return Promise.resolve(Response.json({ pushId: 1 }));
      }
      if (method === "GET" && url.includes("/pullrequests/9")) {
        return Promise.resolve(
          Response.json({ pullRequestId: 9, status: "active", description: "Human context" }),
        );
      }
      if (method === "PATCH" && url.includes("/pullrequests/9")) {
        return Promise.resolve(Response.json({ pullRequestId: 9, status: "active" }));
      }
      return Promise.reject(new Error(`Unexpected request: ${method} ${url}`));
    });
    const publisher = new AzureDevOpsPublisher(
      new AzureDevOpsClient(
        "https://dev.azure.com/org",
        { getAzureDevOpsToken: () => Promise.resolve("token") },
        fetcher,
      ),
      "project",
      "repo",
      "refs/heads/main",
      "generated-docs",
    );

    const state = await publisher.publish({ "README.md": "generated" }, null);

    expect(state.pullRequestId).toBe(9);
    expect(state.lifecycleBranch).toBe("refs/heads/agent-docs/existing");
    expect(requests.some(({ method, url }) => method === "POST" && url.includes("/refs"))).toBe(
      false,
    );
    expect(requests.some(({ method, url }) => method === "POST" && url.includes("/pushes"))).toBe(
      true,
    );
  });

  it("refuses to create another PR when multiple managed lifecycles are active", async () => {
    const fetcher = vi.fn<typeof fetch>((input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes("/refs")) {
        return Promise.resolve(
          Response.json({
            value: [{ name: "refs/heads/main", objectId: "targethead" }],
          }),
        );
      }
      if (url.includes("/pullrequests?")) {
        return Promise.resolve(
          Response.json({
            value: [1, 2].map((pullRequestId) => ({
              pullRequestId,
              status: "active",
              sourceRefName: `refs/heads/agent-docs/${String(pullRequestId)}`,
              targetRefName: "refs/heads/main",
            })),
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`));
    });
    const publisher = new AzureDevOpsPublisher(
      new AzureDevOpsClient(
        "https://dev.azure.com/org",
        { getAzureDevOpsToken: () => Promise.resolve("token") },
        fetcher,
      ),
      "project",
      "repo",
      "refs/heads/main",
      "generated-docs",
    );

    await expect(publisher.publish({ "README.md": "generated" }, null)).rejects.toThrow(
      "Multiple active agent-docs pull requests",
    );
  });
});
