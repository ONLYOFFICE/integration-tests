# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

E2E tests for ONLYOFFICE integration plugins (Alfresco, Confluence, ...) built on
Playwright + TypeScript. Shared scenarios are written once against a `HostAdapter`
interface and run against each host system via Playwright projects — adding a new
connector means implementing the adapter, not rewriting scenarios.

## Commands

```bash
npm install
npx playwright install chromium
cp .env.example .env              # adjust versions/images

npm run test:alfresco             # run against Alfresco only
npm run test:confluence           # run against Confluence only
npm run test:smoke                # fast subset, tag @smoke, any project via --project=
npx playwright test <file>        # single spec file
npx playwright test -g "<title>"  # single test by title substring

npm run report                    # open the last HTML report
npm run typecheck                 # tsc --noEmit
npm run stand:cleanup             # remove orphaned onlyoffice-it-* containers/networks/volumes
```

There is no lint script configured. Running the full `npm test` (no `--project`)
spins up every system's stack in the same run.

Docker must be running; the first run per system is slow (Alfresco/Confluence cold
start takes a few minutes — global setup waits up to 900s for it).

## Architecture

```
packages/
  core/                    # shared foundation, imported as "@core"
    types.ts               #   HostAdapter interface + FileRef/FileType/TestUser
    editor/editor.page.ts  #   EditorPage: wraps the DS iframe (#toolbar, canvas typing, save)
    fixtures/base.fixtures.ts  # createFile/openEditor fixtures, worker-scoped adapter+login
    verify/                #   extractText(type, buffer) -> docx/xlsx/pptx text extraction
  adapter-alfresco/        # HostAdapter impl for Alfresco, imported as "@adapters/alfresco"
  adapter-confluence/      # HostAdapter impl for Confluence, imported as "@adapters/confluence"
tests/
  fixtures.ts              # registerAdapter() wiring — the join point between config and adapters
  global.setup.ts / global.teardown.ts   # orchestrate stack lifecycle for selected systems
  stack.ts                 # per-run container/compose-project naming, sh() helpers, waitForHttp()
  setup/<system>.ts        # one file per system: docker compose up, plugin install, DS wiring
  setup/registry.ts        # selectedSystems() reads --project= from argv to decide what to boot
  shared/*.spec.ts         # cross-platform scenarios — run against every registered project
  <system>/*.spec.ts       # system-specific scenarios (matched only for that project)
environments/<system>/     # docker-compose.yml + artifacts/ (plugin builds) per host system
resources/files/           # blank docx/xlsx/pptx templates used by createFile()
```

### Stack lifecycle (global.setup / global.teardown)

1. `startDocumentServer()` starts one shared Document Server container with a fresh
   JWT secret, then auto-detects the host IP by exec'ing a hairpin curl from inside
   the DS container against each of the host's addresses — this IP is what both the
   browser and the host-system containers use to reach each other and DS.
2. For each selected system (`tests/setup/registry.ts`, derived from `--project=` in
   Playwright's argv — no flag means all systems), `tests/setup/<system>.ts` runs:
   spin up that system's `docker-compose.yml`, install the ONLYOFFICE plugin
   artifact(s), point the plugin at Document Server's URL/secret, verify the
   connection via the plugin's own validation endpoint, and publish the resulting
   base URL via `process.env.<SYSTEM>_URL` (workers inherit `process.env`).
3. Everything is name-scoped per run via `OIT_RUN_ID` (`tests/stack.ts`):
   `onlyoffice-it-<runId>-<system>-...`, so parallel/CI runs never collide. Orphaned
   stacks (e.g. after a killed run) are swept with `npm run stand:cleanup`.
4. `global.teardown.ts` runs `docker compose down --volumes --remove-orphans` per
   system plus removing the DS container — the whole stack is disposable.

### Adding a new connector

1. `packages/adapter-<system>/src/` — implement `HostAdapter` (`packages/core/src/types.ts`):
   login, createFile (via REST API), openInEditor, downloadFile, getModifiedAt,
   waitForSave, deleteFile.
2. `tests/fixtures.ts` — add a `registerAdapter('<system>', () => new XAdapter(...))`.
3. `playwright.config.ts` — add a project with
   `testMatch: ['shared/**/*.spec.ts', '<system>/**/*.spec.ts']`.
4. `environments/<system>/docker-compose.yml` — the stack; add `tests/setup/<system>.ts`
   (setup/teardown) and register it in `tests/setup/registry.ts`.
5. `environments/<system>/artifacts/` — where the plugin build(s) to install are dropped
   (see that directory's own README for the expected filename pattern).

### Conventions that shape the tests

- Test data setup (files, permissions) goes through the host system's REST API only;
  UI is exercised only for the behavior actually under test.
- Login happens once per worker, then is reused via Playwright's `storageState`
  (`packages/core/src/fixtures/base.fixtures.ts`).
- The document body is a canvas, not DOM: input goes through `page.keyboard`, and
  verification downloads the file and parses it (`extractText` /
  `packages/core/src/verify/*`). The editor's autocorrect capitalizes the first
  letter of typed text, so test markers should start with a capital letter or the
  content match will silently fail.
- Saving is asynchronous — Document Server delivers the callback after the editing
  session (tab) closes. Wait for content via `expect.poll(...)`, not for the
  modified-date to change (it already changes on open, due to the lock aspect, so
  it can't signal "saved").
- `@smoke`-tagged tests are the fast subset (`npm run test:smoke`); typically only one
  file type (docx) is tagged, since xlsx/pptx exercise the same save path.
- `baseURL` and `storageState` are resolved per-worker from the adapter (set once the
  stack address is known in global setup), not from static `playwright.config.ts` values.
