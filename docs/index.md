# Agent Documentation Generator

`agent-docs` creates evidence-backed developer and business documentation for one Azure DevOps repository. It ingests immutable, redacted evidence; constructs explicit requirement-to-code trace links; generates citation-validated Markdown; and can maintain one draft documentation pull request.

## Operator workflow

1. Create the configuration template with `agent-docs init`.
2. Set `DATABASE_URL` and configure Microsoft Entra credentials through the supported Azure Identity environment.
3. Apply migrations with `agent-docs db migrate`.
4. Run `agent-docs validate`.
5. Execute a dry run with `agent-docs run`.
6. Enable draft-PR publication with `agent-docs run --publish`.

The application never supports personal access tokens, writes directly to the target branch, force-pushes, or automatically completes pull requests.

## Documentation map

- [Architecture](architecture.md)
- [Production operations](operations.md)
- [Security model](security.md)
- [Backstage and TechDocs](backstage.md)
- [Disaster recovery](disaster-recovery.md)
