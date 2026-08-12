# ONLYOFFICE Integration Tests

E2E tests for ONLYOFFICE integration plugins (Alfresco, Confluence, Jira, Liferay) on Playwright + TypeScript.

## Idea

Shared scenarios are written once against the `HostAdapter` interface and run
against each host system via Playwright projects. A new connector is just a
new adapter — it gets all the base scenarios for free.

```
packages/
  core/                # shared foundation: types, fixtures, EditorPage, verify/extractText
  adapter-alfresco/    # HostAdapter implementation for Alfresco (Share + REST API v1)
  adapter-confluence/  # HostAdapter implementation for Confluence
  adapter-jira/        # HostAdapter implementation for Jira
  adapter-liferay/     # HostAdapter implementation for Liferay
tests/
  global.setup.ts      # spins up a disposable stack (one system + Document Server)
  global.teardown.ts   # stops and removes that stack after the run
  stack.ts             # shared stack constants and docker helpers
  setup/<system>.ts    # per-system setup/teardown (docker compose, plugin install, DS wiring)
  setup/registry.ts    # maps --project=<system> to the right setup/teardown
  shared/              # cross-platform scenarios (run in every project)
  alfresco/, confluence/, jira/, liferay/   # system-specific scenarios
environments/          # stacks, one directory per system (alfresco/, confluence/, jira/, liferay/)
```

## Stack lifecycle

Each Playwright invocation targets exactly one system, chosen via `--project=<system>`
(that's what `npm run test:<system>` passes). `global.setup` before the tests:

1. Generates a JWT secret and starts Document Server (`DOCUMENTSERVER_IMAGE`).
2. Auto-detects the host IP: iterates over the machine's addresses and, via a
   hairpin check from the DS container, finds the one reachable by the containers.
   The address is passed to the tests via `process.env.<SYSTEM>_URL`.
3. Spins up that system's stack from `environments/<system>/docker-compose.yml`.
   Container names are unique per run: `onlyoffice-it-<id>-<system>-...`,
   `onlyoffice-it-<id>-ds` — parallel runs don't collide on names (orphaned
   stacks: `npm run stand:cleanup`).
4. Installs the plugin build(s) from `environments/<system>/artifacts/`, points
   the plugin at the Document Server's address and secret, and restarts as needed.
5. Verifies the plugin ↔ DS connection via the plugin's built-in validation.

`global.teardown` after the run: `docker compose down --volumes` + removing
the DS container — the stack is disposable and clean every time.

Only one system's stack is ever up at a time: their docker-compose stacks
publish the same fixed host ports (e.g. Alfresco and Confluence both use 8090;
Jira and Liferay both use 8080), so running two at once would fail to bind.
There is no command that runs every system in one invocation — run
`npm run test:<system>` once per system instead.

## Quick start

```bash
npm install
npx playwright install chromium
cp .env.example .env        # adjust versions and images
# put plugin build(s) into environments/alfresco/artifacts/ (see the README there)
npm run test:alfresco
npm run report
```

The first run takes longer: Alfresco/Confluence's cold start takes a few minutes.

## Conventions

- Test data setup (files, permissions) — only via the host system's REST API; UI is used only for what's under test.
- Login — once per worker, then via `storageState` (see `base.fixtures.ts`).
- Document scope is the canvas: input via `keyboard`, verification by downloading the file and parsing its content (`extractText`). Autocorrect capitalizes the first letter — test markers should start with a capital letter.
- Saving is asynchronous: after closing the editor we wait for the text to appear in the file content via `expect.poll` (the modified date changes on open already — it can't be used for waiting).
- Tags: `@smoke` — fast run (`npm run test:smoke -- --project=<system>`).

## How to add a new connector

1. `packages/adapter-<system>/` — implement `HostAdapter`.
2. `tests/fixtures.ts` — add `registerAdapter('<system>', ...)`.
3. `playwright.config.ts` — add a project with `testMatch: ['shared/**', '<system>/**']`.
4. `environments/<system>/docker-compose.yml` — the stack; add `tests/setup/<system>.ts`
   (setup/teardown) and register it in `tests/setup/registry.ts`.
5. `environments/<system>/artifacts/` — where the plugin build(s) to install are dropped.
6. `package.json` — add a `test:<system>` script (`playwright test --project=<system>`).
