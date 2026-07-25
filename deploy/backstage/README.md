# Backstage production overlay

Load `app-config.agent-docs.yaml` after the Backstage instance's base configuration.

- `AGENT_DOCS_CATALOG_URL` is the revision-controlled raw URL for this repository's `catalog-info.yaml`.
- `TECHDOCS_AZURE_BLOB_STORAGE_ACCOUNT_NAME` and `TECHDOCS_AZURE_BLOB_STORAGE_CONTAINER_NAME` identify the durable TechDocs publisher.
- Give the Backstage workload read-only blob access through Azure Workload Identity.
- Give the protected artifact-promotion identity write access to publish the CI-built TechDocs site.

The overlay deliberately selects `techdocs.builder: external`: the Backstage backend reads pre-generated content and does not execute repository-controlled MkDocs builds.
