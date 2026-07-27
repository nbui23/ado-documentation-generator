# Kubernetes Job

This manifest runs `edgar` as a finite, operator-triggered Job.

1. Build, scan, and replace `REPLACE_WITH_PINNED_EDGAR_IMAGE` with an immutable digest.
2. Create an `edgar` ConfigMap whose `.edgar.yaml` key is based on `config.example.yaml`.
3. Create the `edgar-database` Secret with separate `migrationDatabaseUrl` and least-privilege `runtimeDatabaseUrl` keys. Both production URLs must enable TLS; prefer `sslmode=verify-full`.
4. Prefer Azure Workload Identity by binding the `edgar` service account to the required Entra identity. If a service principal is unavoidable, place `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and `AZURE_CLIENT_SECRET` in the optional `edgar-identity` Secret. When Jira is configured, add `ATLASSIAN_JIRA_TOKEN` to that Secret. Do not put credentials in the ConfigMap.
5. Apply the Job without `--publish` first. Add `"--publish"` to the main container args only after validation and a dry run succeed.

The init container applies forward-only migrations. PostgreSQL is external and must have backups, encryption, and pgvector 0.8.2 available.

Apply `service-account.yaml` after replacing its client-ID placeholder. `network-policy.yaml` denies ingress and limits egress to DNS, TLS, and PostgreSQL; platforms with FQDN-aware policy should further restrict TLS destinations to Entra, Azure DevOps, Atlassian when enabled, and the configured Azure OpenAI host.

Jira service-token issuance and OAuth refresh are managed outside this application.

The portable Kubernetes policy cannot express hostname allowlists and therefore permits TCP 443
and 5432 broadly. Before production use, restrict those destinations with an egress proxy, cloud
firewall, or FQDN-aware CNI policy.
