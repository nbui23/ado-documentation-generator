import { describe, expect, it } from "vitest";
import {
  contentHash,
  detectManualConflicts,
  MANAGED_END,
  MANAGED_START,
  updateManagedDescription,
} from "../../src/publication/state.js";

describe("publication state", () => {
  it("preserves human-authored PR text", () => {
    const existing = `Human introduction\n\n${MANAGED_START}\nold\n${MANAGED_END}\n\nHuman footer`;
    const updated = updateManagedDescription(existing, "new");
    expect(updated).toContain("Human introduction");
    expect(updated).toContain("Human footer");
    expect(updated).toContain("new");
    expect(updated).not.toContain("\nold\n");
  });

  it("detects reviewer edits on impacted files", () => {
    expect(
      detectManualConflicts(
        ["a.md", "b.md"],
        { "a.md": "edited", "b.md": "same" },
        { "a.md": contentHash("generated"), "b.md": contentHash("same") },
      ),
    ).toEqual(["a.md"]);
  });

  it("protects existing files that have no generator ownership record", () => {
    expect(
      detectManualConflicts(
        ["human.md", "new.md"],
        { "human.md": "maintainer content", "new.md": undefined },
        {},
        true,
      ),
    ).toEqual(["human.md"]);
  });

  it("adopts an unowned file when its content already matches the pending render", () => {
    expect(
      detectManualConflicts(["recovered.md"], { "recovered.md": "generated content" }, {}, true, {
        "recovered.md": "generated content",
      }),
    ).toEqual([]);
  });

  it("adopts a previously managed file when a recovered push already wrote the pending render", () => {
    expect(
      detectManualConflicts(
        ["recovered.md"],
        { "recovered.md": "new generated content" },
        { "recovered.md": contentHash("old generated content") },
        true,
        { "recovered.md": "new generated content" },
      ),
    ).toEqual([]);
  });
});
