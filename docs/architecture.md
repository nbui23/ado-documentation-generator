# Architecture

The application is a strict-boundary TypeScript modular monolith:

- `config` and `identity` validate non-secret configuration and acquire Microsoft Entra tokens.
- `ado` ingests Azure DevOps REST 7.1 evidence with pagination and bounded retry behavior.
- `db` stores immutable redacted snapshots, fragments, projections, trace edges, checkpoints, renders, run-stage audits, outbox records, and publication state.
- `evidence` fragments and validates exact supporting quotes.
- `generation` calls Azure OpenAI Responses with `store: false` and strict JSON Schema.
- `incremental` computes explicit invalidation and section fingerprints.
- `render` emits deterministic Markdown with revision-pinned Azure DevOps citations.
- `publication` maintains one lifecycle branch and draft PR through Azure DevOps APIs.

PostgreSQL is the only durable store. Explicit work-item-to-PR, PR-to-commit, and commit-to-file relationships are authoritative. Vector similarity can rank fragments only after graph traversal has established the authorized evidence pack.

`section_render` is authoritative for generated Markdown; workspace files are derived from committed renders and can be rematerialized after an interrupted run. Per-source checkpoint revisions live in normalized rows so unchanged runs do not rewrite a repository-sized JSON document.

## Trust boundaries

Repository content, work items, pull requests, commits, and existing documents are untrusted data. They are redacted before persistence or model use and are never treated as prompt instructions. Azure DevOps and Azure OpenAI hosts are allowlisted before bearer tokens are acquired or sent.
