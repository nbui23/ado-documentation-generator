import { describe, expect, it } from "vitest";
import {
  classifyPath,
  classifySourceChange,
  computeImpact,
  sectionFingerprint,
} from "../../src/incremental/impact.js";
import { SECTION_CATALOG } from "../../src/render/catalog.js";

describe("incremental impact", () => {
  it("makes fingerprints independent of evidence input order", () => {
    const common = {
      configVersion: "1",
      templateVersion: "1",
      promptVersion: "1",
      generationDeployment: "g",
      embeddingDeployment: "e",
    };
    expect(sectionFingerprint({ ...common, evidenceRevisions: ["b", "a"] })).toBe(
      sectionFingerprint({ ...common, evidenceRevisions: ["a", "b"] }),
    );
  });

  it("does not invalidate business requirements for code-only changes", () => {
    const impact = computeImpact(
      [{ sourceRef: "src/a.ts", changeClass: "code", path: "src/a.ts" }],
      [],
      SECTION_CATALOG,
    );
    expect(impact.affectedSections).toContain("developer/overview");
    expect(impact.affectedSections).toContain("developer/apis-and-data");
    expect(impact.affectedSections).toContain("business/traceability");
    expect(impact.untouchedSections).toContain("developer/configuration");
    expect(impact.untouchedSections).toContain("business/requirements");
  });

  it.each([
    ["package.json", "manifest"],
    ["/services/api/pom.xml", "manifest"],
    ["src/widget.test.ts", "test"],
    ["config/application.yaml", "config"],
    ["src/widget.ts", "code"],
  ] as const)("classifies %s as %s", (path, expected) => {
    expect(classifyPath(path)).toBe(expected);
  });

  it("classifies source identities before impact planning", () => {
    expect(classifySourceChange("work-item:42")).toEqual({
      sourceRef: "work-item:42",
      changeClass: "work_item",
    });
    expect(classifySourceChange("commit:abc")).toEqual({
      sourceRef: "commit:abc",
      changeClass: "history",
    });
    expect(classifySourceChange("/package-lock.json")).toEqual({
      sourceRef: "/package-lock.json",
      changeClass: "manifest",
      path: "package-lock.json",
    });
  });

  it("targets manifest changes to setup-related documentation", () => {
    const impact = computeImpact([classifySourceChange("package.json")], [], SECTION_CATALOG);
    expect(impact.affectedSections).toEqual([
      "business/traceability",
      "developer/configuration",
      "developer/dependencies-and-integrations",
      "developer/getting-started",
      "developer/repository-structure",
      "developer/testing",
      "developer/troubleshooting-and-limitations",
    ]);
    expect(impact.untouchedSections).toContain("developer/apis-and-data");
    expect(impact.untouchedSections).toContain("business/features");
  });

  it("targets work item changes to intent and traceability sections", () => {
    const impact = computeImpact([classifySourceChange("work-item:42")], ["42"], SECTION_CATALOG);
    expect(impact.affectedSections).toEqual([
      "business/business-rules",
      "business/features",
      "business/overview",
      "business/requirements",
      "business/traceability",
      "business/workflows",
    ]);
    expect(impact.untouchedSections).toContain("business/feature-history");
    expect(impact.untouchedSections).toContain("developer/overview");
  });
});
