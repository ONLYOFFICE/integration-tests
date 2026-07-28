# ONLYOFFICE Integration Tests

E2E tests for ONLYOFFICE integration plugins (Alfresco, Confluence, ...) using Playwright + TypeScript.

## Idea

Shared scenarios are written once against the `HostAdapter` interface and run
against every host system via Playwright projects. A new connector is just
a new adapter — it gets all the base scenarios for free.

```
packages/
  core/               # common foundation: types, fixtures, EditorPage, docx handling
  adapter-alfresco/   # HostAdapter implementation for Alfresco (Share + REST API v1)
tests/
  shared/             # cross-platform scenarios (run in every project)
  alfresco/           # Alfresco-specific scenarios
environments/         # docker-compose files for local environments
```

## Quick start

```bash
npm install
npx playwright install chromium
cp .env.example .env        # fill in the URL and credentials
npm run test:alfresco
npm run report
```

Environment requirements: Alfresco with the onlyoffice-alfresco plugin installed
and Document Server configured (see `environments/`).

## Conventions

- Data setup (files, permissions) — only via the host system's REST API; UI is used only for what's under test.
- Login — once per worker, then reused via `storageState` (see `base.fixtures.ts`).
- Document area — canvas: input via `keyboard`, verification — by downloading the file and parsing its content (`extractDocxText`).
- Saving is asynchronous: after closing the editor we wait for the callback via `adapter.waitForSave()`, no `waitForTimeout`.
- Tags: `@smoke` — quick run (`npm run test:smoke`).

## How to add a new connector

1. `packages/adapter-<system>/` — implement `HostAdapter`.
2. `tests/fixtures.ts` — add `registerAdapter('<system>', ...)`.
3. `playwright.config.ts` — add a project with `testMatch: ['shared/**', '<system>/**']`.
4. `environments/docker-compose.<system>.yml` — local environment.
