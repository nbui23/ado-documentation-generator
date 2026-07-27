# Contributing

Contributions are welcome through GitHub issues and pull requests.

## Before opening a change

- Search existing issues and keep proposals focused.
- Never include credentials, proprietary source code, prompts, production evidence, or unsanitized
  logs.
- Discuss broad architecture changes in an issue before implementation.

## Development

Use Node.js 24 and install the locked dependencies:

```sh
npm ci
```

Before submitting a pull request, run:

```sh
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm audit --audit-level=high
```

The PostgreSQL suite additionally requires Docker:

```sh
EDGAR_TESTCONTAINERS=true npm run test:database
```

Keep changes small, preserve existing security boundaries, and add the smallest regression test
that proves non-trivial behavior.
