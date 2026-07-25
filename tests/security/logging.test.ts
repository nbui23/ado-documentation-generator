import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/observability/logger.js";

describe("safe logging", () => {
  it("redacts secrets, prompts, source content, and supporting quotes", async () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    });
    const logger = createLogger(destination);
    logger.info({
      runId: "run",
      token: "token-secret",
      prompt: "prompt-secret",
      content: "source-secret",
      quote: "quote-secret",
    });
    await new Promise<void>((resolve) => destination.end(resolve));
    expect(output).not.toMatch(/token-secret|prompt-secret|source-secret|quote-secret/);
    expect(output).toContain("run");
  });

  it("does not serialize provider error messages that may contain source data", async () => {
    let output = "";
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    });
    const logger = createLogger(destination);
    logger.error({ error: new Error("provider echoed source-secret") }, "run failed");
    await new Promise<void>((resolve) => destination.end(resolve));

    expect(output).not.toContain("source-secret");
    expect(output).toContain("Error");
  });
});
