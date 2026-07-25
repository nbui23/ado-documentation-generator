import { describe, expect, it, vi } from "vitest";
import { AzureDevOpsClient } from "../../src/ado/client.js";
import { validateClaims } from "../../src/evidence/claims.js";
import { redactText } from "../../src/security/redaction.js";

describe("security trust boundaries", () => {
  it("rejects non-Azure hosts before acquiring or sending a token", async () => {
    const token = vi.fn(() => Promise.resolve("secret-token"));
    const fetcher = vi.fn<typeof fetch>();
    const client = new AzureDevOpsClient(
      "https://attacker.example/org",
      {
        getAzureDevOpsToken: token,
      },
      fetcher,
    );
    await expect(client.get("_apis/projects")).rejects.toThrow(/dev\.azure\.com/);
    expect(token).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects absolute cross-origin request paths", async () => {
    const client = new AzureDevOpsClient("https://dev.azure.com/example", {
      getAzureDevOpsToken: () => Promise.resolve("secret-token"),
    });
    await expect(client.get("https://attacker.example/collect")).rejects.toThrow(/Absolute/);
  });

  it("redacts common provider secret variants", () => {
    for (const value of [
      "OPENAI_API_KEY=sk-secret",
      "AZURE_OPENAI_API_KEY=secret",
      "CLIENT_SECRET=secret",
      "SERVICE_TOKEN=secret",
    ]) {
      expect(redactText(value)).not.toContain("secret");
    }
  });

  it("requires the quote-bearing evidence to be cited", () => {
    const evidence = [
      {
        id: "a",
        sourceRef: "a",
        revision: "1",
        sourceType: "code" as const,
        locator: "L1",
        pinnedUrl: "https://dev.azure.com/o/p/_git/r?version=GC1",
        excerptHash: "a",
        text: "unrelated",
      },
      {
        id: "b",
        sourceRef: "b",
        revision: "1",
        sourceType: "code" as const,
        locator: "L2",
        pinnedUrl: "https://dev.azure.com/o/p/_git/r?version=GC1",
        excerptHash: "b",
        text: "actual support",
      },
    ];
    const result = validateClaims(
      [
        {
          text: "claim",
          claimKind: "fact",
          evidenceLens: "implementation",
          evidenceIds: ["a"],
          supportingQuotes: [{ evidenceId: "b", locator: "L2", quote: "actual support" }],
        },
      ],
      evidence,
    );
    expect(result.claims).toHaveLength(0);
  });
});
