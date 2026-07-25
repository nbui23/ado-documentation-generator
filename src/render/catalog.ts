import type { SectionDefinition } from "../domain/types.js";

const implementationEvidence = [
  "code",
  "test",
  "pull_request",
  "commit",
  "existing_document",
] as const;
const intentEvidence = [
  "work_item",
  "pull_request",
  "commit",
  "code",
  "existing_document",
] as const;

export const SECTION_CATALOG: readonly SectionDefinition[] = [
  {
    key: "index",
    outputPath: "README.md",
    allowedEvidenceClasses: [],
    invalidationRules: [{ changeClass: "gap" }],
  },
  {
    key: "gaps",
    outputPath: "gaps.md",
    allowedEvidenceClasses: [],
    invalidationRules: [{ changeClass: "gap" }],
  },
  developerSection("overview", ["code", "history"]),
  developerSection("getting-started", ["manifest", "config"]),
  developerSection("repository-structure", ["code", "manifest", "config", "test"]),
  developerSection("apis-and-data", ["code", "history"]),
  developerSection("configuration", ["config", "manifest"]),
  developerSection("testing", ["test", "config", "manifest"]),
  developerSection("dependencies-and-integrations", ["manifest", "config"]),
  developerSection("troubleshooting-and-limitations", [
    "code",
    "manifest",
    "config",
    "test",
    "history",
  ]),
  businessSection("overview", ["work_item", "history"]),
  businessSection("features", ["work_item"]),
  businessSection("requirements", ["work_item"]),
  businessSection("business-rules", ["work_item"]),
  businessSection("workflows", ["work_item"]),
  businessSection("feature-history", ["history"]),
  businessSection("traceability", ["code", "manifest", "config", "test", "work_item", "history"]),
];

function developerSection(
  key: string,
  changeClasses: readonly import("../domain/types.js").ChangeClass[],
): SectionDefinition {
  return {
    key: `developer/${key}`,
    outputPath: `developer/${key}.md`,
    allowedEvidenceClasses: implementationEvidence,
    invalidationRules: changeClasses.map((changeClass) => ({ changeClass })),
  };
}

function businessSection(
  key: string,
  changeClasses: readonly import("../domain/types.js").ChangeClass[],
): SectionDefinition {
  return {
    key: `business/${key}`,
    outputPath: `business/${key}.md`,
    allowedEvidenceClasses: intentEvidence,
    invalidationRules: changeClasses.map((changeClass) => ({ changeClass })),
  };
}
