import { describe, expect, it, vi } from "vitest";
import { AzureDevOpsClient } from "../../src/ado/client.js";

describe("AzureDevOpsClient", () => {
  it("follows continuation headers and pins API 7.1", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: [1] }), {
          status: 200,
          headers: { "x-ms-continuationtoken": "next" },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ value: [2] }), { status: 200 }));
    const client = new AzureDevOpsClient(
      "https://dev.azure.com/example",
      { getAzureDevOpsToken: () => Promise.resolve("token") },
      fetcher,
    );
    const values: number[] = [];
    for await (const page of client.pages<number>("project/_apis/test")) values.push(...page);
    expect(values).toEqual([1, 2]);
    expect((fetcher.mock.calls[0]?.[0] as URL).toString()).toContain("api-version=7.1");
    expect((fetcher.mock.calls[1]?.[0] as URL).toString()).toContain("continuationToken=next");
  });

  it("honors Retry-After and reports bounded retry metadata", async () => {
    const retries: Array<{ status: number; attempt: number; delayMs: number }> = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("rate limited", { status: 429, headers: { "retry-after": "0.001" } }),
      )
      .mockResolvedValueOnce(Response.json({ value: [] }));
    const client = new AzureDevOpsClient(
      "https://dev.azure.com/example",
      { getAzureDevOpsToken: () => Promise.resolve("token") },
      fetcher,
      1,
      (event) => retries.push(event),
    );

    await client.get("project/_apis/test");

    expect(retries).toEqual([{ status: 429, attempt: 1, delayMs: 1 }]);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
