import { describe, expect, it } from "vitest";
import { agentDocsConfigSchema } from "../../src/config/schema.js";

const valid = {
  schemaVersion: 1,
  azureDevOps: {
    organization: "https://dev.azure.com/example",
    project: "project",
    repository: "repo",
    historyFrom: "2025-01-01T00:00:00.000Z",
    workItemTypes: {
      Epic: "epic",
      Feature: "feature",
      Requirement: "requirement",
      "User Story": "user_story",
      Bug: "bug",
    },
    fields: {
      title: "System.Title",
      description: "System.Description",
      acceptanceCriteria: "Custom.AcceptanceCriteria",
      state: "System.State",
      tags: "System.Tags",
      ownership: "System.AssignedTo",
    },
  },
  azureOpenAI: {
    endpoint: "https://example.openai.azure.com",
    generationDeployment: "generation",
    embeddingDeployment: "text-embedding-3-small",
    embeddingDimensions: 1536,
  },
  source: { include: ["src/**"] },
  documentation: {},
  publication: { reviewers: [] as string[] },
};

describe("agentDocsConfigSchema", () => {
  it("defaults safe non-secret values", () => {
    const config = agentDocsConfigSchema.parse(valid);
    expect(config.documentation.root).toBe("generated-docs");
    expect(config.source.maxTextFileBytes).toBe(1024 * 1024);
    expect(config.publication.reviewers).toEqual([]);
  });

  it("requires all canonical work item roles", () => {
    const invalid = structuredClone(valid);
    delete (invalid.azureDevOps.workItemTypes as Record<string, string>).Bug;
    expect(() => agentDocsConfigSchema.parse(invalid)).toThrow(/Mappings must include/);
  });

  it("rejects non-TLS provider URLs", () => {
    const invalid = structuredClone(valid);
    invalid.azureOpenAI.endpoint = "http://example.test";
    expect(() => agentDocsConfigSchema.parse(invalid)).toThrow();
  });

  it("fixes the embedding dimension at 1536", () => {
    const invalid = structuredClone(valid);
    invalid.azureOpenAI.embeddingDimensions = 3072;
    expect(() => agentDocsConfigSchema.parse(invalid)).toThrow();
  });

  it("confines the documentation root to the repository", () => {
    for (const root of [
      "../outside",
      "/tmp/outside",
      "docs/../../outside",
      ".",
      "generated-docs/",
      String.raw`generated\docs`,
    ]) {
      const invalid = structuredClone(valid);
      invalid.documentation = { root };
      expect(() => agentDocsConfigSchema.parse(invalid)).toThrow(/repository-relative/);
    }
  });

  it("accepts only Azure DevOps identity UUIDs as reviewers", () => {
    const invalid = structuredClone(valid);
    invalid.publication = { reviewers: ["reviewer@example.com"] };
    expect(() => agentDocsConfigSchema.parse(invalid)).toThrow();

    const configured = structuredClone(valid);
    configured.publication = { reviewers: ["3d6f0a1e-3677-4dd5-8b5e-b7954a02d62e"] };
    expect(agentDocsConfigSchema.parse(configured).publication.reviewers).toHaveLength(1);
  });
});
