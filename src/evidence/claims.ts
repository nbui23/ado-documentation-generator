import type { ClaimDraft, EvidenceRef } from "../domain/types.js";

export interface EvidenceWithText extends EvidenceRef {
  readonly text: string;
}

export function validateClaims(
  candidates: readonly ClaimDraft[],
  pack: readonly EvidenceWithText[],
): { claims: readonly ClaimDraft[]; gaps: readonly string[] } {
  const byId = new Map(pack.map((evidence) => [evidence.id, evidence]));
  const claims: ClaimDraft[] = [];
  const gaps: string[] = [];
  for (const candidate of candidates) {
    const citedEvidence = new Set(candidate.evidenceIds);
    const cited = candidate.evidenceIds
      .map((id) => byId.get(id))
      .filter((item): item is EvidenceWithText => item !== undefined);
    const quotedEvidence = new Set(candidate.supportingQuotes.map((support) => support.evidenceId));
    const valid =
      candidate.evidenceIds.length > 0 &&
      candidate.evidenceIds.every((id) => byId.has(id)) &&
      candidate.evidenceIds.every((id) => quotedEvidence.has(id)) &&
      (candidate.claimKind === "conflict"
        ? new Set(cited.map((evidence) => lensFor(evidence.sourceType))).size > 1
        : cited.every((evidence) => lensFor(evidence.sourceType) === candidate.evidenceLens)) &&
      candidate.supportingQuotes.length > 0 &&
      candidate.supportingQuotes.every((support) => {
        if (!citedEvidence.has(support.evidenceId)) return false;
        const evidence = byId.get(support.evidenceId);
        return (
          support.quote.length > 0 &&
          support.quote.length <= 240 &&
          evidence?.locator === support.locator &&
          evidence.text.includes(support.quote)
        );
      });
    if (valid) claims.push(candidate);
    else gaps.push(candidate.text);
  }
  return { claims, gaps };
}

function lensFor(sourceType: EvidenceRef["sourceType"]): ClaimDraft["evidenceLens"] {
  switch (sourceType) {
    case "work_item":
      return "intent";
    case "code":
    case "test":
      return "implementation";
    case "pull_request":
    case "commit":
      return "history";
    case "existing_document":
      return "prior_documentation";
  }
}
