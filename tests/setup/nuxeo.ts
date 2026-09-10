import * as fs from 'node:fs';
import * as path from 'node:path';
import { NuxeoApi, WORKSPACE_PATH } from '@adapters/nuxeo';
import { stackFor } from '../stack';
import type { DocumentServer } from './document-server';

const stack = stackFor('nuxeo');
const NUXEO_CONTAINER = `${stack.COMPOSE_PROJECT}-nuxeo-1`;

let NUXEO_URL = 'http://127.0.0.1:8080';
// Nuxeo's built-in administrator account
const ADMIN_USER = 'Administrator';
const ADMIN_PASSWORD = 'Administrator';
const SECOND_USER = 'autotest2';
const SECOND_PASSWORD = 'automation123';
const READONLY_USER = 'autotest3';
const READONLY_PASSWORD = 'automation123';

// Where environments/nuxeo/Dockerfile puts the package build from artifacts/ — the path
// NUXEO_PACKAGES in docker-compose.yml points the image's entrypoint at.
const LOCAL_PACKAGES_DIR = '/opt/nuxeo/local-packages';

// setup() publishes the fresh stack's address via process.env.NUXEO_URL for the fixtures to pick
// up, so teardown() can't tell "reused" from "just started" by re-checking that var — captured up
// front, before setup() overwrites it.
let reusingExisting = false;

function adminApi(): NuxeoApi {
  return new NuxeoApi(NUXEO_URL, { username: ADMIN_USER, password: ADMIN_PASSWORD });
}

/** The package build to install — the first .zip in environments/nuxeo/artifacts */
function findPluginPackage(): string {
  const artifactsDir = path.join(stack.ENV_DIR, 'artifacts');
  const artifactName = fs.existsSync(artifactsDir) && fs.readdirSync(artifactsDir).find((name) => name.endsWith('.zip'));
  if (!artifactName) {
    throw new Error(`[nuxeo] No package .zip found in ${artifactsDir} — see artifacts/README.md`);
  }
  return artifactName;
}

/** Nuxeo's log, both streams (stack.sh() captures stdout only) */
function containerLogs(): string {
  return stack.sh(`docker logs ${NUXEO_CONTAINER} 2>&1`, { ignoreErrors: true });
}

function containerState(): string {
  return stack.sh(`docker inspect -f "{{.State.Status}}" ${NUXEO_CONTAINER}`, { ignoreErrors: true });
}

/**
 * What to attach to a startup failure: the container's state, whether the package zip actually
 * made it into the image, and the tail of Nuxeo's log — a bare timeout can't tell "the CLID was
 * rejected", "mp-install failed" and "Nuxeo is just slow" apart.
 *
 * The whole log is dumped into test-results/ as well (uploaded as an artifact by
 * .github/workflows/e2e.yml): global.teardown removes the stack as soon as setup fails, so by the
 * time anything downstream goes looking for the container, it is already gone.
 */
function describeStartupState(): string {
  const listing = stack.sh(`docker exec ${NUXEO_CONTAINER} ls -l ${LOCAL_PACKAGES_DIR}`, { ignoreErrors: true });
  const logs = containerLogs();
  const report = [
    `--- container state: ${containerState() || '(unavailable)'}`,
    `--- ${LOCAL_PACKAGES_DIR}:`,
    listing || '(unavailable)',
    '--- last log lines:',
    logs.split('\n').slice(-60).join('\n') || '(unavailable)',
  ];
  try {
    const logFile = path.resolve(__dirname, '..', '..', 'test-results', `${NUXEO_CONTAINER}.log`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, logs);
    report.push(`--- full log saved to ${logFile}`);
  } catch (error) {
    report.push(`--- could not save the full log: ${error instanceof Error ? error.message : String(error)}`);
  }
  return report.join('\n');
}

/**
 * Waits for /nuxeo/runningstatus to answer 200 (it's 503 until every component is up, and
 * connection-refused while the entrypoint is still installing packages). Unlike waitForHttp, this
 * also watches the container itself: a rejected CLID or a failing mp-install makes the entrypoint
 * exit, and that must surface right away with the log instead of after the full timeout.
 */
async function waitForNuxeo(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    const state = containerState();
    if (state && state !== 'running' && state !== 'created' && state !== 'restarting') {
      throw new Error(`[nuxeo] Container ${NUXEO_CONTAINER} is ${state} — startup failed\n${describeStartupState()}`);
    }
    try {
      const response = await fetch(`${NUXEO_URL}/nuxeo/runningstatus`, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`[nuxeo] Nuxeo not ready after ${timeoutMs / 1000}s (${lastError})\n${describeStartupState()}`);
}

/** The plugin's own unauthenticated endpoint — answers only once its bundles are deployed */
async function verifyPluginDeployed(api: NuxeoApi): Promise<void> {
  console.log('[nuxeo] Checking that the ONLYOFFICE package is deployed...');
  try {
    await api.request('/onlyoffice/formats');
  } catch (error) {
    throw new Error(`[nuxeo] The ONLYOFFICE package does not answer: ${error}\n${describeStartupState()}`);
  }
}

/** Creates an unprivileged test account (member of `members`) unless it already exists */
async function ensureUser(api: NuxeoApi, username: string, password: string, lastName: string): Promise<void> {
  const existing = await fetch(`${NUXEO_URL}/nuxeo/api/v1/user/${username}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString('base64')}` },
  });
  if (existing.ok) {
    return;
  }
  console.log(`[nuxeo] Creating test account (${username})...`);
  await api.request('/user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      'entity-type': 'user',
      id: username,
      properties: {
        username,
        password,
        firstName: 'Autotest',
        lastName,
        email: `${username}@example.com`,
        groups: ['members'],
      },
    }),
  });
}

/**
 * The workspace every test document lives in (WORKSPACE_PATH, shared with the adapter), with an
 * ACL of its own: inheritance blocked so whatever Nuxeo grants `members` on the Workspaces root
 * by default doesn't leak in, then secondUser ReadWrite (co-editing scenarios open files it
 * doesn't own) and readOnlyUser Read (it must be able to open, but never edit).
 */
async function ensureWorkspace(api: NuxeoApi): Promise<void> {
  const name = WORKSPACE_PATH.split('/').pop()!;
  const parent = WORKSPACE_PATH.slice(0, -(name.length + 1));

  const existing = await fetch(`${NUXEO_URL}/nuxeo/api/v1/path${WORKSPACE_PATH}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${ADMIN_USER}:${ADMIN_PASSWORD}`).toString('base64')}` },
  });
  if (existing.ok) {
    return;
  }

  console.log(`[nuxeo] Creating workspace ${WORKSPACE_PATH}...`);
  const response = await api.request(`/path${parent}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      'entity-type': 'document',
      name,
      type: 'Workspace',
      properties: { 'dc:title': 'Integration Tests' },
    }),
  });
  const { uid } = (await response.json()) as { uid: string };

  await api.blockPermissionInheritance(uid);
  await api.addPermission(uid, SECOND_USER, 'ReadWrite');
  await api.addPermission(uid, READONLY_USER, 'Read');
}

type ValidationResults = Record<string, { status?: string; error?: unknown }>;

/** One save of the package settings; returns its connection-validation results (see configureDocumentServer) */
async function saveSettings(api: NuxeoApi, settings: unknown): Promise<{ body: Record<string, any>; results: ValidationResults }> {
  const response = await api.request('/onlyoffice/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(settings),
  });
  const body = (await response.json().catch(() => ({}))) as Record<string, any>;
  return { body, results: (body.validationResults ?? {}) as ValidationResults };
}

function failedChecks(results: ValidationResults): string[] {
  return Object.entries(results)
    .filter(([, result]) => !result || typeof result !== 'object' || String(result.status).toLowerCase() !== 'success')
    .map(([name]) => name);
}

/**
 * Points the package at the Document Server through its own settings endpoint (Administrator
 * only) — the same call its Web UI settings page makes. Saving runs the package's connection
 * validation (Document Server reachable, its command and convert services answering with this
 * secret), whose results come back in the response and are what verifies the wiring here.
 *
 * The convert-service check is expected to fail on the very first save and pass on the second:
 * it has Document Server download a test file from Nuxeo through a URL carrying a freshly acquired
 * Nuxeo authentication token — acquired inside the same request (transaction) that is still
 * running while Document Server fetches, so that token isn't committed yet and Nuxeo answers 401
 * (Document Server then reports error DOWNLOADING). Nuxeo hands the same token out again to the
 * same user/application, so a second save reuses the now-committed one and the check goes
 * through. Any other failure, or a repeat of that one, is a genuine misconfiguration.
 */
async function configureDocumentServer(api: NuxeoApi, ds: DocumentServer): Promise<void> {
  console.log('[nuxeo] Configuring the package to use the Document Server...');
  const current = (await (await api.request('/onlyoffice/settings')).json()) as {
    security?: Record<string, unknown>;
    [key: string]: unknown;
  };
  const settings = {
    ...current,
    url: ds.url,
    security: { ...(current.security ?? {}), key: ds.secret, header: ds.header },
  };

  let { body, results } = await saveSettings(api, settings);
  let failed = failedChecks(results);
  if (failed.length === 1 && failed[0] === 'convertService' && results.convertService?.error === 'DOWNLOADING') {
    console.log('[nuxeo] Convert-service check raced its own token commit (expected on the first save) — saving again...');
    ({ body, results } = await saveSettings(api, settings));
    failed = failedChecks(results);
  }
  if (!Object.keys(results).length || failed.length) {
    throw new Error(`[nuxeo] Document Server connection check failed (${failed.join(', ') || 'no results'}): ${JSON.stringify(body)}`);
  }
}

export async function setup(ds: DocumentServer): Promise<void> {
  reusingExisting = Boolean(process.env.NUXEO_URL);
  if (reusingExisting) {
    console.log(`[nuxeo] Using existing Nuxeo at ${process.env.NUXEO_URL} (NUXEO_URL is set) — skipping stack setup`);
    return;
  }

  if (!process.env.NUXEO_IMAGE) {
    throw new Error(
      '[nuxeo] NUXEO_IMAGE must be set in .env to a Docker image tag ' +
        '(e.g. "docker-private.packages.nuxeo.com/nuxeo/nuxeo:2025" — run `docker login` for that registry first)',
    );
  }
  if (!process.env.NUXEO_CLID?.trim()) {
    throw new Error(
      '[nuxeo] NUXEO_CLID must be set in .env: the Nuxeo Connect CLID, its two lines joined with "--" — ' +
        'the nuxeo-web-ui package the ONLYOFFICE package depends on is downloaded from Connect on first start',
    );
  }
  const pluginPackage = findPluginPackage();

  NUXEO_URL = `http://${ds.host}:8080`;
  // Mirrored into process.env so teardown's `docker compose down` resolves the same compose file
  process.env.NUXEO_PLUGIN_PACKAGE = pluginPackage;

  console.log(`[nuxeo] Starting Nuxeo (${process.env.NUXEO_IMAGE} + ${pluginPackage}, project ${stack.COMPOSE_PROJECT})...`);
  stack.sh(`docker compose -p ${stack.COMPOSE_PROJECT} -f ${stack.COMPOSE_FILE} up -d --build --quiet-pull`, {
    env: {
      NUXEO_IMAGE: process.env.NUXEO_IMAGE,
      NUXEO_CLID: process.env.NUXEO_CLID,
      NUXEO_PLUGIN_PACKAGE: pluginPackage,
    },
  });

  console.log('[nuxeo] Waiting for Nuxeo (first start installs nuxeo-web-ui and the package — this takes several minutes)...');
  await waitForNuxeo(900_000);

  const api = adminApi();
  await verifyPluginDeployed(api);
  await ensureUser(api, SECOND_USER, SECOND_PASSWORD, 'Second');
  await ensureUser(api, READONLY_USER, READONLY_PASSWORD, 'ReadOnly');
  await ensureWorkspace(api);
  await configureDocumentServer(api, ds);

  process.env.NUXEO_URL = NUXEO_URL;
  console.log('[nuxeo] Stack ready');
}

/** Stops and fully removes the Nuxeo stack along with its volumes */
export function teardown(): void {
  if (reusingExisting) {
    return;
  }
  console.log('[nuxeo] Removing stack...');
  stack.sh(`docker compose -p ${stack.COMPOSE_PROJECT} -f ${stack.COMPOSE_FILE} down --volumes --remove-orphans`, {
    ignoreErrors: true,
  });
}
