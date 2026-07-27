import { describe, expect, it, vi } from "vitest";
import { JiraClient } from "../../src/jira/client.js";

describe("JiraClient contract", () => {
  it("retries bounded transient failures and exposes sanitized errors", async () => {
    const retries: unknown[] = [];
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("do not expose this", {
          status: 429,
          headers: { "retry-after": "0.001" },
        }),
      )
      .mockResolvedValueOnce(Response.json({ accountId: "ok" }));
    const client = new JiraClient("cloud", "token", fetcher, 1, (event) => retries.push(event));

    await expect(client.get("/rest/api/3/myself")).resolves.toEqual({ accountId: "ok" });
    expect(retries).toEqual([{ status: 429, attempt: 1, delayMs: 1 }]);

    const denied = new JiraClient(
      "cloud",
      "token",
      vi.fn<typeof fetch>().mockResolvedValue(new Response("credential body", { status: 403 })),
      0,
    );
    await expect(denied.get("/rest/api/3/myself")).rejects.toEqual(
      expect.objectContaining({
        message: "Jira request failed (403)",
        status: 403,
        retryable: false,
      }),
    );
  });
});
