import { describe, expect, it } from "vitest";
import { isSensitivePath, redactText } from "../../src/security/redaction.js";

describe("redaction", () => {
  it("blocks secrets and generated/vendor paths", () => {
    expect(isSensitivePath(".env")).toBe(true);
    expect(isSensitivePath("keys/service.pem")).toBe(true);
    expect(isSensitivePath(".npmrc")).toBe(true);
    expect(isSensitivePath(".aws/credentials")).toBe(true);
    expect(isSensitivePath(".docker/config.json")).toBe(true);
    expect(isSensitivePath(".config/gcloud/application_default_credentials.json")).toBe(true);
    expect(isSensitivePath("infra/production.tfstate.backup")).toBe(true);
    expect(isSensitivePath(".ssh/id_ed25519")).toBe(true);
    expect(isSensitivePath("generated-docs/README.md")).toBe(true);
    expect(isSensitivePath("custom\\docs\\README.md", "custom\\docs")).toBe(true);
    expect(isSensitivePath("src/index.ts")).toBe(false);
  });

  it("redacts credentials deterministically", () => {
    expect(redactText("DATABASE_URL=postgres://secret")).toBe("DATABASE_URL=[REDACTED]");
    expect(redactText("Authorization: Bearer abc.def.ghi")).not.toContain("abc.def.ghi");
  });

  it("redacts quoted JSON and YAML credentials", () => {
    const source = [
      `"client_secret": "json secret with spaces",`,
      `apiKey: 'yaml-secret'`,
      "private_key: |",
      "  -----BEGIN PRIVATE KEY-----",
      "  sensitive-key-material",
      "  -----END PRIVATE KEY-----",
      `safe: "retained"`,
    ].join("\n");

    const redacted = redactText(source);

    expect(redacted).not.toContain("json secret with spaces");
    expect(redacted).not.toContain("yaml-secret");
    expect(redacted).not.toContain("sensitive-key-material");
    expect(redacted).toContain(`"client_secret": [REDACTED]`);
    expect(redacted).toContain("apiKey: [REDACTED]");
    expect(redacted).toContain(`safe: "retained"`);
    expect(redactText(source)).toBe(redacted);
  });

  it("redacts credentials embedded in connection URLs and auth headers", () => {
    expect(redactText("postgres://agent:super-secret@db.example/app")).toBe(
      "postgres://[REDACTED]@db.example/app",
    );
    expect(redactText("Authorization: Basic dXNlcjpwYXNzd29yZA==")).not.toContain(
      "dXNlcjpwYXNzd29yZA==",
    );
  });

  it("fails closed when a likely credential survives targeted replacement", () => {
    expect(redactText("-----BEGIN PRIVATE KEY-----\ntruncated")).toBe(
      "[REDACTED_SENSITIVE_CONTENT]",
    );
    expect(redactText("eyJabcdefghijk.abcdefghijklmnop.abcdefghijklmnop")).toBe(
      "[REDACTED_SENSITIVE_CONTENT]",
    );
  });
});
