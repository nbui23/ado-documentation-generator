import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse } from "yaml";
import { edgarConfigSchema, type EdgarConfig } from "./schema.js";

export const CONFIG_FILE = ".edgar.yaml";

export async function loadConfig(root = process.cwd()): Promise<EdgarConfig> {
  const path = resolve(root, CONFIG_FILE);
  const content = await readFile(path, "utf8");
  return edgarConfigSchema.parse(parse(content) as unknown);
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
# Optional Jira Cloud supplement. Set ATLASSIAN_JIRA_TOKEN in the environment.
# jira:
#   cloudId: your-atlassian-cloud-id
#   siteUrl: https://example.atlassian.net
#   jql: project = EXAMPLE
#   issueTypes:
#     Epic: epic
#     Feature: feature
#     Story: user_story
#     Task: requirement
#     Bug: bug
#   fields:
#     acceptanceCriteria: customfield_10042
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
