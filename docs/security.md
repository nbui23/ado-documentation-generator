# Security

## Identity

`DefaultAzureCredential` is the only credential path. Local operators use Azure CLI; production uses workload identity, managed identity, or a service principal. Personal access tokens and API-key fallbacks are not supported.

## Data handling

- Sensitive file types and paths are excluded before ingestion.
- Deterministic redaction happens before persistence, embeddings, or generation.
- Immutable evidence is retained in the operator-owned database until that database is removed.
- Supporting quotes are internal, redacted, limited to 240 characters, and not rendered.
- Logs redact tokens, authorization data, prompts, content, quotes, passwords, and secrets.

## Network policy

Production egress should be restricted to:

- `dev.azure.com`;
- the configured `*.openai.azure.com` or `*.services.ai.azure.com` endpoint;
- PostgreSQL;
- Microsoft Entra token endpoints;
- required DNS and telemetry endpoints approved by the operator.

## Incident response

On suspected credential exposure, disable the workload identity or service principal, stop jobs, inspect Azure sign-in and Azure DevOps audit logs, rotate affected credentials, and verify no unauthorized branches or pull requests were created. Redacted retained evidence should be treated according to the operator's data-classification policy.
