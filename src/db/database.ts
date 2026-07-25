import { Kysely, PostgresDialect } from "kysely";
import pg from "pg";
import type { Database } from "./types.js";

export function createDatabase(connectionString = process.env.DATABASE_URL): Kysely<Database> {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  assertDatabaseTransport(connectionString);
  const configuredPoolSize = Number.parseInt(process.env.DATABASE_POOL_MAX ?? "10", 10);
  const poolSize =
    Number.isSafeInteger(configuredPoolSize) && configuredPoolSize > 0 ? configuredPoolSize : 10;
  return new Kysely<Database>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({
        connectionString,
        max: poolSize,
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 30_000,
        application_name: "agent-docs",
      }),
    }),
  });
}

export async function probeDatabase(db: Kysely<Database>): Promise<void> {
  await db.selectFrom("checkpoint").select("name").limit(1).execute();
}

export interface RuntimeLock {
  release(): Promise<void>;
}

export async function acquireRuntimeLock(
  connectionString = process.env.DATABASE_URL,
): Promise<RuntimeLock> {
  if (!connectionString) throw new Error("DATABASE_URL is required");
  assertDatabaseTransport(connectionString);
  const client = new pg.Client({ connectionString, application_name: "agent-docs-lock" });
  await client.connect();
  try {
    const result = await client.query<{ acquired: boolean }>(
      "select pg_try_advisory_lock(hashtext($1)) as acquired",
      ["agent-docs-run"],
    );
    if (result.rows[0]?.acquired !== true) {
      throw new Error("Another agent-docs run is already active");
    }
  } catch (error) {
    await client.end();
    throw error;
  }
  return {
    async release() {
      try {
        await client.query("select pg_advisory_unlock(hashtext($1))", ["agent-docs-run"]);
      } finally {
        await client.end();
      }
    },
  };
}

function assertDatabaseTransport(connectionString: string): void {
  if (process.env.NODE_ENV !== "production" || process.env.DATABASE_REQUIRE_TLS === "false") return;
  const url = new URL(connectionString);
  const sslMode = url.searchParams.get("sslmode");
  const tlsEnabled =
    url.searchParams.get("ssl") === "true" ||
    sslMode === "require" ||
    sslMode === "verify-ca" ||
    sslMode === "verify-full";
  if (!tlsEnabled) {
    throw new Error(
      "Production DATABASE_URL must enable TLS with sslmode=require, verify-ca, or verify-full",
    );
  }
}
