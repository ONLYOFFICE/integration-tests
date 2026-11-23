import * as fs from 'node:fs';
import * as path from 'node:path';
import { FORM_FIELD, FORM_NODE_TYPE } from '@adapters/drupal';
import { stackFor, waitForHttp } from '../stack';
import type { DocumentServer } from './document-server';
import { drupalDrush, drupalExec } from './drupal-drush';

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
const OWNER_USER = 'autotest4';
const OWNER_PASSWORD = 'automation123';

// The module's editor route needs both "view media" and "access media overview"; saving needs
// edit access to the media, which the module re-checks for the user in Document Server's callback.
const EDITOR_ROLE = { id: 'autotest_media_editor', permissions: 'view media,access media overview,edit any document media' };
const VIEWER_ROLE = { id: 'autotest_media_viewer', permissions: 'view media,access media overview' };
// Edits only its own documents, and can create them — so it is also offered "Save copy as"
const OWNER_ROLE = {
  id: 'autotest_media_owner',
  permissions: 'view media,access media overview,create document media,edit own document media',
};

const PRIVATE_FILES = '/opt/drupal/private';

// See tests/setup/nuxeo.ts: setup() overwrites DRUPAL_URL, so teardown() can't re-check it.
let reusingExisting = false;

function drush(...args: string[]): string {
  return drupalDrush(DRUPAL_CONTAINER, DRUPAL_URL, ...args);
}

/**
 * The container log and the watchdog, also saved into test-results/ (uploaded as an artifact by
 * .github/workflows/e2e.yml): the watchdog lives in the stack's database, which global.teardown
 * removes, and it holds what went wrong in Document Server's callbacks. The returned report keeps
 * only the tail of the container log; the whole log goes into its own file, written by docker
 * itself since it outgrows execSync's output buffer over a full run.
 */
function describeState(watchdogCount: number): string {
  const resultsDir = path.resolve(__dirname, '..', '..', 'test-results');
  const fullLog = path.join(resultsDir, `${DRUPAL_CONTAINER}.container.log`);
  const logs = stack.sh(`docker logs --tail 200 ${DRUPAL_CONTAINER} 2>&1`, { ignoreErrors: true });
  let watchdog = '';
  try {
    watchdog = drush('watchdog:show', `--count=${watchdogCount}`, '--extended');
  } catch (error) {
    watchdog = error instanceof Error ? error.message : String(error);
  }
  const report = `--- container log (tail):\n${logs || '(unavailable)'}\n--- watchdog:\n${watchdog || '(empty)'}`;
  try {
    fs.mkdirSync(resultsDir, { recursive: true });
    stack.sh(`docker logs ${DRUPAL_CONTAINER} > "${fullLog}" 2>&1`, { ignoreErrors: true });
    const logFile = path.join(resultsDir, `${DRUPAL_CONTAINER}.log`);
    fs.writeFileSync(logFile, report);
    return `${report}\n--- saved to ${logFile}, the whole container log to ${fullLog}`;
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

/**
 * The private file system, which a site sets up in settings.php: the forms scenarios store forms
 * and submissions in it, as a site that keeps submissions private does.
 */
function enablePrivateFiles(): void {
  console.log('[drupal] Setting up the private file system...');
  drupalExec(DRUPAL_CONTAINER, ['mkdir', '-p', PRIVATE_FILES], { user: 'root' });
  drupalExec(DRUPAL_CONTAINER, ['chown', 'www-data:www-data', PRIVATE_FILES], { user: 'root' });
  drupalExec(DRUPAL_CONTAINER, ['sh', '-c', 'cat >> web/sites/default/settings.php'], {
    user: 'root',
    input: `\n$settings['file_private_path'] = '${PRIVATE_FILES}';\n`,
  });
}

/** JSON:API and Basic Auth are what the adapter creates, reads and deletes test media through */
function enableModules(): void {
  console.log('[drupal] Enabling Media, JSON:API, Basic Auth and the ONLYOFFICE modules...');
  drush('pm:install', '-y', 'media', 'jsonapi', 'basic_auth', 'onlyoffice', 'onlyoffice_form');
  drush('config:set', '-y', 'jsonapi.settings', 'read_only', '0');
}

/**
 * A content type with an ONLYOFFICE form field, shown with the module's form formatter — where
 * visitors fill in and submit forms in the forms scenarios. Its own type: the standard profile of
 * Drupal 11.4 no longer creates Article.
 */
function addFormContentType(): void {
  console.log('[drupal] Adding a content type with an ONLYOFFICE form field...');
  drush(
    'php:eval',
    `\\Drupal\\node\\Entity\\NodeType::create(['type' => '${FORM_NODE_TYPE}', 'name' => 'Form page'])->save();
      \\Drupal\\field\\Entity\\FieldStorageConfig::create([
        'field_name' => '${FORM_FIELD}', 'entity_type' => 'node', 'type' => 'onlyoffice_form', 'cardinality' => 1,
      ])->save();
      \\Drupal\\field\\Entity\\FieldConfig::create([
        'field_name' => '${FORM_FIELD}', 'entity_type' => 'node', 'bundle' => '${FORM_NODE_TYPE}', 'label' => 'Form',
      ])->save();
      $repository = \\Drupal::service('entity_display.repository');
      $repository->getFormDisplay('node', '${FORM_NODE_TYPE}', 'default')
        ->setComponent('${FORM_FIELD}', ['type' => 'onlyoffice_form_widget'])->save();
      $repository->getViewDisplay('node', '${FORM_NODE_TYPE}', 'default')
        ->setComponent('${FORM_FIELD}', ['type' => 'onlyoffice_form_formatter', 'label' => 'hidden'])->save();`,
  );
}

function createUser(username: string, password: string, role: { id: string; permissions: string }): void {
  console.log(`[drupal] Creating test account (${username})...`);
  drush('role:create', role.id, role.id);
  drush('role:perm:add', role.id, role.permissions);
  drush('user:create', username, `--password=${password}`, `--mail=${username}@example.com`);
  drush('user:role:add', role.id, username);
}

/**
 * The module's preview formatter on the Document media page (/media/{id}, which Drupal only
 * serves with standalone_url on), open to anonymous visitors — what tests/drupal/preview.spec.ts
 * looks at.
 */
function enablePreview(): void {
  console.log('[drupal] Showing Document media with the ONLYOFFICE preview...');
  drush('config:set', '-y', 'media.settings', 'standalone_url', '1');
  drush('role:perm:add', 'anonymous', 'view media');
  drush(
    'php:eval',
    `\\Drupal::service('entity_display.repository')->getViewDisplay('media', 'document', 'default')
      ->setComponent('field_media_document', [
        'type' => 'onlyoffice_preview',
        'label' => 'hidden',
        'settings' => ['width_unit' => '%', 'width' => 100, 'height_unit' => 'px', 'height' => 640],
      ])
      ->save();`,
  );
}

/**
 * Russian under the /ru prefix, with the module's own translation imported from its .po file —
 * not from localize.drupal.org, so the stand needs no network for it.
 */
function enableRussian(): void {
  console.log('[drupal] Adding Russian with the module translation...');
  drush('pm:install', '-y', 'language', 'locale');
  drush('language:add', 'ru', '--skip-translations');
  // Absolute: drush runs from the web root, not from /opt/drupal
  drush('locale:import', 'ru', '/opt/drupal/web/modules/contrib/onlyoffice/translations/onlyoffice.ru.po');
  drush(
    'locale:import',
    'ru',
    '/opt/drupal/web/modules/contrib/onlyoffice/modules/onlyoffice-form/translations/onlyoffice_form.ru.po',
  );
}

/**
 * What the module signs its link keys with (OnlyofficeUrlHelper::getLinkSecret()), so that the
 * route scenarios can build keys the module would never hand out: expired, for a missing file…
 */
function publishLinkSecret(): void {
  process.env.DRUPAL_LINK_SECRET = drush(
    'php:eval',
    "echo \\Drupal\\Core\\Site\\Settings::getHashSalt() . \\Drupal::service('private_key')->get();",
  );
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
    enablePrivateFiles();
    enableModules();
    addFormContentType();
    createUser(SECOND_USER, SECOND_PASSWORD, EDITOR_ROLE);
    createUser(READONLY_USER, READONLY_PASSWORD, VIEWER_ROLE);
    createUser(OWNER_USER, OWNER_PASSWORD, OWNER_ROLE);
    enablePreview();
    enableRussian();
    publishLinkSecret();
    configureDocumentServer(ds);
    // The check converts a file in Document Server, which fails while it restarts its services
    await ds.startupFinished;
    verifyConnection();
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\n${describeState(50)}`);
  }

  process.env.DRUPAL_URL = DRUPAL_URL;
  process.env.DRUPAL_CONTAINER = DRUPAL_CONTAINER;
  console.log('[drupal] Stack ready');
}

/** Stops and fully removes the Drupal stack along with its volumes */
export function teardown(): void {
  if (reusingExisting) {
    return;
  }
  describeState(500);
  console.log('[drupal] Removing stack...');
  stack.sh(`docker compose -p ${stack.COMPOSE_PROJECT} -f ${stack.COMPOSE_FILE} down --volumes --remove-orphans`, {
    ignoreErrors: true,
  });
}
