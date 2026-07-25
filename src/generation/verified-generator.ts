import type { ClaimGenerator } from "../domain/ports.js";
import type { ClaimDraft, EvidenceRef } from "../domain/types.js";
import { validateClaims, type EvidenceWithText } from "../evidence/claims.js";

export class VerifiedClaimGenerator implements ClaimGenerator {
  public constructor(
    private readonly delegate: Pick<ClaimGenerator, "generate"> & {
      verifySupport?: (
        claims: readonly ClaimDraft[],
        evidence: readonly EvidenceRef[],
      ) => Promise<readonly ClaimDraft[]>;
    },
  ) {}

  public generate(
    sectionKey: string,
    evidence: readonly EvidenceRef[],
  ): Promise<readonly ClaimDraft[]> {
    return this.delegate.generate(sectionKey, evidence);
  }

  public async verify(
    claims: readonly ClaimDraft[],
    evidence: readonly EvidenceRef[],
  ): Promise<readonly ClaimDraft[]> {
    const withText = evidence.filter(
      (item): item is EvidenceWithText =>
        "text" in item && typeof (item as { text?: unknown }).text === "string",
    );
    const lexicallySupported = validateClaims(claims, withText).claims;
    return this.delegate.verifySupport
      ? this.delegate.verifySupport(lexicallySupported, evidence)
      : lexicallySupported;
  }
}
