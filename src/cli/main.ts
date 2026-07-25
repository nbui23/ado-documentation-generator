#!/usr/bin/env node
import { access, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { Command } from "commander";
import { CONFIG_FILE, CONFIG_TEMPLATE, loadConfig } from "../config/load.js";
import { createDatabase } from "../db/database.js";
import { migrateToLatest } from "../db/migrate.js";
import { executeRuntime, inspectRun, loadStoredSection, validateRuntime } from "../app/runtime.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger();
const program = new Command()
  .name("agent-docs")
  .description("Generate evidence-backed Azure DevOps documentation")
  .version("0.1.0");

program
  .command("init")
  .description("Create a non-secret configuration template")
  .action(async () => {
    const path = resolve(CONFIG_FILE);
    try {
      await access(path, constants.F_OK);
      throw new Error(`${CONFIG_FILE} already exists`);
    } catch (error) {
      if (error instanceof Error && error.message.endsWith("already exists")) throw error;
    }
    await writeFile(path, CONFIG_TEMPLATE, { encoding: "utf8", mode: 0o600, flag: "wx" });
    process.stdout.write(`Created ${CONFIG_FILE}\n`);
  });

program
  .command("validate")
  .description("Validate configuration and local prerequisites without ingesting")
  .action(async () => {
    const config = await loadConfig();
    await validateRuntime(config);
    process.stdout.write(
      "Configuration, database, identity, Azure DevOps, and Azure OpenAI are valid\n",
    );
  });

const dbCommand = program.command("db");
dbCommand
  .command("migrate")
  .description("Apply database migrations")
  .action(async () => {
    const db = createDatabase();
    try {
      await migrateToLatest(db);
    } finally {
      await db.destroy();
    }
    process.stdout.write("Database migrations applied\n");
  });

program
  .command("run")
  .option("--full", "force a full resynchronization")
  .option("--publish", "publish through a draft Azure DevOps PR")
  .description("Execute the documentation pipeline")
  .action(async (options: { full?: boolean; publish?: boolean }) => {
    const config = await loadConfig();
    const execution = await executeRuntime(config, {
      full: options.full ?? false,
      publish: options.publish ?? false,
    });
    process.stdout.write(
      `${JSON.stringify(
        {
          runId: execution.runId,
          renderedSections: Object.keys(execution.result.rendered).sort(),
          renderedSectionCount: Object.keys(execution.result.rendered).length,
          gapSections: Object.keys(execution.result.gaps).sort(),
          gapSectionCount: Object.keys(execution.result.gaps).length,
          publication: execution.result.publication,
          modelVerificationCount: execution.result.audit.modelVerificationCount,
        },
        null,
        2,
      )}\n`,
    );
  });

program
  .command("preview")
  .requiredOption("--section <key>")
  .description("Print a stored rendered section")
  .action(async ({ section }: { section: string }) => {
    const config = await loadConfig();
    process.stdout.write(await loadStoredSection(config, section));
  });

program
  .command("inspect")
  .command("run <id>")
  .description("Inspect the durable audit record for a run")
  .action(async (id: string) => {
    process.stdout.write(`${JSON.stringify(await inspectRun(id), null, 2)}\n`);
  });

try {
  await program.parseAsync();
} catch (error) {
  logger.error({ error }, "command failed");
  process.exitCode = 1;
}
