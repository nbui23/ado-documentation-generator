import { z } from "zod";

const workItemRoles = ["epic", "feature", "requirement", "user_story", "bug"] as const;

const fieldsSchema = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  acceptanceCriteria: z.string().min(1),
  state: z.string().min(1),
  tags: z.string().min(1),
  ownership: z.string().min(1),
});

const jiraFieldsSchema = z
  .object({
    title: z.string().min(1).default("summary"),
    description: z.string().min(1).default("description"),
    acceptanceCriteria: z.string().min(1).optional(),
    state: z.string().min(1).default("status"),
    tags: z.string().min(1).default("labels"),
    ownership: z.string().min(1).default("assignee"),
  })
  .default({
    title: "summary",
    description: "description",
    state: "status",
    tags: "labels",
    ownership: "assignee",
  });

export const agentDocsConfigSchema = z.object({
  schemaVersion: z.literal(1),
  azureDevOps: z.object({
    organization: z.url().refine((value) => {
      const url = new URL(value);
      return url.protocol === "https:" && url.hostname === "dev.azure.com";
    }, "Azure DevOps organization must use https://dev.azure.com"),
    project: z.string().min(1),
    repository: z.string().min(1),
    historyFrom: z.iso.datetime(),
    workItemTypes: z
      .record(z.string(), z.enum(workItemRoles))
      .refine((mapping) => workItemRoles.every((role) => Object.values(mapping).includes(role)), {
        message: `Mappings must include ${workItemRoles.join(", ")}`,
      }),
    fields: fieldsSchema,
  }),
  jira: z
    .object({
      cloudId: z.string().trim().min(1),
      siteUrl: z.url().refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && url.hostname.endsWith(".atlassian.net");
      }, "Jira site URL must use an https://*.atlassian.net host"),
      jql: z
        .string()
        .trim()
        .min(1)
        .refine((value) => !/\border\s+by\b/i.test(value), "Jira JQL must not contain ORDER BY"),
      issueTypes: z
        .record(z.string().min(1), z.enum(workItemRoles))
        .refine(
          (mapping) => Object.keys(mapping).length > 0,
          "Jira issue type mapping is required",
        ),
      fields: jiraFieldsSchema,
    })
    .optional(),
  azureOpenAI: z.object({
    endpoint: z.url().refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        (url.hostname.endsWith(".openai.azure.com") ||
          url.hostname.endsWith(".services.ai.azure.com"))
      );
    }, "Azure OpenAI endpoint must use an approved Azure AI hostname"),
    generationDeployment: z.string().min(1),
    embeddingDeployment: z.string().min(1),
    embeddingDimensions: z.literal(1536),
  }),
  source: z.object({
    include: z.array(z.string().min(1)).min(1),
    exclude: z.array(z.string().min(1)).default([]),
    maxTextFileBytes: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 * 1024)
      .default(1024 * 1024),
  }),
  documentation: z.object({
    root: z
      .string()
      .min(1)
      .refine(
        (value) =>
          !value.startsWith("/") &&
          !value.startsWith("\\") &&
          !value.includes("\\") &&
          !/^[A-Za-z]:/.test(value) &&
          value
            .split("/")
            .every((segment) => segment.length > 0 && segment !== "." && segment !== ".."),
        "Documentation root must be a repository-relative path without parent traversal",
      )
      .default("generated-docs"),
  }),
  publication: z
    .object({
      reviewers: z.array(z.uuid()).default([]),
    })
    .default({ reviewers: [] }),
});

export type AgentDocsConfig = z.infer<typeof agentDocsConfigSchema>;
