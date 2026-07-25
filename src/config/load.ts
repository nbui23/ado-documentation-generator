import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { agentDocsConfigSchema, type AgentDocsConfig } from "./schema.js";

export const CONFIG_FILE = ".agent-docs.yaml";

export async function loadConfig(root = process.cwd()): Promise<AgentDocsConfig> {
  const path = resolve(root, CONFIG_FILE);
  const content = await readFile(path, "utf8");
  return agentDocsConfigSchema.parse(parse(content) as unknown);
}

export const CONFIG_TEMPLATE = `schemaVersion: 1
azureDevOps:
  organization: https://dev.azure.com/your-organization
  project: your-project
  repository: your-repository
  historyFrom: 2025-01-01T00:00:00.000Z
  workItemTypes:
    Epic: epic
    Feature: feature
    Requirement: requirement
    User Story: user_story
    Bug: bug
  fields:
    title: System.Title
    description: System.Description
    acceptanceCriteria: Microsoft.VSTS.Common.AcceptanceCriteria
    state: System.State
    tags: System.Tags
    ownership: System.AssignedTo
azureOpenAI:
  endpoint: https://your-resource.openai.azure.com
  generationDeployment: documentation-generation
  embeddingDeployment: text-embedding-3-small
  embeddingDimensions: 1536
source:
  include:
    - "**/*"
  exclude: []
  maxTextFileBytes: 1048576
documentation:
  root: generated-docs
publication:
  reviewers: []
`;
