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

npm run test:alfresco              # run against Alfresco only
npm run test:confluence            # run against Confluence only
npm run test:jira                  # run against Jira only
npm run test:liferay               # run against Liferay only
npm run test:mattermost            # run against Mattermost only
npm run test:smoke -- --project=<system>       # fast subset, tag @smoke, for one system
npx playwright test <file> --project=<system>        # single spec file
npx playwright test -g "<title>" --project=<system>  # single test by title substring

npm run report                    # open the last HTML report
npm run typecheck                 # tsc --noEmit
npm run stand:cleanup             # remove orphaned onlyoffice-it-* containers/networks/volumes
```

There is no lint script configured, and no "run everything" command: each
Playwright invocation is only ever allowed to target one system —
`tests/global.setup.ts` throws if `--project` is omitted or more than one system
is selected. This is deliberate, not an oversight: each system's
`environments/<system>/docker-compose.yml` publishes fixed host ports (e.g.
Alfresco and Confluence both use 8090; Jira and Liferay both use 8080), so two
systems' stands up at the same time would fail to bind. Run one system at a
time via `npm run test:<system>`.

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
  global.setup.ts / global.teardown.ts   # orchestrate stack lifecycle for the selected system
  stack.ts                 # per-run container/compose-project naming, sh() helpers, waitForHttp()
  setup/<system>.ts        # one file per system: docker compose up, plugin install, DS wiring
  setup/registry.ts        # selectedSystems() reads --project= from argv to decide what to boot
  shared/*.spec.ts         # cross-platform scenarios — run against every registered project
  <system>/*.spec.ts       # system-specific scenarios (matched only for that project)
environments/<system>/     # docker-compose.yml + artifacts/ (plugin builds) per host system
resources/files/           # blank docx/xlsx/pptx templates used by createFile()
```

### Stack lifecycle (global.setup / global.teardown)

Each Playwright invocation targets exactly one system (`tests/global.setup.ts`
throws otherwise — see Commands above).

1. `startDocumentServer()` starts a Document Server container with a fresh JWT
   secret, then auto-detects the host IP — the address both the browser and the
   host-system containers use to reach each other and DS. Candidates are the
   machine's own interfaces plus the docker host as seen from inside a container
   (network gateways, `host.docker.internal`), the latter being the only workable
   answer when the tests themselves run inside a container (CI). Each candidate is
   probed from both sides — a hairpin curl from the DS container and a `fetch` from
   the test process — since an address only one side can reach silently breaks either
   the browser or the DS callbacks. `OIT_HOST_IP` pins it if the probe comes up empty.
2. The selected system (`tests/setup/registry.ts`, derived from the required
   `--project=` in Playwright's argv), via `tests/setup/<system>.ts`: spin up that
   system's `docker-compose.yml`, install the ONLYOFFICE plugin artifact(s), point
   the plugin at Document Server's URL/secret, verify the connection via the
   plugin's own validation endpoint, and publish the resulting base URL via
   `process.env.<SYSTEM>_URL` (workers inherit `process.env`).
3. Everything is name-scoped per run via `OIT_RUN_ID` (`tests/stack.ts`):
   `onlyoffice-it-<runId>-<system>-...`, so parallel/CI runs never collide. Orphaned
   stacks (e.g. after a killed run) are swept with `npm run stand:cleanup`.
4. `global.teardown.ts` runs `docker compose down --volumes --remove-orphans` for
   the system plus removing the DS container — the whole stack is disposable.

To test another system, run its own `npm run test:<system>` command afterwards —
there is no command that runs multiple systems in one invocation (see Commands).

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
6. `package.json` — add a `test:<system>` script (`playwright test --project=<system>`).

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
- `@smoke`-tagged tests are the fast subset (`npm run test:smoke -- --project=<system>`);
  typically only one file type (docx) is tagged, since xlsx/pptx exercise the same save path.
- `baseURL` and `storageState` are resolved per-worker from the adapter (set once the
  stack address is known in global setup), not from static `playwright.config.ts` values.
