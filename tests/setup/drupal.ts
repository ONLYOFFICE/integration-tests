import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stackFor, waitForHttp } from '../stack';
import type { DocumentServer } from './document-server';

const stack = stackFor('drupal');
const DRUPAL_CONTAINER = `${stack.COMPOSE_PROJECT}-drupal-1`;
const DEFAULT_IMAGE = 'drupal:11-php8.4-apache';

let DRUPAL_URL = 'http://127.0.0.1:8070';
const ADMIN_USER = 'admin';
const ADMIN_PASSWORD = 'admin';
const SECOND_USER = 'autotest2';
const SECOND_PASSWORD = 'automation123';
const READONLY_USER = 'autotest3';
const READONLY_PASSWORD = 'automation123';

// The module's editor route needs both "view media" and "access media overview"; saving needs
// edit access to the media, which the module re-checks for the user in Document Server's callback.
const EDITOR_ROLE = { id: 'autotest_media_editor', permissions: 'view media,access media overview,edit any document media' };
const VIEWER_ROLE = { id: 'autotest_media_viewer', permissions: 'view media,access media overview' };

// See tests/setup/nuxeo.ts: setup() overwrites DRUPAL_URL, so teardown() can't re-check it.
let reusingExisting = false;

/**
 * Runs a command in the Drupal container. execFileSync rather than stack.sh(): arguments go to
 * docker as they are, without a shell (cmd.exe on Windows) mangling the quotes in PHP code.
 */
function exec(args: string[], options: { user?: string; input?: string } = {}): string {
  try {
    return execFileSync(
      'docker',
      ['exec', '-i', '-u', options.user ?? 'www-data', '-e', 'HOME=/tmp', '-w', '/opt/drupal', DRUPAL_CONTAINER, ...args],
      { encoding: 'utf8', input: options.input ?? '', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
  } catch (error) {
    const { stdout, stderr } = error as { stdout?: string; stderr?: string };
    throw new Error(`[drupal] ${args.join(' ')} failed:\n${[stdout, stderr].filter(Boolean).join('\n')}`);
  }
}

/** --uri makes the absolute URLs drush builds (e.g. for the connection check) use the stand's address */
function drush(...args: string[]): string {
  return exec(['vendor/bin/drush', `--uri=${DRUPAL_URL}`, ...args]);
}

/**
 * Logs to attach to a setup failure. Also saved into test-results/ (uploaded as an artifact by
 * .github/workflows/e2e.yml), because global.teardown removes the stack right after setup fails.
 */
function describeState(): string {
  const logs = stack.sh(`docker logs --tail 200 ${DRUPAL_CONTAINER} 2>&1`, { ignoreErrors: true });
  let watchdog = '';
  try {
    watchdog = drush('watchdog:show', '--count=50', '--extended');
  } catch (error) {
    watchdog = error instanceof Error ? error.message : String(error);
  }
  const report = `--- container log:\n${logs || '(unavailable)'}\n--- watchdog:\n${watchdog || '(empty)'}`;
  try {
    const logFile = path.resolve(__dirname, '..', '..', 'test-results', `${DRUPAL_CONTAINER}.log`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, report);
    return `${report}\n--- saved to ${logFile}`;
  } catch {
    return report;
  }
}

function installSite(): void {
  console.log('[drupal] Installing Drupal...');
  drush(
    'site:install',
    'standard',
    '-y',
    '--db-url=mysql://drupal:drupal@db:3306/drupal',
    '--site-name=ONLYOFFICE integration tests',
    '--site-mail=admin@example.com',
    `--account-name=${ADMIN_USER}`,
    `--account-pass=${ADMIN_PASSWORD}`,
    '--account-mail=admin@example.com',
  );
}

/** JSON:API and Basic Auth are what the adapter creates, reads and deletes test media through */
function enableModules(): void {
  console.log('[drupal] Enabling Media, JSON:API, Basic Auth and the ONLYOFFICE module...');
  drush('pm:install', '-y', 'media', 'jsonapi', 'basic_auth', 'onlyoffice');
  drush('config:set', '-y', 'jsonapi.settings', 'read_only', '0');
}

function createUser(username: string, password: string, role: { id: string; permissions: string }): void {
  console.log(`[drupal] Creating test account (${username})...`);
  drush('role:create', role.id, role.id);
  drush('role:perm:add', role.id, role.permissions);
  drush('user:create', username, `--password=${password}`, `--mail=${username}@example.com`);
  drush('user:role:add', role.id, username);
}

/**
 * Points the module at the Document Server — the same settings its form saves. Neither the
 * internal Docs address nor the storage address is needed: Drupal, the browser and Document
 * Server all reach each other through the shared host IP.
 */
function configureDocumentServer(ds: DocumentServer): void {
  console.log('[drupal] Configuring the module to use the Document Server...');
  drush('config:set', '-y', 'onlyoffice.settings', 'doc_server_url', ds.url);
  drush('config:set', '-y', 'onlyoffice.settings', 'doc_server_jwt', ds.secret);
  drush('config:set', '-y', 'onlyoffice.settings', 'doc_server_jwt_header', ds.header);
  drush('cache:rebuild');
}

/**
 * The module's own connection check, the one its settings form runs on save: Docs version,
 * a command request and a conversion of a file Docs downloads from Drupal, all signed with the
 * secret. It throws on any failure.
 */
function verifyConnection(): void {
  console.log('[drupal] Checking the connection to the Document Server...');
  const version = drush('php:eval', 'echo \\Drupal::service("onlyoffice.document_service")->checkConnection();');
  console.log(`[drupal] Connected, Document Server ${version}`);
}

export async function setup(ds: DocumentServer): Promise<void> {
  reusingExisting = Boolean(process.env.DRUPAL_URL);
  if (reusingExisting) {
    console.log(`[drupal] Using existing Drupal at ${process.env.DRUPAL_URL} (DRUPAL_URL is set) — skipping stack setup`);
    return;
  }

  const image = process.env.DRUPAL_IMAGE || DEFAULT_IMAGE;
  // Mirrored into process.env so teardown's `docker compose down` resolves the same compose file
  process.env.DRUPAL_IMAGE = image;
  DRUPAL_URL = `http://${ds.host}:8070`;

  console.log(`[drupal] Starting Drupal (${image}, project ${stack.COMPOSE_PROJECT})...`);
  stack.sh(`docker compose -p ${stack.COMPOSE_PROJECT} -f ${stack.COMPOSE_FILE} up -d --build --quiet-pull --wait`, {
    env: { DRUPAL_IMAGE: image },
  });
  // Before the install Drupal answers every page with a redirect to the installer
  await waitForHttp('Drupal', DRUPAL_URL, (response) => response.status < 500, 300_000);

  try {
    installSite();
    enableModules();
    createUser(SECOND_USER, SECOND_PASSWORD, EDITOR_ROLE);
    createUser(READONLY_USER, READONLY_PASSWORD, VIEWER_ROLE);
    configureDocumentServer(ds);
    verifyConnection();
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${describeState()}`);
  }

  process.env.DRUPAL_URL = DRUPAL_URL;
  console.log('[drupal] Stack ready');
}

/** Stops and fully removes the Drupal stack along with its volumes */
export function teardown(): void {
  if (reusingExisting) {
    return;
  }
  console.log('[drupal] Removing stack...');
  stack.sh(`docker compose -p ${stack.COMPOSE_PROJECT} -f ${stack.COMPOSE_FILE} down --volumes --remove-orphans`, {
    ignoreErrors: true,
  });
}
