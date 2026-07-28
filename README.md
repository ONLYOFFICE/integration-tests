# ONLYOFFICE Integration Tests

E2E tests for ONLYOFFICE integration plugins (Alfresco, Confluence, ...) on Playwright + TypeScript.

## Idea

Shared scenarios are written once against the `HostAdapter` interface and run
against each host system via Playwright projects. A new connector is just a
new adapter — it gets all the base scenarios for free.

```
packages/
  core/               # shared foundation: types, fixtures, EditorPage, docx handling
  adapter-alfresco/   # HostAdapter implementation for Alfresco (Share + REST API v1)
tests/
  global.setup.ts     # spins up a disposable stack (Alfresco + Document Server)
  global.teardown.ts  # stops and removes the stack after the run
  stack.ts            # shared stack constants and docker helpers
  shared/             # cross-platform scenarios (run in every project)
  alfresco/           # Alfresco-specific scenarios
environments/         # stack docker-compose and plugin AMP packages (amps/)
```

## Stack lifecycle

`global.setup` before the tests:

1. Spins up the Alfresco stack from `environments/docker-compose.alfresco.yml`
   (version — `ALFRESCO_VERSION` from `.env`), compose project `onlyoffice-tests`.
2. Generates a JWT secret and starts Document Server (`DOCUMENTSERVER_IMAGE`);
   the same secret and DS address go to the plugin via `JAVA_OPTS`
   (`-Donlyoffice.url`, `-Donlyoffice.security.key`).
3. Installs the plugin's AMP packages from `environments/amps/` into the
   alfresco/share containers (`alfresco-mmt`) and restarts them.
4. Verifies the plugin ↔ DS connection via the plugin's built-in validation.

`global.teardown` after the run: `docker compose down --volumes` + removing
the DS container — the stack is disposable and clean every time.

The `STACK_MANAGED=false` flag in `.env` disables Docker management — tests
will run against a stack you've already deployed manually.

## Quick start

```bash
npm install
npx playwright install chromium
cp .env.example .env        # adjust host IP, versions and images
# put plugin AMP builds into environments/amps/ (see the README there)
npm run test:alfresco
npm run report
```

The first run takes longer: Alfresco's cold start takes a few minutes.

## Conventions

- Test data setup (files, permissions) — only via the host system's REST API; UI is used only for what's under test.
- Login — once per worker, then via `storageState` (see `base.fixtures.ts`).
- Document scope is the canvas: input via `keyboard`, verification by downloading the file and parsing its content (`extractDocxText`). Autocorrect capitalizes the first letter — test markers should start with a capital letter.
- Saving is asynchronous: after closing the editor we wait for the text to appear in the file content via `expect.poll` (the modified date changes on open already — it can't be used for waiting).
- Tags: `@smoke` — fast run (`npm run test:smoke`).

## How to add a new connector

1. `packages/adapter-<system>/` — implement `HostAdapter`.
2. `tests/fixtures.ts` — add `registerAdapter('<system>', ...)`.
3. `playwright.config.ts` — add a project with `testMatch: ['shared/**', '<system>/**']`.
4. `environments/docker-compose.<system>.yml` — the stack, wire it into `global.setup`.
