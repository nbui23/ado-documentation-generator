import { createHash } from "node:crypto";
import { minimatch } from "minimatch";
import type { ChangeClass, ImpactPlan, SectionDefinition } from "../domain/types.js";

export interface FingerprintInput {
  readonly evidenceRevisions: readonly string[];
  readonly configVersion: string;
  readonly templateVersion: string;
  readonly promptVersion: string;
  readonly generationDeployment: string;
  readonly embeddingDeployment: string;
}

export function sectionFingerprint(input: FingerprintInput): string {
  const normalized = {
    ...input,
    evidenceRevisions: [...input.evidenceRevisions].sort(),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export function classifyPath(path: string): ChangeClass {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "").toLowerCase();
  if (
    /(^|\/)(package(-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|go\.(mod|sum)|cargo\.(toml|lock)|gemfile(\.lock)?|pom\.xml|build\.gradle(\.kts)?|composer\.(json|lock))$/.test(
      normalized,
    ) ||
    /\.(lock|csproj|fsproj|vbproj|sln)$/.test(normalized)
  ) {
    return "manifest";
  }
  if (/(^|\/)(test|tests|spec|specs|__tests__)(\/|$)|\.(test|spec)\.[^/]+$/.test(normalized)) {
    return "test";
  }
  if (
    /(^|\/)(\.?config|configuration|config)(\/|$)|(^|\/)\.(github|azure-pipelines)(\/|$)|(^|\/)(docker-compose[^/]*|azure-pipelines)\.ya?ml$|\.(ya?ml|toml|ini)$/.test(
      normalized,
    )
  ) {
    return "config";
  }
  return "code";
}

export interface SourceChange {
  readonly sourceRef: string;
  readonly changeClass: ChangeClass;
  readonly path?: string;
}

export function classifySourceChange(sourceRef: string): SourceChange {
  if (sourceRef.startsWith("work-item:")) return { sourceRef, changeClass: "work_item" };
  if (sourceRef.startsWith("pull-request:") || sourceRef.startsWith("commit:")) {
    return { sourceRef, changeClass: "history" };
  }
  const path = sourceRef.replaceAll("\\", "/").replace(/^\/+/, "");
  return { sourceRef, changeClass: classifyPath(path), path };
}

export function computeImpact(
  changes: readonly SourceChange[],
  impactedTraceNodes: readonly string[],
  sections: readonly SectionDefinition[],
): ImpactPlan {
  const affected = sections
    .filter((section) =>
      changes.some((change) =>
        section.invalidationRules.some(
          (rule) =>
            rule.changeClass === change.changeClass &&
            (!rule.pathGlobs?.length ||
              (change.path !== undefined &&
                rule.pathGlobs.some((glob) =>
                  minimatch(change.path ?? "", glob, { dot: true, nocase: true }),
                ))),
        ),
      ),
    )
    .map((section) => section.key)
    .sort();
  const affectedSet = new Set(affected);
  return {
    changedSources: [...new Set(changes.map((change) => change.sourceRef))].sort(),
    impactedTraceNodes: [...new Set(impactedTraceNodes)].sort(),
    affectedSections: affected,
    untouchedSections: sections
      .map((section) => section.key)
      .filter((key) => !affectedSet.has(key))
      .sort(),
  };
}
