import * as fs from 'node:fs';
import * as path from 'node:path';
import { getJiraLicenseKey } from './jira-license';
import { stackFor, waitForHttp } from '../stack';
import type { DocumentServer } from './document-server';

const stack = stackFor('jira');
let JIRA_URL = 'http://127.0.0.1:8080';
const ADMIN_USER = 'admin';
const ADMIN_PASSWORD = 'admin';
const SECOND_USER = 'autotest2';
const SECOND_PASSWORD = 'automation123';
const READONLY_USER = 'autotest3';
const READONLY_PASSWORD = 'automation123';
// atlassian-plugin.xml's "key" attribute — stable across plugin releases (see environments/jira/artifacts)
const PLUGIN_KEY = 'onlyoffice.onlyoffice-jira-app';
// Must match TEST_PROJECT_KEY/NAME in packages/adapter-jira/src/jira.adapter.ts — the project
// the adapter creates issues in
const TEST_PROJECT_KEY = 'OIT';
const TEST_PROJECT_NAME = 'Integration Tests';
// Matches the postgres service in docker-compose.yml (ATL_JDBC_* there pre-configures the same
// connection, but the wizard's database screen still appears and must be submitted regardless)
const DB = { host: 'postgres', port: '5432', database: 'jira', username: 'jira', password: 'jira' };

// setup() publishes the fresh stack's address via process.env.JIRA_URL for the fixtures to
// pick up, so teardown() can't tell "reused" from "just started" by re-checking that var — it
// has to be captured up front, before setup() overwrites it.
let reusingExisting = false;

/**
 * A cookie-based admin session, established once the setup wizard creates the admin account.
 * Basic Auth turns out to be disabled on this Jira version too (same "Basic Authentication has
 * been disabled on this instance" as Confluence, despite legacy.mode in CATALINA_OPTS), so REST
 * calls need a real logged-in — and, for some endpoints, WebSudo-elevated — session.
 */
interface AdminSession {
  request(path: string, init?: RequestInit): Promise<Response>;
}

function createAdminSession(): AdminSession {
  // Merge Set-Cookie by name rather than replacing the whole jar wholesale — see the cookie-jar
  // note in completeSetupWizard below.
  const cookies = new Map<string, string>();
  return {
    async request(path, init = {}) {
      const cookieHeader = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
      const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined), Cookie: cookieHeader };
      if ((init.method ?? 'GET') !== 'GET') {
        headers['X-Atlassian-Token'] = 'no-check';
      }
      const response = await fetch(`${JIRA_URL}${path}`, { ...init, headers });
      for (const setCookie of response.headers.getSetCookie()) {
        const [pair] = setCookie.split(';');
        const eq = pair.indexOf('=');
        cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
      }
      return response;
    },
  };
}

/** Logs in as the admin user created by the setup wizard, establishing a session cookie */
async function login(session: AdminSession): Promise<void> {
  const response = await session.request('/rest/auth/1/session', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD }),
  });
  if (!response.ok) {
    throw new Error(`[jira] Login failed: HTTP ${response.status} ${await response.text()}`);
  }
}

/**
 * Steps up an already-logged-in session to a "secure administrator session" (websudo) — the
 * confirmation form (id="login-form") posts to WebSudoAuthenticate.jspa with webSudoPassword,
 * webSudoDestination, webSudoIsPost and atl_token (verified against a live dump of the page —
 * the submit button itself has no name, so nothing else needs to be sent).
 *
 * A successful confirmation responds with a 302 that rotates JSESSIONID (session-fixation
 * protection on privilege elevation) — redirect: 'manual' stops fetch from auto-following that
 * redirect, because following it lets the elevated Set-Cookie fall out of view (only the final
 * hop's headers are visible) and every REST call after this one gets bounced back to an
 * anonymous login page.
 */
async function elevateToWebsudo(session: AdminSession): Promise<void> {
  const destination = '/secure/admin/ViewApplicationProperties.jspa';
  const page = await session.request(
    `/secure/admin/WebSudoAuthenticate!default.jspa?webSudoDestination=${encodeURIComponent(destination)}&webSudoIsPost=false`,
  );
  const html = await page.text();
  const atlToken = html.match(/<input[^>]*name="atl_token"[^>]*value="([^"]+)"/)?.[1];
  if (!atlToken) {
    throw new Error('[jira] Could not find atl_token on the websudo confirmation page');
  }

  const response = await session.request('/secure/admin/WebSudoAuthenticate.jspa', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      atl_token: atlToken,
      webSudoPassword: ADMIN_PASSWORD,
      webSudoDestination: destination,
      webSudoIsPost: 'false',
    }),
    redirect: 'manual',
  });
  if (response.status !== 302 && response.status !== 303) {
    throw new Error(`[jira] Websudo confirmation failed: HTTP ${response.status} ${await response.text()}`);
  }
}

/**
 * Creates the project used for test issues and sets up its permission scheme so that only
 * members of a dedicated "Editors" project role can edit issues / create or delete attachments —
 * everyone else (including readOnlyUser) keeps BROWSE_PROJECTS (view) but not CREATE_ATTACHMENTS.
 * The ONLYOFFICE editor's own permission check (AttachmentUtil.checkAccess with forEdit=true)
 * requires exactly BROWSE_PROJECTS + CREATE_ATTACHMENTS, so this is what makes the editor open
 * read-only for excluded users — see JiraAdapter.restrictToReadOnly, which relies entirely on
 * this project-level setup and does nothing per-file.
 */
async function ensureTestProject(session: AdminSession): Promise<void> {
  if ((await session.request(`/rest/api/2/project/${TEST_PROJECT_KEY}`)).ok) {
    return;
  }

  console.log(`[jira] Creating test project (${TEST_PROJECT_KEY})...`);
  await session.request('/rest/api/2/project', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      key: TEST_PROJECT_KEY,
      name: TEST_PROJECT_NAME,
      projectTypeKey: 'software',
      projectTemplateKey: 'com.pyxis.greenhopper.jira:basic-software-development-template',
      lead: ADMIN_USER,
      assigneeType: 'PROJECT_LEAD',
    }),
  });

  const roleResponse = await session.request('/rest/api/2/role', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `${TEST_PROJECT_KEY} Editors`,
      description: `Users allowed to edit/attach files in ${TEST_PROJECT_KEY} issues`,
    }),
  });
  const { id: roleId } = (await roleResponse.json()) as { id: number };

  await session.request(`/rest/api/2/project/${TEST_PROJECT_KEY}/role/${roleId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ user: [ADMIN_USER, SECOND_USER] }),
  });

  const schemeResponse = await session.request(`/rest/api/2/project/${TEST_PROJECT_KEY}/permissionscheme`);
  const { id: schemeId } = (await schemeResponse.json()) as { id: number };
  const scheme = (await (await session.request(`/rest/api/2/permissionscheme/${schemeId}?expand=permissions`)).json()) as {
    permissions: { id: number; permission: string; holder: { type: string } }[];
  };

  for (const permission of ['EDIT_ISSUES', 'CREATE_ATTACHMENTS', 'DELETE_OWN_ATTACHMENTS']) {
    const grant = scheme.permissions.find((p) => p.permission === permission && p.holder.type === 'applicationRole');
    if (grant) {
      await session.request(`/rest/api/2/permissionscheme/${schemeId}/permission/${grant.id}`, { method: 'DELETE' });
    }
    await session.request(`/rest/api/2/permissionscheme/${schemeId}/permission`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ holder: { type: 'projectRole', parameter: String(roleId) }, permission }),
    });
  }
}

function extractField(html: string, name: string): string {
  const match = html.match(new RegExp(`<input[^>]*name="${name}"[^>]*value="([^"]*)"`));
  if (!match) {
    throw new Error(`[jira] Could not find "${name}" on the setup wizard page`);
  }
  return match[1];
}

/**
 * Completes the setup wizard screen by screen via plain POST requests — same technique as
 * Confluence's completeSetupWizard, but a different screen set (database, application
 * properties, license, admin account, mail notifications) and, notably, the database screen
 * still appears — and must be submitted with matching values — even though ATL_JDBC_* env vars
 * (see docker-compose.yml) have already pre-configured dbconfig.xml.
 */
async function completeSetupWizard(): Promise<void> {
  console.log('[jira] Completing the setup wizard...');
  // Merge Set-Cookie by name rather than replacing the whole jar wholesale — the server doesn't
  // resend JSESSIONID on every response, only when it changes, so a wholesale replace on a
  // response that only sets e.g. the XSRF-token cookie silently drops the session (see the
  // Atlassian setup-script gotchas memory).
  const cookies = new Map<string, string>();

  async function request(path: string, body?: URLSearchParams): Promise<string> {
    const cookieHeader = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await fetch(`${JIRA_URL}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body
        ? { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookieHeader }
        : { Cookie: cookieHeader },
      body: body?.toString(),
      // deployment type and admin account creation genuinely take tens of seconds on the server
      signal: AbortSignal.timeout(300_000),
    });
    for (const setCookie of response.headers.getSetCookie()) {
      const [pair] = setCookie.split(';');
      const eq = pair.indexOf('=');
      cookies.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    return response.text();
  }

  // Right after /status starts reporting 200, Jira can still serve a transitional
  // "Atlassian Jira — Initialising" placeholder for the servlet layer for a bit longer —
  // retry until a real wizard screen (or the finished app) comes back.
  let html = '';
  const deadline = Date.now() + 120_000;
  do {
    html = await request('/');
    if (html.includes('Atlassian Jira — Initialising')) {
      if (Date.now() > deadline) {
        throw new Error('[jira] Jira kept reporting "Initialising" for over 120s');
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  } while (html.includes('Atlassian Jira — Initialising'));

  for (let step = 0; step < 10; step++) {
    if (html.includes('name="jdbcHostname"')) {
      html = await request(
        '/secure/SetupDatabase.jspa',
        new URLSearchParams({
          atl_token: extractField(html, 'atl_token'),
          databaseOption: 'external',
          databaseType: 'postgres72',
          jdbcHostname: DB.host,
          jdbcPort: DB.port,
          jdbcDatabase: DB.database,
          jdbcUsername: DB.username,
          jdbcPassword: DB.password,
          schemaName: '',
        }),
      );
    } else if (html.includes('name="baseURL"')) {
      // baseURL already defaults to ATL_PROXY_NAME:ATL_PROXY_PORT (see docker-compose.yml) —
      // resubmitted as-is rather than hardcoded here
      html = await request(
        '/secure/SetupApplicationProperties.jspa',
        new URLSearchParams({
          atl_token: extractField(html, 'atl_token'),
          title: 'Jira',
          mode: 'private',
          baseURL: extractField(html, 'baseURL'),
          nextStep: 'true',
        }),
      );
    } else if (html.includes('name="setupLicenseKey"')) {
      html = await request(
        '/secure/SetupLicense.jspa',
        new URLSearchParams({
          atl_token: extractField(html, 'atl_token'),
          setupLicenseKey: await getJiraLicenseKey(),
          next: 'Next',
        }),
      );
    } else if (html.includes('name="confirm"') && html.includes('name="fullname"')) {
      html = await request(
        '/secure/SetupAdminAccount.jspa',
        new URLSearchParams({
          atl_token: extractField(html, 'atl_token'),
          username: ADMIN_USER,
          password: ADMIN_PASSWORD,
          confirm: ADMIN_PASSWORD,
          fullname: 'Jira Admin',
          email: 'admin@example.com',
          next: 'Next',
        }),
      );
    } else if (html.includes('name="mailservertype"')) {
      await request(
        '/secure/SetupMailNotifications.jspa',
        new URLSearchParams({ atl_token: extractField(html, 'atl_token'), noemail: 'true', finish: 'Finish' }),
      );
      return;
    } else {
      const title = html.match(/<title>[^<]*<\/title>/)?.[0] ?? '(no title)';
      throw new Error(`[jira] Unknown setup wizard screen: ${title}\n${html.slice(0, 1000)}`);
    }
  }
  throw new Error('[jira] Setup wizard did not finish within the expected number of steps');
}

/**
 * Creates an unprivileged test account via the REST API — unlike Confluence, this Jira version
 * has a proper /rest/api/2/user endpoint, and new users are added to jira-software-users (and
 * granted the Jira Software application role) by default, so no extra access step is needed.
 */
async function ensureUser(session: AdminSession, username: string, password: string, fullName: string): Promise<void> {
  const existing = await session.request(`/rest/api/2/user?username=${username}`);
  if (existing.ok) {
    return;
  }

  console.log(`[jira] Creating test account (${username})...`);
  const response = await session.request('/rest/api/2/user', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: username, password, emailAddress: `${username}@example.com`, displayName: fullName }),
  });

  if (!response.ok) {
    throw new Error(`[jira] Failed to create test account ${username}: HTTP ${response.status} ${await response.text()}`);
  }
}

/**
 * Installs the plugin jar from environments/jira/artifacts via the UPM REST API
 * (CATALINA_OPTS in docker-compose.yml enables unsigned uploads) and waits for it to become
 * enabled. Unlike Confluence, no websudo elevation is required for either the token fetch or
 * the upload — the plain admin session from the setup wizard is enough.
 */
async function installPlugin(session: AdminSession): Promise<void> {
  const artifactsDir = path.join(stack.ENV_DIR, 'artifacts');
  const jarName = fs.readdirSync(artifactsDir).find((name) => name.endsWith('.jar'));
  if (!jarName) {
    throw new Error(`[jira] No plugin .jar found in ${artifactsDir} — see artifacts/README.md`);
  }

  console.log(`[jira] Installing plugin ${jarName} via the UPM REST API...`);
  const tokenResponse = await session.request('/rest/plugins/1.0/');
  const token = tokenResponse.headers.get('upm-token');
  if (!token) {
    throw new Error('[jira] Could not obtain an upm-token from the UPM REST API');
  }

  const form = new FormData();
  form.append('plugin', new Blob([fs.readFileSync(path.join(artifactsDir, jarName))]), jarName);
  const uploadResponse = await session.request(`/rest/plugins/1.0/?token=${token}`, {
    method: 'POST',
    body: form,
  });
  if (!uploadResponse.ok) {
    throw new Error(`[jira] Plugin upload failed: HTTP ${uploadResponse.status} ${await uploadResponse.text()}`);
  }

  console.log('[jira] Waiting for the plugin to become enabled...');
  const deadline = Date.now() + 120_000;
  for (;;) {
    const pluginResponse = await session.request(`/rest/plugins/1.0/${PLUGIN_KEY}-key`);
    if (pluginResponse.ok && (await pluginResponse.json()).enabled) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`[jira] Plugin ${PLUGIN_KEY} did not become enabled within 120s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/**
 * Writes the Document Server URL and JWT secret into the onlyoffice-jira-app plugin settings
 * (POST body matches com.onlyoffice.model.settings.Settings from the bundled docs-integration-sdk
 * — the same shape as Confluence's plugin) and checks the connection via the same request's
 * validation results.
 */
async function configureDocumentServer(session: AdminSession, ds: DocumentServer): Promise<void> {
  console.log('[jira] Configuring the plugin to use the Document Server...');

  // The plugin-key resource can report "enabled" a moment before its servlets are actually
  // routable, so a 404 right after install means "not registered yet", not "wrong URL" — retry.
  const deadline = Date.now() + 60_000;
  let response: Response;
  for (;;) {
    response = await session.request('/plugins/servlet/onlyoffice/configure', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: ds.url,
        security: { key: ds.secret },
        demo: false,
      }),
    });
    if (response.status !== 404 || Date.now() > deadline) {
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  if (!response.ok) {
    throw new Error(`[jira] Failed to configure the plugin: HTTP ${response.status} ${await response.text()}`);
  }

  const { validationResults } = (await response.json()) as {
    validationResults: Record<string, { status: string; message?: string }>;
  };
  const failed = Object.entries(validationResults).filter(([, r]) => r.status !== 'success');
  if (failed.length > 0) {
    const details = failed.map(([name, r]) => `${name}: ${r.message ?? r.status}`).join('; ');
    throw new Error(`[jira] ONLYOFFICE plugin failed to connect to Document Server — ${details}`);
  }
}

/**
 * Spins up the Jira stack from environments/jira (Jira + Postgres), completes the setup wizard
 * (DB — via ATL_JDBC_* plus one confirming POST, license/admin/mail — via POST requests),
 * installs the ONLYOFFICE plugin and points it at the Document Server. The resulting address is
 * passed to the tests via process.env.JIRA_URL.
 */
export async function setup(ds: DocumentServer): Promise<void> {
  reusingExisting = Boolean(process.env.JIRA_URL);
  if (reusingExisting) {
    console.log(`[jira] Using existing Jira at ${process.env.JIRA_URL} (JIRA_URL is set) — skipping stack setup`);
    return;
  }

  JIRA_URL = `http://${ds.host}:8080`;

  console.log(`[jira] Starting Jira ${process.env.JIRA_VERSION ?? '11.3.4'} (project ${stack.COMPOSE_PROJECT})...`);
  stack.sh(`docker compose -p ${stack.COMPOSE_PROJECT} -f ${stack.COMPOSE_FILE} up -d --quiet-pull`, {
    env: {
      JIRA_VERSION: process.env.JIRA_VERSION ?? '11.3.4',
      // See docker-compose.yml's ATL_PROXY_NAME — makes Jira auto-detect this as its base URL
      JIRA_PROXY_NAME: ds.host,
    },
  });

  console.log('[jira] Waiting for the Jira web interface (first start can take a few minutes)...');
   await waitForHttp(
    'Jira (after setup wizard)',
    `${JIRA_URL}/status`,
    async (r) => r.ok && (await r.json()).state === 'FIRST_RUN',
    900_000,
  );

  await completeSetupWizard();

  await waitForHttp(
    'Jira (after setup wizard)',
    `${JIRA_URL}/status`,
    async (r) => r.ok && (await r.json()).state === 'RUNNING',
    300_000,
  );

  const session = createAdminSession();
  await login(session);
  await elevateToWebsudo(session);
  await ensureUser(session, SECOND_USER, SECOND_PASSWORD, 'Autotest Second');
  await ensureUser(session, READONLY_USER, READONLY_PASSWORD, 'Autotest ReadOnly');
  await installPlugin(session);
  await configureDocumentServer(session, ds);
  await ensureTestProject(session);

  // Browser-driven tests must reach Jira via the same host it now considers its own base URL
  // (ATL_PROXY_NAME above) — otherwise the login SPA's XSRF/origin check rejects the request,
  // same reasoning as Confluence's CONFLUENCE_URL below.
  process.env.JIRA_URL = JIRA_URL;
  console.log('[jira] Stack ready');
}

/** Stops and fully removes the Jira stack along with its volumes */
export function teardown(): void {
  if (reusingExisting) {
    return;
  }
  console.log('[jira] Removing stack...');
  stack.sh(`docker compose -p ${stack.COMPOSE_PROJECT} -f ${stack.COMPOSE_FILE} down --volumes --remove-orphans`, {
    ignoreErrors: true,
  });
}
