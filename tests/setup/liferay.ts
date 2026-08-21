import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { EDITOR_PORTLET_ID } from '@adapters/liferay';
import { stackFor, waitForHttp } from '../stack';
import type { DocumentServer } from './document-server';

const stack = stackFor('liferay');
const LIFERAY_CONTAINER = `${stack.COMPOSE_PROJECT}-liferay-1`;
// Liferay's default bundled admin account — logins are by email address (company.security.auth.type
// defaults to "emailAddress"), so this doubles as the login for TestUser.username elsewhere.
const ADMIN_USER = 'test@liferay.com';
// The bundled demo database ships this account with a forced "change your password" prompt on its
// very first login. Depending on the LIFERAY_PASSWORDS_PERIOD_DEFAULT_PERIOD_POLICY_PERIOD_*
// overrides in docker-compose.yml, that prompt may or may not actually appear — so the password
// this file authenticates admin calls with is only known once completeInitialAdminPasswordReset
// has run (adminPassword starts as the bootstrap value and is bumped to ADMIN_TARGET_PASSWORD only
// if a reset actually happened). That outcome is published via process.env.LIFERAY_PASSWORD (see
// the end of setup() below) for fixtures.ts to pick up — Playwright workers are separate processes
// from the one running this setup, so process.env is the only channel to hand them that value.
const ADMIN_BOOTSTRAP_PASSWORD = 'test';
const ADMIN_TARGET_PASSWORD = 'Automation1';
let adminPassword = ADMIN_BOOTSTRAP_PASSWORD;
const SECOND_USER = 'autotest2@example.com';
const SECOND_PASSWORD = 'automation123';
const READONLY_USER = 'autotest3@example.com';
const READONLY_PASSWORD = 'automation123';
// Liferay's paid distribution is published as `liferay/dxp` (vs. the free `liferay/portal`) and
// enforces a license — see requireLicenseIfDxp/installLicense.
const LICENSE_FILE = 'license.xml';
// The two watched directories inside the container everything is shipped into — see
// shipToContainer for why this goes over `docker cp` rather than a compose bind mount.
const DEPLOY_DIR = '/opt/liferay/deploy';
const OSGI_CONFIGS_DIR = '/opt/liferay/osgi/configs';

function isDxpImage(image: string): boolean {
  return image.includes('/dxp');
}

// OSGi bundle symbolic names for our plugins are namespaced under this prefix — see the
// AutoDeployScanner/fileinstall log lines this is matched against in installPlugin
const PLUGIN_BUNDLE_PREFIX = 'com.onlyoffice.';
// Configuration Admin PID backing the plugin's system settings (Control Panel > System Settings >
// Connectors > ONLYOFFICE) — see OSGI-INF/metatype/com.onlyoffice.liferay.docs.config.OnlyOfficeConfiguration.xml
// in the plugin jar. The plugin exposes no configuration REST endpoint, so no admin login is
// needed here: this PID's scope is SYSTEM (a singleton, no factory instance id), which is exactly
// what Liferay's static-config-file convention supports — see configureDocumentServer.
const CONFIG_PID = 'com.onlyoffice.liferay.docs.config.OnlyOfficeConfiguration';

// setup() publishes the fresh stack's address via process.env.LIFERAY_URL for the fixtures to
// pick up, so teardown() can't tell "reused" from "just started" by re-checking that var — it
// has to be captured up front, before setup() overwrites it.
let reusingExisting = false;

/**
 * Ships the plugin artifact from environments/liferay/artifacts into the container's
 * /opt/liferay/deploy (see shipToContainer), triggering Liferay's hot deploy, then waits for the
 * AutoDeployScanner to pick it up and start its OSGi bundle — e.g.
 *   AutoDeployDir: Processing liferay-docs-3.1.0.jar
 *   BundleStartStopLogger: STARTED com.onlyoffice.liferay-docs_3.1.0 [1391]
 * Done after the web interface is up so the deploy watcher is already running and can pick up the
 * new file immediately, rather than racing it during Liferay's own startup. Only log lines from
 * after the matching "Processing <artifactName>" line are inspected, so unrelated ERRORs from
 * other bundles earlier in the (already-running) container don't trip this up. Throws on an
 * ERROR line appearing before STARTED, or on timeout — with describeDeployState() attached, since
 * a timeout on its own can't tell "the file never arrived" from "Liferay ignored it".
 *
 * The log is read via containerLogs(), which merges stderr in: stack.sh() captures stdout only,
 * and depending on the image Liferay's lines come out on either stream.
 */
async function installPlugin(): Promise<void> {
  const artifactsDir = path.join(stack.ENV_DIR, 'artifacts');
  const artifactName = fs.readdirSync(artifactsDir).find((name) => name.endsWith('.jar'));
  if (!artifactName) {
    throw new Error(`[liferay] No plugin .jar found in ${artifactsDir} — see artifacts/README.md`);
  }

  console.log(`[liferay] Deploying plugin ${artifactName}...`);
  shipToContainer(path.join(artifactsDir, artifactName), DEPLOY_DIR);

  console.log(`[liferay] Waiting for ${artifactName} to start...`);
  const marker = `Processing ${artifactName}`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    const logs = containerLogs();
    const processingIndex = logs.lastIndexOf(marker);
    if (processingIndex !== -1) {
      const sinceProcessing = logs.slice(processingIndex);
      if (sinceProcessing.includes(`STARTED ${PLUGIN_BUNDLE_PREFIX}`)) {
        console.log(`[liferay] Plugin ${artifactName} started`);
        return;
      }
      const lines = sinceProcessing.split('\n');
      const errorIndex = lines.findIndex((line) => /\bERROR\b/.test(line));
      if (errorIndex !== -1) {
        // ERROR lines are followed by an unprefixed exception + stack trace (see the sample in
        // the bug report this was written against) — collect it all, up to the next timestamped
        // log line, so the thrown error carries the actual cause instead of just its header.
        const block = [lines[errorIndex]];
        for (let i = errorIndex + 1; i < lines.length && !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(lines[i]); i++) {
          block.push(lines[i]);
        }
        throw new Error(`[liferay] Plugin ${artifactName} failed to start:\n${block.join('\n').trim()}`);
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`[liferay] Plugin ${artifactName} did not start within 120s\n${describeDeployState()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/**
 * Ships the DXP license (environments/liferay/artifacts/license.xml, checked to exist by
 * requireLicenseIfDxp) into the container's /opt/liferay/deploy (see shipToContainer), the same
 * AutoDeployScanner hot-deploy path used for the plugin jar.
 * Unlike a plugin bundle, a license is picked up by Felix fileinstall's directory watcher rather
 * than the OSGi bundle lifecycle, e.g.:
 *   AutoDeployScanner: Processing license.xml
 *   fileinstall-directory-watcher: Digital Enterprise Development license validation passed
 *   fileinstall-directory-watcher: License registered for Digital Enterprise Development
 * Only log lines from after the matching "Processing license.xml" line are inspected, so
 * unrelated ERRORs from other bundles earlier in the (already-running) container don't trip this
 * up. Throws if validation fails or registration isn't confirmed within the timeout.
 */
async function installLicense(): Promise<void> {
  console.log(`[liferay] Deploying DXP license ${LICENSE_FILE}...`);
  shipToContainer(path.join(stack.ENV_DIR, 'artifacts', LICENSE_FILE), DEPLOY_DIR);

  console.log('[liferay] Waiting for the license to register...');
  const marker = `Processing ${LICENSE_FILE}`;
  const deadline = Date.now() + 120_000;
  for (;;) {
    const logs = containerLogs();
    const processingIndex = logs.lastIndexOf(marker);
    if (processingIndex !== -1) {
      const sinceProcessing = logs.slice(processingIndex);
      if (sinceProcessing.includes('License registered for')) {
        console.log('[liferay] DXP license registered');
        return;
      }
      if (/license validation failed/i.test(sinceProcessing)) {
        throw new Error(`[liferay] DXP license failed to validate:\n${sinceProcessing.trim()}`);
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`[liferay] DXP license did not register within 120s\n${describeDeployState()}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/**
 * Points the plugin at the Document Server (and enables Force Save — see forceSave below) by
 * shipping a Configuration Admin file into the container's /opt/liferay/osgi/configs (see
 * shipToContainer). Liferay ships Felix fileinstall watching that directory (polling every few
 * seconds by default) and applies the config live, triggering
 * OnlyOfficeConfigManager's `modified="readConfig"` — no restart and no admin login needed,
 * unlike Jira/Confluence's REST-based plugin configuration.
 */
async function configureDocumentServer(ds: DocumentServer): Promise<void> {
  console.log('[liferay] Configuring the plugin to use the Document Server...');

  // Felix's typed-properties ".config" syntax — see
  // https://felix.apache.org/documentation/subprojects/apache-felix-file-install.html
  const escape = (value: string) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const config = [
    `docServUrl="${escape(ds.url)}"`,
    `secret="${escape(ds.secret)}"`,
    // Force Save is off by default — without it, pressing Save in an open editing session has
    // nothing to persist until the session (tab) closes, which is what the force-save scenario
    // specifically needs to tell apart from the regular close-triggered save. Written untyped
    // (like docServUrl/secret above) — the plugin binds this OCD via bnd's Configurable, which
    // coerces a plain String "true" into the declared Boolean field just fine, and it sidesteps
    // needing to get Felix's typed-properties boolean type-char exactly right.
    `forceSave="true"`,
    '',
  ].join('\n');
  // Written to a scratch directory first: unlike the plugin jar and the license there is no
  // artifacts file to ship, and the config has to exist as a local file for `docker cp` to stream.
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'oit-liferay-'));
  const configFile = path.join(staging, `${CONFIG_PID}.config`);
  fs.writeFileSync(configFile, config);
  shipToContainer(configFile, OSGI_CONFIGS_DIR);
  fs.rmSync(staging, { recursive: true, force: true });

  // Felix fileinstall's default poll interval for the configs directory is a few seconds — give
  // it a comfortable margin to pick up the file and for OnlyOfficeConfigManager to reload before
  // tests start opening the editor.
  await new Promise((resolve) => setTimeout(resolve, 10_000));
}

function extractField(html: string, name: string): string | undefined {
  return html.match(new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`))?.[1];
}

/**
 * A cookie-based session, merging Set-Cookie by name (see the Atlassian setup-script gotchas
 * memory — replacing the jar wholesale on a response that only rotates one cookie silently drops
 * the others, e.g. JSESSIONID).
 *
 * request() always follows redirects manually (redirect: 'manual') rather than letting fetch
 * auto-follow them: fetch has no real cookie jar, so on an auto-followed redirect it re-sends
 * whatever Cookie header the *original* request had — any Set-Cookie from the redirect response
 * itself (e.g. the login action's own session-fixation-protection cookie rotation) never gets
 * merged in before the next hop goes out. follow() does that merge itself between hops, which is
 * exactly what login-then-redirect flows like this one depend on to land on the right page.
 */
function createSession() {
  const cookies = new Map<string, string>();
  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const cookieHeader = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await fetch(`${process.env.LIFERAY_URL}${path}`, {
      ...init,
      redirect: 'manual',
      headers: { ...(init.headers as Record<string, string> | undefined), Cookie: cookieHeader },
    });
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair] = setCookie.split(';');
      const eq = pair.indexOf('=');
      cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    return response;
  }
  async function follow(path: string, init: RequestInit = {}): Promise<Response> {
    let response = await request(path, init);
    while (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return response;
      }
      response = await request(location.replace(process.env.LIFERAY_URL!, ''));
    }
    return response;
  }
  return { request, follow };
}

/**
 * The bundled demo admin account may be created with passwordReset=true (this appears independent
 * of the LIFERAY_PASSWORDS_PERIOD_DEFAULT_PERIOD_POLICY_PERIOD_* overrides in docker-compose.yml,
 * which reliably affect only users created afterwards), forcing its very first login — by any
 * means, including Basic Auth on the REST APIs below — to a "New Password" form instead of letting
 * it through. This drives that one-time form via plain POSTs (same technique as Jira/Confluence's
 * own setup-wizard automation) when it's actually presented, bumping `adminPassword` to
 * ADMIN_TARGET_PASSWORD; otherwise `adminPassword` is left at ADMIN_BOOTSTRAP_PASSWORD, which is
 * still the account's real password.
 */
async function completeInitialAdminPasswordReset(): Promise<void> {
  const session = createSession();

  const loginPage = await (await session.follow('/c/portal/login')).text();
  // Attribute order on the <form> tag isn't guaranteed (action comes before id here), so the
  // login form is located by id first, then its action is pulled out of just that tag.
  const loginFormTag = loginPage.match(/<form[^>]*_com_liferay_login_web_portlet_LoginPortlet_loginForm[^>]*>/)?.[0];
  const loginAction = loginFormTag?.match(/action="([^"]*)"/)?.[1]?.replace(/&amp;/g, '&');
  if (!loginAction) {
    throw new Error('[liferay] Could not find the login form action on the login page');
  }

  const loginResponse = await session.follow(loginAction.replace(process.env.LIFERAY_URL!, ''), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      _com_liferay_login_web_portlet_LoginPortlet_saveLastPath: 'false',
      _com_liferay_login_web_portlet_LoginPortlet_redirect: '',
      _com_liferay_login_web_portlet_LoginPortlet_doActionAfterLogin: 'false',
      _com_liferay_login_web_portlet_LoginPortlet_login: ADMIN_USER,
      _com_liferay_login_web_portlet_LoginPortlet_password: ADMIN_BOOTSTRAP_PASSWORD,
    }),
  });
  const afterLogin = await loginResponse.text();

  if (!afterLogin.includes('/c/portal/update_password')) {
    console.log('[liferay] Admin account did not require a password reset — already completed');
    return;
  }

  console.log('[liferay] Completing the one-time admin password reset...');

  // The login response isn't the New Password form itself — it's a ticket page that
  // auto-submits via onload="document.fm.submit()" to /c/portal/update_password with just
  // p_l_id/ticketId/ticketKey. Only the *response* to that POST carries the actual form fields
  // (formDate, p_auth, etc.) used below. There's no JS runtime here to fire the onload handler,
  // so that hop is replayed manually.
  const ticketField = (name: string) => {
    const value = extractField(afterLogin, name);
    if (value === undefined) {
      throw new Error(`[liferay] Could not find "${name}" on the password-reset ticket page`);
    }
    return value;
  };
  const resetPageResponse = await session.follow('/c/portal/update_password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      p_l_id: ticketField('p_l_id'),
      ticketId: ticketField('ticketId'),
      ticketKey: ticketField('ticketKey'),
    }),
  });
  const resetPage = await resetPageResponse.text();

  const field = (name: string) => {
    const value = extractField(resetPage, name);
    if (value === undefined) {
      throw new Error(`[liferay] Could not find "${name}" on the New Password page`);
    }
    return value;
  };
  const updateResponse = await session.follow('/c/portal/update_password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      formDate: field('formDate'),
      p_l_id: field('p_l_id'),
      p_auth: field('p_auth'),
      doAsUserId: field('doAsUserId'),
      cmd: 'update',
      referer: field('referer'),
      ticketId: field('ticketId'),
      ticketKey: field('ticketKey'),
      password1: ADMIN_TARGET_PASSWORD,
      password2: ADMIN_TARGET_PASSWORD,
    }),
  });
  if (!updateResponse.ok) {
    throw new Error(`[liferay] Admin password reset failed: HTTP ${updateResponse.status} ${await updateResponse.text()}`);
  }
  adminPassword = ADMIN_TARGET_PASSWORD;
}

/**
 * Creates an unprivileged test account via the Headless Admin User REST API (bundled OOTB since
 * 7.3+, no extra module to install). Unlike Alfresco/Jira, this API takes `password` directly on
 * the create body, so the account is immediately usable — no separate "set password" step.
 * Screen names (`alternateName`) can't contain '@' or '.', so it's derived from the email's
 * local part rather than reusing the login itself.
 */
async function ensureUser(email: string, password: string, givenName: string, familyName: string): Promise<void> {
  const authHeader = { Authorization: `Basic ${Buffer.from(`${ADMIN_USER}:${adminPassword}`).toString('base64')}` };
  const existing = await fetch(
    `${process.env.LIFERAY_URL}/o/headless-admin-user/v1.0/user-accounts/by-email-address/${encodeURIComponent(email)}`,
    { headers: authHeader },
  );
  if (existing.ok) {
    return;
  }

  console.log(`[liferay] Creating test account (${email})...`);
  const alternateName = email.split('@')[0].replace(/[^a-zA-Z0-9]/g, '');
  const response = await fetch(`${process.env.LIFERAY_URL}/o/headless-admin-user/v1.0/user-accounts`, {
    method: 'POST',
    headers: { ...authHeader, 'Content-Type': 'application/json' },
    body: JSON.stringify({ emailAddress: email, password, alternateName, givenName, familyName }),
  });
  if (!response.ok) {
    throw new Error(`[liferay] Failed to create test account ${email}: HTTP ${response.status} ${await response.text()}`);
  }
}

/**
 * Grants the built-in "User" role (every authenticated account's role) permission to actually
 * invoke EditorPortlet. Deploying the plugin registers the portlet's resource but grants nobody
 * but omniadmins (who bypass permission checks entirely) any permission on it — without this,
 * only the admin account set up by fixtures.ts can reach the editor at all; every other account
 * (secondUser, readOnlyUser) hits Liferay's own "you do not have the roles required to access
 * this portlet" page before the plugin's own per-file permission logic ever runs. Company-scoped
 * (primKey=companyId, scope=1/SCOPE_COMPANY) and idempotent — re-adding an existing grant is a
 * no-op — so this is safe to run on every setup(), not just the first.
 */
async function grantEditorPortletAccess(): Promise<void> {
  console.log('[liferay] Granting the "User" role access to the ONLYOFFICE editor portlet...');
  const authHeader = { Authorization: `Basic ${Buffer.from(`${ADMIN_USER}:${adminPassword}`).toString('base64')}` };
  const jsonws = async (path: string): Promise<any> => {
    const response = await fetch(`${process.env.LIFERAY_URL}${path}`, { headers: authHeader });
    if (!response.ok) {
      throw new Error(`[liferay] JSONWS ${path} failed: HTTP ${response.status} ${await response.text()}`);
    }
    return response.json();
  };

  const { companyId } = await jsonws('/api/jsonws/user/get-current-user');
  const { roleId: userRoleId } = await jsonws(
    `/api/jsonws/role/get-role?companyId=${companyId}&name=${encodeURIComponent('User')}`,
  );

  for (const actionId of ['VIEW', 'ACCESS_IN_CONTROL_PANEL']) {
    const params = new URLSearchParams({
      groupId: '0',
      companyId,
      name: EDITOR_PORTLET_ID,
      scope: '1', // ResourceConstants.SCOPE_COMPANY
      primKey: companyId,
      roleId: userRoleId,
      actionId,
    });
    const response = await fetch(`${process.env.LIFERAY_URL}/api/jsonws/resourcepermission/add-resource-permission`, {
      method: 'POST',
      headers: authHeader,
      body: params,
    });
    if (!response.ok) {
      throw new Error(
        `[liferay] Granting ${actionId} on ${EDITOR_PORTLET_ID} to the User role failed: HTTP ${response.status} ${await response.text()}`,
      );
    }
  }
}

/**
 * Materializes the DXP license from LIFERAY_LICENSE into environments/liferay/artifacts (which is
 * gitignored), so everything downstream — requireLicenseIfDxp, installLicense — only ever deals
 * with the file and doesn't care where it came from. The variable is the only workable channel in
 * CI: the license can't be checked into the repository and is kept as a secret instead (see
 * .github/workflows/e2e.yml). It holds the license XML itself, either verbatim or base64-encoded —
 * base64 is what survives being carried around as a single-line secret, so anything that doesn't
 * start with '<' is decoded as base64. An existing artifacts/license.xml is deliberately
 * overwritten: an explicitly passed license wins over whatever a previous run left behind.
 */
function materializeLicenseFromEnv(): void {
  const license = process.env.LIFERAY_LICENSE;
  if (!license?.trim()) {
    return;
  }
  const xml = license.trimStart().startsWith('<')
    ? license
    : Buffer.from(license.replace(/\s/g, ''), 'base64').toString('utf8');
  if (!xml.trimStart().startsWith('<')) {
    throw new Error('[liferay] LIFERAY_LICENSE is neither license XML nor base64-encoded license XML');
  }
  const artifactsDir = path.join(stack.ENV_DIR, 'artifacts');
  fs.mkdirSync(artifactsDir, { recursive: true });
  fs.writeFileSync(path.join(artifactsDir, LICENSE_FILE), xml);
  console.log(`[liferay] License taken from LIFERAY_LICENSE and written to artifacts/${LICENSE_FILE}`);
}

/**
 * DXP (`liferay/dxp:...`) is Liferay's paid distribution and refuses to run unlicensed, unlike
 * the free `liferay/portal` image — checked up front so a missing license file surfaces as a
 * clear setup error instead of a confusing runtime failure once the stack is already up.
 */
function requireLicenseIfDxp(): void {
  if (!isDxpImage(process.env.LIFERAY_IMAGE!)) {
    return;
  }
  materializeLicenseFromEnv();
  const licensePath = path.join(stack.ENV_DIR, 'artifacts', LICENSE_FILE);
  if (!fs.existsSync(licensePath)) {
    throw new Error(
      `[liferay] LIFERAY_IMAGE (${process.env.LIFERAY_IMAGE}) is a DXP (paid) image — ` +
        `place a valid license file at environments/liferay/artifacts/${LICENSE_FILE} ` +
        'or pass its contents (verbatim or base64) via LIFERAY_LICENSE',
    );
  }
}

/**
 * Ships one file into a watched directory of the running Liferay container (DEPLOY_DIR for the
 * plugin jar and the license, OSGI_CONFIGS_DIR for the plugin configuration).
 *
 * `docker cp` rather than a compose bind mount on purpose: the daemon resolves mount sources on
 * the docker host, so when the tests themselves run in a container (CI) the paths under
 * environments/liferay/ exist only inside that container and the daemon silently mounts an empty
 * directory in its place. The file then lands next to the test process, Liferay's watchers never
 * see it, and it surfaces as "Plugin ... did not start within 120s" — or, for the configuration,
 * not at all: the plugin simply never learns the Document Server's address. `docker cp` streams
 * the file through the API from wherever the client sees it, so both layouts work. Same fix as
 * shipAmp in tests/setup/alfresco.ts.
 */
function shipToContainer(source: string, targetDir: string): void {
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error(`[liferay] No file to ship into ${targetDir}: ${source} is missing`);
  }
  const target = `${targetDir}/${path.basename(source)}`;
  stack.sh(`docker exec -u root ${LIFERAY_CONTAINER} mkdir -p ${targetDir}`);
  stack.sh(`docker cp "${source}" ${LIFERAY_CONTAINER}:${target}`);
  // `docker cp` writes the file as root and keeps the source's mode, so an artifact that arrived
  // from CI with a restrictive mode lands unreadable for the user Liferay actually runs as — its
  // AutoDeployScanner then logs "Unable to read" and never processes the file. Hand it over to
  // that user (uid/gid read from the container instead of hardcoding "liferay", which only exists
  // under that name in some of the images) and make it readable.
  const uid = stack.sh(`docker exec ${LIFERAY_CONTAINER} id -u`);
  const gid = stack.sh(`docker exec ${LIFERAY_CONTAINER} id -g`);
  stack.sh(`docker exec -u root ${LIFERAY_CONTAINER} chown ${uid}:${gid} ${target}`);
  stack.sh(`docker exec -u root ${LIFERAY_CONTAINER} chmod 644 ${target}`);
}

/** Liferay's log, both streams — see the note on stderr in installPlugin's wait loop */
function containerLogs(): string {
  return stack.sh(`docker logs ${LIFERAY_CONTAINER} 2>&1`, { ignoreErrors: true });
}

/**
 * What to attach to a "never picked it up" timeout: whether the file is actually sitting in the
 * watched directory (and with which owner/mode), plus the tail of Liferay's log — without this
 * the timeout says nothing about which half of the hand-off broke.
 */
function describeDeployState(): string {
  const listing = stack.sh(`docker exec ${LIFERAY_CONTAINER} ls -l ${DEPLOY_DIR} ${OSGI_CONFIGS_DIR}`, {
    ignoreErrors: true,
  });
  const tail = containerLogs().split('\n').slice(-40).join('\n');
  return [
    `--- ${DEPLOY_DIR} and ${OSGI_CONFIGS_DIR}:`,
    listing || '(unavailable)',
    '--- last log lines:',
    tail || '(unavailable)',
  ].join('\n');
}

export async function setup(ds: DocumentServer): Promise<void> {
  reusingExisting = Boolean(process.env.LIFERAY_URL);
  if (reusingExisting) {
    console.log(`[liferay] Using existing Liferay at ${process.env.LIFERAY_URL} (LIFERAY_URL is set) — skipping stack setup`);
    return;
  }

  if (!process.env.LIFERAY_IMAGE) {
    throw new Error(
      '[liferay] LIFERAY_IMAGE must be set in .env to a Docker image tag (e.g. "liferay/portal:7.4.3.132-ga132")',
    );
  }
  requireLicenseIfDxp();

  console.log(`[liferay] Starting Liferay ${process.env.LIFERAY_IMAGE} (project ${stack.COMPOSE_PROJECT})...`);
  stack.sh(`docker compose -p ${stack.COMPOSE_PROJECT} -f ${stack.COMPOSE_FILE} up -d --quiet-pull`, {
    env: {
      LIFERAY_IMAGE: process.env.LIFERAY_IMAGE,
      LIFERAY_HOST: ds.host,
    },
  });
  process.env.LIFERAY_URL = `http://${ds.host}:8080`;

  console.log('[liferay] Waiting for the Liferay web interface (first start can take a few minutes)...');
  await waitForHttp('Liferay', `${process.env.LIFERAY_URL}/c/portal/login`, (r) => r.ok, 900_000);

  if (isDxpImage(process.env.LIFERAY_IMAGE)) {
    await installLicense();
  }

  await completeInitialAdminPasswordReset();
  await installPlugin();
  await configureDocumentServer(ds);
  await grantEditorPortletAccess();
  await ensureUser(SECOND_USER, SECOND_PASSWORD, 'Autotest', 'Second');
  await ensureUser(READONLY_USER, READONLY_PASSWORD, 'Autotest', 'ReadOnly');

  // Workers inherit process.env — publish the password admin actually ended up with (bootstrap or
  // reset target, see completeInitialAdminPasswordReset) so fixtures.ts's defaultUser is correct
  // regardless of which one it turned out to be.
  process.env.LIFERAY_PASSWORD = adminPassword;

  console.log('[liferay] Stack ready');
}

/** Stops and fully removes the Liferay stack along with its volumes */
export function teardown(): void {
  if (reusingExisting) {
    return;
  }
  console.log('[liferay] Removing stack...');
  stack.sh(`docker compose -p ${stack.COMPOSE_PROJECT} -f ${stack.COMPOSE_FILE} down --volumes --remove-orphans`, {
    ignoreErrors: true,
  });
}
