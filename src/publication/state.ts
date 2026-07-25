import { createHash } from "node:crypto";
import type { PublicationState } from "../domain/types.js";

export const MANAGED_START = "<!-- agent-docs:start -->";
export const MANAGED_END = "<!-- agent-docs:end -->";

export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function detectManualConflicts(
  impactedPaths: readonly string[],
  activeBranchFiles: Readonly<Record<string, string | undefined>>,
  lastGeneratorHashes: Readonly<Record<string, string>>,
  protectUnownedFiles = false,
  pendingFiles: Readonly<Record<string, string>> = {},
): readonly string[] {
  return impactedPaths.filter((path) => {
    const active = activeBranchFiles[path];
    const prior = lastGeneratorHashes[path];
    if (active === undefined) return false;
    if (active === pendingFiles[path]) return false;
    if (prior === undefined) return protectUnownedFiles;
    return contentHash(active) !== prior;
  });
}

export function updateManagedDescription(existing: string, managed: string): string {
  const block = `${MANAGED_START}\n${managed.trim()}\n${MANAGED_END}`;
  const start = existing.indexOf(MANAGED_START);
  const end = existing.indexOf(MANAGED_END);
  if (start < 0 || end < start) return existing.trim() ? `${existing.trim()}\n\n${block}` : block;
  return `${existing.slice(0, start)}${block}${existing.slice(end + MANAGED_END.length)}`;
}

export function shouldCreateLifecycle(state: PublicationState | null): boolean {
  return (
    !state?.pullRequestId ||
    state.pullRequestStatus === "completed" ||
    state.pullRequestStatus === "abandoned"
  );
}

export class PublicationConflictError extends Error {
  public constructor() {
    super("Target or lifecycle branch changed concurrently; refresh and replan");
  }
}
