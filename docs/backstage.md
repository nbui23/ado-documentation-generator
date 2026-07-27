# Backstage and TechDocs

The repository is ready for the Backstage Software Catalog through `catalog-info.yaml`. It registers:

- the `edgar` production component;
- the `developer-experience` system;
- the PostgreSQL resource;
- the owning `platform-engineering` group.

The component includes `backstage.io/techdocs-ref: dir:.`, with `mkdocs.yml` and this `docs/` tree as its TechDocs source.

## Register the component

Register the repository's `catalog-info.yaml` URL through the Backstage catalog UI or add it to the Backstage catalog's configured locations. Use Backstage's catalog location dry-run endpoint first in controlled environments.

For an existing production Backstage instance, apply `deploy/backstage/app-config.edgar.yaml`. It registers the catalog location, selects the external builder, and configures Azure Blob Storage through workload-owned environment settings.

The catalog descriptor is checked in CI together with every page referenced by `mkdocs.yml`.
CI also performs a strict TechDocs build with `mkdocs-techdocs-core` and publishes the generated site as part of the production artifact. The platform's promotion pipeline must copy that artifact to the object-storage publisher configured for the Backstage instance.

If your organization already owns the `platform-engineering` group or `developer-experience` system centrally, remove the duplicate Group/System documents from `catalog-info.yaml` and retain the same entity references.

## Production TechDocs

For production, use Backstage's external TechDocs builder and durable object-storage publisher. The Backstage backend should operate in read-only/external builder mode. This repository deliberately does not add the TechDocs Node CLI dependency tree to the application runtime; the isolated CI build uses the supported Python `mkdocs-techdocs-core` package.

Generated repository documentation remains under `generated-docs/`. Teams may add selected generated files to the TechDocs navigation after the first publication, but the stable operator documentation in `docs/` remains buildable even before Azure credentials are available.
