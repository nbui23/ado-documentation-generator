import { accessSync, constants } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const targetRoot = resolve(process.env.EDGAR_E2E_ROOT ?? "");
const cli = resolve(import.meta.dirname, "../dist/cli/main.js");
const publish = process.env.EDGAR_E2E_PUBLISH === "true";

if (!process.env.EDGAR_E2E_ROOT) {
  fail("EDGAR_E2E_ROOT is required and must point to a dedicated Azure DevOps sandbox checkout");
}
if (!process.env.DATABASE_URL) fail("DATABASE_URL is required");
for (const path of [cli, resolve(targetRoot, ".edgar.yaml")]) {
  try {
    accessSync(path, constants.R_OK);
  } catch {
    fail(`Required E2E input is unavailable: ${path}`);
  }
}

run(["db", "migrate"]);
run(["validate"]);
const first = runJson(["run", "--full", ...(publish ? ["--publish"] : [])]);
if (!first.runId || typeof first.runId !== "string") fail("Full run did not return a run ID");
if (publish && first.publication?.pullRequestStatus !== "active") {
  fail("Publication run did not produce or reuse an active draft pull request");
}
const inspection = runJson(["inspect", "run", first.runId]);
if (inspection.run?.status !== "succeeded") fail("Durable full-run audit did not succeed");

const second = runJson(["run", ...(publish ? ["--publish"] : [])]);
if (second.renderedSectionCount !== 0) {
  fail("Unchanged rerun was not a byte-stable no-op");
}
if (second.modelVerificationCount !== 0) {
  fail("Unchanged rerun performed documentation model verification");
}

process.stdout.write(
  `${JSON.stringify({
    fullRunId: first.runId,
    noOpRunId: second.runId,
    published: publish,
    renderedFileCount: first.renderedSectionCount,
    gapSectionCount: first.gapSectionCount,
  })}\n`,
);

function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: targetRoot,
    env: process.env,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    fail(`edgar ${args.join(" ")} failed with exit code ${String(result.status)}`);
  }
  return result.stdout;
}

function runJson(args) {
  const output = run(args);
  try {
    return JSON.parse(output);
  } catch {
    fail(`edgar ${args.join(" ")} did not return valid JSON`);
  }
}

function fail(message) {
  process.stderr.write(`Sandbox E2E failed: ${message}\n`);
  process.exit(1);
}
