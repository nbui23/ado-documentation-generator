import { describe, expect, it } from "vitest";
import { fragmentEvidence } from "../../src/evidence/fragments.js";
import { validateClaims } from "../../src/evidence/claims.js";

describe("evidence", () => {
  it("fragments deterministically", () => {
    const input = {
      sourceRef: "src/a.ts",
      revision: "abc",
      sourceType: "code" as const,
      locator: "L1-L3",
      pinnedUrl: "https://dev.azure.com/o/p/_git/r?path=a&version=GCabc",
      redactedContent: "one\n\ntwo",
      contentHash: "hash",
    };
    expect(fragmentEvidence(input)).toEqual(fragmentEvidence(input));
  });

  it("hard-splits oversized paragraphs so no fragment exceeds the maximum size", () => {
    const fragments = fragmentEvidence(
      {
        sourceRef: "src/a.ts",
        revision: "abc",
        sourceType: "code" as const,
        locator: "L1-L50",
        pinnedUrl: "https://dev.azure.com/o/p/_git/r?path=a&version=GCabc",
        redactedContent: `alpha\n${"x".repeat(35)}\n${"y".repeat(35)}`,
        contentHash: "hash",
      },
      20,
    );

    expect(fragments).not.toHaveLength(0);
    expect(fragments.every((fragment) => fragment.text.length <= 20)).toBe(true);
    expect(fragments.map((fragment) => fragment.text)).toEqual([
      "alpha",
      "xxxxxxxxxxxxxxxxxxxx",
      "xxxxxxxxxxxxxxx",
      "yyyyyyyyyyyyyyyyyyyy",
      "yyyyyyyyyyyyyyy",
    ]);
  });

  it("falls back to the default fragment bound for invalid sizes", () => {
    const [fragment] = fragmentEvidence(
      {
        sourceRef: "src/a.ts",
        revision: "abc",
        sourceType: "code" as const,
        locator: "L1",
        pinnedUrl: "https://dev.azure.com/o/p/_git/r?path=a&version=GCabc",
        redactedContent: "content",
        contentHash: "hash",
      },
      0,
    );

    expect(fragment?.text).toBe("content");
  });

  it("downgrades unsupported claims to gaps", () => {
    const evidence = {
      id: "ev",
      sourceRef: "a",
      revision: "1",
      sourceType: "code" as const,
      locator: "L1",
      pinnedUrl: "https://example.test/a",
      excerptHash: "h",
      text: "The service retries requests.",
    };
    const result = validateClaims(
      [
        {
          text: "It retries forever.",
          claimKind: "fact",
          evidenceLens: "implementation",
          evidenceIds: ["ev"],
          supportingQuotes: [{ evidenceId: "ev", locator: "L1", quote: "not present" }],
        },
      ],
      [evidence],
    );
    expect(result.claims).toHaveLength(0);
    expect(result.gaps).toEqual(["It retries forever."]);
  });

  it("requires every citation to have an exact quote and match the declared evidence lens", () => {
    const implementation = {
      id: "code",
      sourceRef: "src/a.ts",
      revision: "1",
      sourceType: "code" as const,
      locator: "L1",
      pinnedUrl: "https://dev.azure.com/o/p/_git/r?version=GC1",
      excerptHash: "code",
      text: "The service retries.",
    };
    const intent = {
      ...implementation,
      id: "requirement",
      sourceRef: "work-item:1",
      sourceType: "work_item" as const,
      locator: "work item 1",
      excerptHash: "requirement",
      text: "The service should retry.",
    };
    const result = validateClaims(
      [
        {
          text: "The service retries.",
          claimKind: "fact",
          evidenceLens: "implementation",
          evidenceIds: ["code", "requirement"],
          supportingQuotes: [{ evidenceId: "code", locator: "L1", quote: "service retries" }],
        },
      ],
      [implementation, intent],
    );

    expect(result.claims).toEqual([]);
  });

  it("requires conflicts to cite exact evidence from more than one lens", () => {
    const evidence = [
      {
        id: "intent",
        sourceRef: "work-item:1",
        revision: "1",
        sourceType: "work_item" as const,
        locator: "WI1",
        pinnedUrl: "https://dev.azure.com/o/p/_workitems/edit/1?version=1",
        excerptHash: "i",
        text: "Retries are required.",
      },
      {
        id: "code",
        sourceRef: "src/a.ts",
        revision: "1",
        sourceType: "code" as const,
        locator: "L1",
        pinnedUrl: "https://dev.azure.com/o/p/_git/r?version=GC1",
        excerptHash: "c",
        text: "Retries are disabled.",
      },
    ];
    const result = validateClaims(
      [
        {
          text: "Intent requires retries, while implementation disables them.",
          claimKind: "conflict",
          evidenceLens: "intent",
          evidenceIds: ["intent", "code"],
          supportingQuotes: [
            { evidenceId: "intent", locator: "WI1", quote: "Retries are required." },
            { evidenceId: "code", locator: "L1", quote: "Retries are disabled." },
          ],
        },
      ],
      evidence,
    );

    expect(result.claims).toHaveLength(1);
  });
});
