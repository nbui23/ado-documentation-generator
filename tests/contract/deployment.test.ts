import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseAllDocuments, parseDocument } from "yaml";
import { agentDocsConfigSchema } from "../../src/config/schema.js";

describe("production deployment descriptors", () => {
  it("pins the database compatibility line and persists local development data", async () => {
    const compose = parseDocument(await readFile("docker-compose.yml", "utf8")).toJS() as {
      services: { postgres: { image: string; volumes: string[]; healthcheck: unknown } };
    };

    expect(compose.services.postgres.image).toMatch(
      /^pgvector\/pgvector:0\.8\.2-pg18@sha256:[a-f0-9]{64}$/,
    );
    expect(compose.services.postgres.volumes).toContain(
      "agent-docs-postgres:/var/lib/postgresql/data",
    );
    expect(compose.services.postgres.healthcheck).toBeTruthy();
  });

  it("runs as a finite, non-root Kubernetes Job with migration isolation", async () => {
    const [job] = parseAllDocuments(await readFile("deploy/kubernetes/job.yaml", "utf8")).map(
      (document) => document.toJS() as KubernetesJob,
    );
    const pod = job?.spec.template.spec;

    expect(job?.kind).toBe("Job");
    expect(pod?.restartPolicy).toBe("Never");
    expect(pod?.securityContext).toMatchObject({ runAsNonRoot: true, fsGroup: 1000 });
    expect(pod?.initContainers[0]?.args).toEqual(["db", "migrate"]);
    expect(pod?.containers[0]?.args).toEqual(["run"]);
    expect(pod?.containers[0]?.securityContext).toMatchObject({
      allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true,
    });
    expect(JSON.stringify(pod?.initContainers[0])).toContain("migrationDatabaseUrl");
    expect(JSON.stringify(pod?.containers[0])).toContain("runtimeDatabaseUrl");
    expect(JSON.stringify(pod)).toContain("DATABASE_REQUIRE_TLS");
  });

  it("ships a valid non-secret configuration example", async () => {
    const config = parseDocument(
      await readFile("deploy/kubernetes/config.example.yaml", "utf8"),
    ).toJS() as unknown;

    expect(() => agentDocsConfigSchema.parse(config)).not.toThrow();
    expect(JSON.stringify(config)).not.toMatch(/clientSecret|password|token/i);
  });

  it("pins build dependencies and ships a default-deny workload network policy", async () => {
    const dockerfile = await readFile("Dockerfile", "utf8");
    expect(dockerfile.match(/FROM node:24-bookworm-slim@sha256:[a-f0-9]{64}/g)).toHaveLength(2);
    const [policy] = parseAllDocuments(
      await readFile("deploy/kubernetes/network-policy.yaml", "utf8"),
    ).map((document) => document.toJS() as { kind: string; spec: { ingress: unknown[] } });
    expect(policy).toMatchObject({ kind: "NetworkPolicy", spec: { ingress: [] } });
  });
});

interface KubernetesJob {
  readonly kind: string;
  readonly spec: {
    readonly template: {
      readonly spec: {
        readonly restartPolicy: string;
        readonly securityContext: Readonly<Record<string, unknown>>;
        readonly initContainers: Array<{ readonly args: string[] }>;
        readonly containers: Array<{
          readonly args: string[];
          readonly securityContext: Readonly<Record<string, unknown>>;
        }>;
      };
    };
  };
}
