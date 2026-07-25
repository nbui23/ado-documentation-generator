import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../../src/render/markdown.js";

describe("Markdown rendering", () => {
  it("renders stable citations without internal quotes", () => {
    const evidence = [
      {
        id: "ev",
        sourceRef: "src/a.ts",
        revision: "abc",
        sourceType: "code" as const,
        locator: "L1",
        pinnedUrl: "https://dev.azure.com/o/p/_git/r?path=a&version=GCabc",
        excerptHash: "h",
      },
    ];
    const claim = [
      {
        text: "The service retries.",
        claimKind: "fact" as const,
        evidenceLens: "implementation" as const,
        evidenceIds: ["ev"],
        supportingQuotes: [{ evidenceId: "ev", locator: "L1", quote: "secret internal quote" }],
      },
    ];
    const rendered = renderMarkdown("Overview", claim, evidence);
    expect(rendered).toContain("[^e1]");
    expect(rendered).not.toContain("secret internal quote");
    expect(rendered).not.toMatch(/generated at/i);
  });

  it("renders model-controlled text literally without HTML, links, or autolinks", () => {
    const evidence = [
      {
        id: "ev",
        sourceRef: "<img src=x onerror=alert(1)>",
        revision: "abc",
        sourceType: "code" as const,
        locator: "[label](https://attacker.example)",
        pinnedUrl: "https://dev.azure.com/o/p/_git/r?path=a&version=GCabc",
        excerptHash: "h",
      },
    ];
    const claims = [
      {
        text: [
          "<script>alert(1)</script>",
          "[click](https://attacker.example)",
          "<https://attacker.example>",
          "https://attacker.example",
          "![image](https://attacker.example/pixel)",
          "\n[^e1]: forged citation",
        ].join(" "),
        claimKind: "fact" as const,
        evidenceLens: "implementation" as const,
        evidenceIds: ["ev"],
        supportingQuotes: [],
      },
    ];

    const rendered = renderMarkdown("<em>Overview</em>", claims, evidence);

    expect(rendered).not.toContain("<script>");
    expect(rendered).not.toContain("<em>");
    expect(rendered).not.toContain("](https://attacker.example");
    expect(rendered).not.toContain("<https://attacker.example");
    expect(rendered).not.toContain("https://attacker.example");
    expect(rendered).toContain("\\<script\\>");
    expect(rendered).toContain("https\\:\\/\\/attacker\\.example");
    expect(rendered.match(/\\n/g)).toBeNull();
    expect(rendered).toContain("](<https://dev.azure.com/o/p/_git/r?path=a&version=GCabc>)");
  });

  it("rejects unpinned, credential-bearing, and non-Azure evidence URLs", () => {
    const claim = {
      text: "claim",
      claimKind: "fact" as const,
      evidenceLens: "implementation" as const,
      supportingQuotes: [],
    };
    const evidence = [
      {
        id: "unpinned",
        sourceRef: "a",
        revision: "1",
        sourceType: "code" as const,
        locator: "L1",
        pinnedUrl: "https://dev.azure.com/o/p/_git/r",
        excerptHash: "a",
      },
      {
        id: "credentials",
        sourceRef: "b",
        revision: "1",
        sourceType: "code" as const,
        locator: "L1",
        pinnedUrl: "https://user:password@dev.azure.com/o/p/_git/r?version=GC1",
        excerptHash: "b",
      },
      {
        id: "foreign",
        sourceRef: "c",
        revision: "1",
        sourceType: "code" as const,
        locator: "L1",
        pinnedUrl: "https://attacker.example/?version=GC1",
        excerptHash: "c",
      },
    ];

    const rendered = renderMarkdown(
      "Overview",
      evidence.map((item) => ({ ...claim, evidenceIds: [item.id] })),
      evidence,
    );

    expect(rendered).toContain("_No validated claims are currently available._");
    expect(rendered).not.toContain("password");
    expect(rendered).not.toContain("attacker.example");
  });
});
