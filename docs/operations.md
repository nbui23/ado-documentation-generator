# Production operations

## Runtime prerequisites

- Node.js 24 LTS when running outside the container.
- PostgreSQL 18 with pgvector 0.8.2.
- Microsoft Entra identity with Azure DevOps work-item read and repository read/contribute/create-branch/create-PR permissions.
- When Jira is configured, an `ATLASSIAN_JIRA_TOKEN` with read access to the selected Jira Cloud
  issues and changelogs.
- Azure OpenAI generation and `text-embedding-3-small` deployments.
- A repository-root `.agent-docs.yaml`.

## Deployment sequence

1. Pin and scan the container image promoted from CI.
2. Back up PostgreSQL.
3. Run `agent-docs db migrate` as a one-off deployment job.
4. Run `agent-docs validate` with the production identities.
5. Run without `--publish` and inspect the durable run record.
6. Enable `--publish` only after the dry run succeeds.

CI produces a scanned container archive, CycloneDX SBOM, and strict TechDocs site artifact. Registry push, signature, and environment-specific image digest substitution belong to the protected promotion pipeline because registry identities and signing policy are deployment-owned.

The live promotion gate is `npm run test:e2e` with `AGENT_DOCS_E2E_ROOT` set to a dedicated sandbox checkout. It applies migrations, validates both providers, performs a full run, inspects its durable audit, and proves the next run is a no-op. Set `AGENT_DOCS_E2E_PUBLISH=true` to include draft-PR publication.

The reference one-shot deployment is in `deploy/kubernetes/job.yaml`. Replace the image placeholder with an immutable digest, mount the repository configuration from a ConfigMap, and provide secrets only through a Secret or Azure Workload Identity.

## Health and readiness

This is a finite CLI job, not an HTTP service. Readiness is proven by `agent-docs validate`; job health is its exit status and the durable `run` audit row. A successful job exits zero only after its requested pipeline stages complete.

## Observability

Logs are structured JSON. Collect exit status, run ID, stage, duration, retry classification, evidence counts, gaps, token usage, and publication action. Never enable raw HTTP body logging. Alert on:

- any failed run;
- repeated rate-limit or provider failures;
- unresolved manual publication conflicts;
- a growing publication outbox backlog;
- no successful run inside the expected operating window;
- PostgreSQL capacity, connection, or backup failures.

`DATABASE_POOL_MAX` optionally caps the PostgreSQL connection pool and defaults to 10.
Production mode rejects database URLs that do not explicitly enable TLS. Use separate migration and runtime database roles; the runtime role should not own the schema or extensions.

Jira Cloud is optional and supplements Azure Boards. A configured Jira failure fails the run before
checkpoint advancement or publication. Store the Jira token in the deployment secret provider,
never in `.agent-docs.yaml`; this job does not perform interactive OAuth consent or refresh.

Optional publication reviewers are Azure DevOps identity UUIDs. Every configured reviewer is included when a lifecycle draft PR is created.

## Safe rollback

Stop new runs, abandon the open draft PR, and roll the container back. Do not roll the database schema backward while older evidence or publication state is still required. Forward-fix migrations are preferred.
