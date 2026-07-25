import type { ClaimDraft, EvidenceRef } from "../domain/types.js";

/**
 * Render untrusted provider or model text as one literal Markdown line.
 *
 * Escaping all ASCII punctuation also neutralizes raw HTML, autolinks, link
 * destinations, images, footnotes, and entity references. Newlines are
 * collapsed so untrusted text cannot start a new block.
 */
function renderLiteralText(value: string): string {
  return Array.from(value, (character) => (isUnsafeControl(character) ? " " : character))
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, "\\$1");
}

function isUnsafeControl(character: string): boolean {
  const point = character.codePointAt(0) ?? 0;
  return (
    point <= 0x1f ||
    (point >= 0x7f && point <= 0x9f) ||
    point === 0x200e ||
    point === 0x200f ||
    (point >= 0x202a && point <= 0x202e) ||
    (point >= 0x2066 && point <= 0x2069)
  );
}

export function renderMarkdown(
  title: string,
  claims: readonly ClaimDraft[],
  evidence: readonly EvidenceRef[],
): string {
  const refs = new Map(evidence.map((item) => [item.id, item]));
  const validEvidenceIds = new Set(evidence.filter(hasPinnedAzureDevOpsUrl).map((item) => item.id));
  const renderableClaims = claims.filter(
    (claim) =>
      claim.evidenceIds.length > 0 && claim.evidenceIds.every((id) => validEvidenceIds.has(id)),
  );
  const used = [...new Set(renderableClaims.flatMap((claim) => claim.evidenceIds))].sort();
  const footnotes = new Map(used.map((id, index) => [id, `e${String(index + 1)}`]));
  const lines = [`# ${renderLiteralText(title)}`, ""];
  for (const claim of renderableClaims) {
    const citations = claim.evidenceIds
      .filter((id) => footnotes.has(id))
      .map((id) => `[^${footnotes.get(id) ?? "unknown"}]`)
      .join("");
    const conflictClasses = [
      ...new Set(
        claim.evidenceIds
          .map((id) => refs.get(id)?.sourceType)
          .filter((value): value is NonNullable<typeof value> => value !== undefined),
      ),
    ].join(" vs ");
    const label =
      claim.claimKind === "conflict"
        ? `**Evidence conflict (${renderLiteralText(conflictClasses || claim.evidenceLens)}):** `
        : "";
    lines.push(`- ${label}${renderLiteralText(claim.text)}${citations}`);
  }
  if (renderableClaims.length === 0) lines.push("_No validated claims are currently available._");
  if (used.length > 0) lines.push("", "## Evidence", "");
  for (const id of used) {
    const item = refs.get(id);
    if (!item) continue;
    const pinnedUrl = getPinnedAzureDevOpsUrl(item);
    if (!pinnedUrl) continue;
    lines.push(
      `[^${footnotes.get(id) ?? "unknown"}]: [${renderLiteralText(item.sourceRef)} at ${renderLiteralText(item.locator)}](<${pinnedUrl}>) (${renderLiteralText(item.revision)})`,
    );
  }
  return `${lines.join("\n")}\n`;
}

function hasPinnedAzureDevOpsUrl(item: EvidenceRef): boolean {
  return getPinnedAzureDevOpsUrl(item) !== undefined;
}

function getPinnedAzureDevOpsUrl(item: EvidenceRef): string | undefined {
  try {
    const url = new URL(item.pinnedUrl);
    const version = url.searchParams.get("version");
    if (
      url.protocol !== "https:" ||
      url.hostname !== "dev.azure.com" ||
      url.port !== "" ||
      url.username !== "" ||
      url.password !== "" ||
      version === null ||
      version.trim() === ""
    )
      return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}
