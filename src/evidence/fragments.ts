import { createHash } from "node:crypto";
import type { SourceSnapshotInput } from "../domain/types.js";

export interface EvidenceFragment {
  readonly id: string;
  readonly sourceRef: string;
  readonly revision: string;
  readonly sourceType: SourceSnapshotInput["sourceType"];
  readonly locator: string;
  readonly pinnedUrl: string;
  readonly text: string;
  readonly excerptHash: string;
}

export function hash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function fragmentEvidence(
  snapshot: SourceSnapshotInput,
  maxChars = 2_000,
): readonly EvidenceFragment[] {
  const fragmentLimit = Number.isSafeInteger(maxChars) && maxChars > 0 ? maxChars : 2_000;
  const normalized = snapshot.redactedContent.replace(/\r\n/g, "\n").trim();
  if (normalized.length === 0) return [];
  const paragraphs = normalized.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    for (const piece of splitOversizedParagraph(paragraph, fragmentLimit)) {
      if (current && current.length + piece.length + 2 > fragmentLimit) {
        chunks.push(current);
        current = "";
      }
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks.map((text, index) => {
    const locator = `${snapshot.locator}#fragment-${String(index + 1)}`;
    const excerptHash = hash(text);
    return {
      id: hash([snapshot.sourceRef, snapshot.revision, locator, text, excerptHash].join("\0")),
      sourceRef: snapshot.sourceRef,
      revision: snapshot.revision,
      sourceType: snapshot.sourceType,
      locator,
      pinnedUrl: snapshot.pinnedUrl,
      text,
      excerptHash,
    };
  });
}

function splitOversizedParagraph(paragraph: string, maxChars: number): readonly string[] {
  if (paragraph.length <= maxChars) return [paragraph];
  const pieces: string[] = [];
  let current = "";
  for (const line of paragraph.split("\n")) {
    for (const segment of splitOversizedLine(line, maxChars)) {
      if (current && current.length + segment.length + 1 > maxChars) {
        pieces.push(current);
        current = "";
      }
      current = current ? `${current}\n${segment}` : segment;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

function splitOversizedLine(line: string, maxChars: number): readonly string[] {
  if (line.length <= maxChars) return [line];
  const pieces: string[] = [];
  for (let index = 0; index < line.length; index += maxChars) {
    pieces.push(line.slice(index, index + maxChars));
  }
  return pieces;
}
