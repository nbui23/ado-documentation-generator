import { afterEach, describe, expect, it, vi } from "vitest";
import { createDatabase } from "../../src/db/database.js";

describe("database production transport", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("rejects a production database URL without explicit TLS", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_REQUIRE_TLS", "true");

    expect(() => createDatabase("postgresql://agent:password@db.example/edgar")).toThrow(
      /enable TLS/,
    );
  });

  it("accepts a production database URL with certificate verification", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DATABASE_REQUIRE_TLS", "true");
    const database = createDatabase(
      "postgresql://agent:password@db.example/edgar?sslmode=verify-full",
    );

    await database.destroy();
  });
});
