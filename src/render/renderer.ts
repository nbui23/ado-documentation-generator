import type { MarkdownRenderer } from "../domain/ports.js";
import type { ClaimDraft, EvidenceRef } from "../domain/types.js";
import { renderMarkdown } from "./markdown.js";

export class DeterministicMarkdownRenderer implements MarkdownRenderer {
  public render(
    sectionKey: string,
    claims: readonly ClaimDraft[],
    evidence: readonly EvidenceRef[],
  ): string {
    const title = (sectionKey.split("/").at(-1) ?? sectionKey)
      .split("-")
      .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
      .join(" ");
    return renderMarkdown(title, claims, evidence);
  }
}
