import * as fs from 'node:fs';
import * as path from 'node:path';
import { getConfluenceLicenseKey } from './confluence-license';
import { stackFor, waitForHttp } from '../stack';
import type { DocumentServer } from './document-server';

const stack = stackFor('confluence');
const CONFLUENCE_URL = 'http://127.0.0.1:8090'; // not localhost — fetch resolves it to ::1 and hangs
const ADMIN_USER = process.env.CONFLUENCE_USER ?? 'admin';
const ADMIN_PASSWORD = process.env.CONFLUENCE_PASSWORD ?? 'admin';
const SECOND_USER = process.env.CONFLUENCE_USER2 ?? 'autotest2';
const SECOND_PASSWORD = process.env.CONFLUENCE_PASSWORD2 ?? 'automation123';
// atlassian-plugin.xml's "key" attribute — stable across plugin releases (see environments/confluence/artifacts)
const PLUGIN_KEY = 'onlyoffice.onlyoffice-confluence-plugin';

/**
 * A cookie-based admin session. Basic Auth is disabled by default on this Confluence version
 * ("Basic Authentication has been disabled on this instance"), so the UPM/plugin-config calls
 * below authenticate the same way the browser UI does: log in for a session cookie, then (for
 * the UPM endpoints only) step up to a "secure administrator session" (websudo).
 */
interface AdminSession {
  request(path: string, init?: RequestInit): Promise<Response>;
}

function createAdminSession(): AdminSession {
  let cookie = '';
  return {
    async request(path, init = {}) {
      const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined), Cookie: cookie };
      if ((init.method ?? 'GET') !== 'GET') {
        // Some REST resources (e.g. /rest/api/space) enforce Confluence's XSRF filter even
        // though others we call (UPM, the plugin's own configure servlet) don't — harmless either way
        headers['X-Atlassian-Token'] = 'no-check';
      }
      const response = await fetch(`${CONFLUENCE_URL}${path}`, { ...init, headers });
      const setCookie = response.headers.getSetCookie();
      if (setCookie.length) {
        cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
      }
      return response;
    },
  };
}

/** Logs in as the admin user created by the setup wizard, establishing a session cookie */
async function login(session: AdminSession): Promise<void> {
  const response = await session.request('/rest/tsv/1.0/authenticate?os_authType=none', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Atlassian-Token': 'no-check' },
    body: JSON.stringify({ username: ADMIN_USER, password: ADMIN_PASSWORD, rememberMe: false, targetUrl: '', captchaId: '' }),
  });
  if (!response.ok) {
    throw new Error(`[confluence] Login failed: HTTP ${response.status} ${await response.text()}`);
  }
}

/**
 * Steps up an already-logged-in session to a "secure administrator session" (websudo) —
 * required by the UPM REST API (plugin install), same as the "Manage apps" admin page.
 */
async function elevateToWebsudo(session: AdminSession): Promise<void> {
  const destination = '/plugins/servlet/upm';
  const page = await session.request(`/authenticate.action?destination=${encodeURIComponent(destination)}`);
  const html = await page.text();
  const match = html.match(/name="atl_token" value="([^"]+)"/);
  if (!match) {
    throw new Error('[confluence] Could not find atl_token on the websudo confirmation page');
  }

  const response = await session.request('/doauthenticate.action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      atl_token: match[1],
      password: ADMIN_PASSWORD,
      authenticate: 'Confirm',
      destination,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`[confluence] Websudo confirmation failed: HTTP ${response.status}`);
  }
}

/**
 * ATL_DB_TYPE/ATL_LICENSE_KEY (see docker-compose.yml) close the DB and license screens —
 * Atlassian doesn't document the rest via env at all, so we complete them with plain
 * POST requests (the same actions and fields the browser sends). Each step needs a fresh
 * atl_token from the previous step's page and a shared session cookie.
 */
async function completeSetupWizard(): Promise<void> {
  console.log('[confluence] Completing the remaining setup wizard screens...');
  let cookie = '';

  async function request(path: string, body?: URLSearchParams): Promise<{ url: string; html: string }> {
    const response = await fetch(`${CONFLUENCE_URL}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: body
        ? { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: cookie }
        : { Cookie: cookie },
      body: body?.toString(),
      // deployment type and admin account creation genuinely take tens of seconds on the server
      signal: AbortSignal.timeout(120_000),
    });
    const setCookie = response.headers.getSetCookie();
    if (setCookie.length) {
      cookie = setCookie.map((c) => c.split(';')[0]).join('; ');
    }
    return { url: response.url, html: await response.text() };
  }

  function extractToken(html: string): string {
    const match = html.match(/name="atl_token" value="([^"]+)"/);
    if (!match) {
      throw new Error('[confluence] Could not find atl_token on the setup wizard page');
    }
    return match[1];
  }

  let { url, html } = await request('/');

  for (let step = 0; step < 10 && url.includes('/setup/') && !url.includes('finishsetup'); step++) {
    const atl_token = extractToken(html);
    let path: string;
    let body: URLSearchParams;

    if (html.includes('name="isClusteringEnabled"')) {
      // "Choose your deployment type" — leave Non-clustered selected (the default)
      path = '/setup/setupcluster.action';
      body = new URLSearchParams({
        atl_token,
        clusterName: '',
        clusterHome: '',
        networkInterface: 'eth0',
        joinMethod: 'multicast',
        generateClusterAddress: 'auto',
        generateClusterAddressSubmitted: 'submitted',
        clusterAddressString: '',
        clusterPeersString: '',
        awsAuthMethod: 'iamrole',
        iamRole: '',
        accessKey: '',
        secretKey: '',
        region: '',
        hostHeader: '',
        securityGroupName: '',
        tagKey: '',
        tagValue: '',
        newCluster: 'skipCluster',
      });
    } else if (html.includes('name="dbchoiceSelect"')) {
      // "Load Content"
      path = '/setup/setupdata.action';
      body = new URLSearchParams({ dbchoiceSelect: 'Empty Site', contentChoice: 'blank', atl_token });
    } else if (html.includes('name="internal"')) {
      // "Configure User Management"
      path = '/setup/setupusermanagementchoice.action';
      body = new URLSearchParams({
        userManagementChoice: 'internal',
        atl_token,
        internal: 'Manage users and groups within Confluence',
      });
    } else if (html.includes('id="username"')) {
      // "Configure System Administrator Account"
      path = '/setup/setupadministrator.action';
      body = new URLSearchParams({
        atl_token,
        username: process.env.CONFLUENCE_USER ?? 'admin',
        fullName: 'Confluence Admin',
        email: 'admin@example.com',
        password: process.env.CONFLUENCE_PASSWORD ?? 'admin',
        confirm: process.env.CONFLUENCE_PASSWORD ?? 'admin',
        'setup-next-button': 'Next',
      });
    } else {
      throw new Error(`[confluence] Unknown setup wizard screen: ${url}`);
    }

    ({ url, html } = await request(path, body));
  }

  if (url.includes('/setup/') && !url.includes('finishsetup')) {
    throw new Error(`[confluence] Setup wizard got stuck on ${url}`);
  }
}

/**
 * Creates a second, unprivileged test account via the admin console's classic form (there's no
 * REST endpoint for user creation on this Confluence version — /rest/api/user only supports GET).
 * Requires an already-elevated (websudo) session, same as the UPM calls below. No extra space
 * permissions are needed: new users are added to confluence-users by default, which already has
 * read/update rights on OITEST because the space was created without a restrictive permission
 * scheme.
 */
async function ensureSecondUser(session: AdminSession): Promise<void> {
  // viewuser.action always answers 200 — even for an unknown username, rendering an error
  // banner instead — so existence is checked by title, not by status
  const existing = await session.request(`/admin/users/viewuser.action?username=${SECOND_USER}`);
  if ((await existing.text()).includes(`<title>View User: ${SECOND_USER}`)) {
    return;
  }

  console.log(`[confluence] Creating the second test account (${SECOND_USER})...`);
  const formPage = await session.request('/admin/users/createuser.action');
  const html = await formPage.text();
  const match = html.match(/name="atl_token" value="([^"]+)"/);
  if (!match) {
    throw new Error('[confluence] Could not find atl_token on the create-user page');
  }

  const response = await session.request('/admin/users/docreateuser.action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      atl_token: match[1],
      username: SECOND_USER,
      fullName: 'Autotest Second',
      email: `${SECOND_USER}@example.com`,
      password: SECOND_PASSWORD,
      confirm: SECOND_PASSWORD,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`[confluence] Failed to create the second test account: HTTP ${response.status} ${await response.text()}`);
  }
}

/**
 * Installs the plugin jar from environments/confluence/artifacts via the UPM REST API
 * (CATALINA_OPTS in docker-compose.yml enables unsigned uploads) and waits for it to
 * become enabled: fetch the upm-token, upload the jar as multipart/form-data, then poll
 * the plugin's UPM resource until it reports enabled.
 */
async function installPlugin(session: AdminSession): Promise<void> {
  const artifactsDir = path.join(stack.ENV_DIR, 'artifacts');
  const jarName = fs.readdirSync(artifactsDir).find((name) => name.endsWith('.jar'));
  if (!jarName) {
    throw new Error(`[confluence] No plugin .jar found in ${artifactsDir} — see artifacts/README.md`);
  }

  console.log(`[confluence] Installing plugin ${jarName} via the UPM REST API...`);
  const tokenResponse = await session.request('/rest/plugins/1.0/');
  const token = tokenResponse.headers.get('upm-token');
  if (!token) {
    throw new Error('[confluence] Could not obtain an upm-token from the UPM REST API');
  }

  const form = new FormData();
  form.append('plugin', new Blob([fs.readFileSync(path.join(artifactsDir, jarName))]), jarName);
  const uploadResponse = await session.request(`/rest/plugins/1.0/?token=${token}`, {
    method: 'POST',
    body: form,
  });
  if (!uploadResponse.ok) {
    throw new Error(`[confluence] Plugin upload failed: HTTP ${uploadResponse.status} ${await uploadResponse.text()}`);
  }

  console.log('[confluence] Waiting for the plugin to become enabled...');
  const deadline = Date.now() + 120_000;
  for (;;) {
    const pluginResponse = await session.request(`/rest/plugins/1.0/${PLUGIN_KEY}-key`);
    if (pluginResponse.ok && (await pluginResponse.json()).enabled) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`[confluence] Plugin ${PLUGIN_KEY} did not become enabled within 120s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/**
 * Writes the Document Server URL and JWT secret into the onlyoffice-confluence plugin settings
 * (POST body matches com.onlyoffice.model.settings.Settings from the bundled docs-integration-sdk)
 * and checks the connection via the same request's validation results.
 */
async function configureDocumentServer(session: AdminSession, ds: DocumentServer): Promise<void> {
  console.log('[confluence] Configuring the plugin to use the Document Server...');

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
    throw new Error(`[confluence] Failed to configure the plugin: HTTP ${response.status} ${await response.text()}`);
  }

  const { validationResults } = (await response.json()) as {
    validationResults: Record<string, { status: string; message?: string }>;
  };
  const failed = Object.entries(validationResults).filter(([, r]) => r.status !== 'success');
  if (failed.length > 0) {
    const details = failed.map(([name, r]) => `${name}: ${r.message ?? r.status}`).join('; ');
    throw new Error(`[confluence] ONLYOFFICE plugin failed to connect to Document Server — ${details}`);
  }
}

/**
 * Opens the editor once for a throwaway attachment, sequentially, right after the plugin is
 * configured. Without this, the first real request to /plugins/servlet/onlyoffice/doceditor
 * races when multiple Playwright workers hit it in parallel (each opening its own file right
 * after the stand comes up) and one of them gets Confluence's generic "System Error" page —
 * presumably something the plugin lazily initializes on first use isn't safe for concurrent
 * first-callers. Doing it once, alone, avoids the race for every test that follows.
 */
async function warmUpEditor(session: AdminSession): Promise<void> {
  console.log('[confluence] Warming up the ONLYOFFICE editor endpoint...');

  const spaceCheck = await session.request('/rest/api/space/WARMUP');
  if (!spaceCheck.ok) {
    await session.request('/rest/api/space', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        key: 'WARMUP',
        name: 'Warmup',
        description: { plain: { value: '', representation: 'plain' } },
      }),
    });
  }

  const pageResponse = await session.request('/rest/api/content', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'page',
      title: `warmup-${Date.now()}`,
      space: { key: 'WARMUP' },
      body: { storage: { value: '<p></p>', representation: 'storage' } },
    }),
  });
  const pageId = ((await pageResponse.json()) as { id: string }).id;

  const form = new FormData();
  form.append('file', new Blob([Buffer.from('warmup')]), 'warmup.docx');
  const attachResponse = await session.request(`/rest/api/content/${pageId}/child/attachment`, {
    method: 'POST',
    body: form,
  });
  const { results } = (await attachResponse.json()) as { results: { id: string }[] };

  const editorResponse = await session.request(`/plugins/servlet/onlyoffice/doceditor?attachmentId=${results[0].id}`);
  if (!editorResponse.ok) {
    throw new Error(`[confluence] Editor warm-up request failed: HTTP ${editorResponse.status}`);
  }

  await session.request(`/rest/api/content/${pageId}`, { method: 'DELETE' });
}

/**
 * Spins up the Confluence stack from environments/confluence (Confluence + Postgres), completes
 * the setup wizard (DB/license — via ATL_* variables, the rest — via POST requests), installs the
 * ONLYOFFICE plugin and points it at the Document Server. The resulting address is passed to the
 * tests via process.env.CONFLUENCE_URL.
 */
export async function setup(ds: DocumentServer): Promise<void> {
  if (process.env.CONFLUENCE_URL) {
    console.log(`[confluence] Using existing Confluence at ${process.env.CONFLUENCE_URL} (CONFLUENCE_URL is set) — skipping stack setup`);
    return;
  }

  console.log(
    `[confluence] Starting Confluence ${process.env.CONFLUENCE_VERSION ?? '10.2.14'} (project ${stack.COMPOSE_PROJECT})...`,
  );
  const licenseKey = await getConfluenceLicenseKey();
  stack.sh(`docker compose -p ${stack.COMPOSE_PROJECT} -f ${stack.COMPOSE_FILE} up -d --quiet-pull`, {
    env: {
      CONFLUENCE_VERSION: process.env.CONFLUENCE_VERSION ?? '10.2.14',
      CONFLUENCE_LICENSE_KEY: licenseKey,
      // See docker-compose.yml's ATL_PROXY_NAME — makes Confluence auto-detect this as its base URL
      CONFLUENCE_PROXY_NAME: ds.host,
    },
  });

  console.log('[confluence] Waiting for the Confluence web interface (first start can take a few minutes)...');
  await waitForHttp('Confluence', `${CONFLUENCE_URL}/status`, (r) => r.ok, 900_000);

  await completeSetupWizard();

  await waitForHttp(
    'Confluence (after setup wizard)',
    `${CONFLUENCE_URL}/status`,
    async (r) => r.ok && (await r.text()).includes('RUNNING'),
    300_000,
  );

  const session = createAdminSession();
  await login(session);
  await elevateToWebsudo(session);
  await ensureSecondUser(session);
  await installPlugin(session);
  await configureDocumentServer(session, ds);
  await warmUpEditor(session);

  // Browser-driven tests must reach Confluence via the same host it now considers its own base
  // URL (ATL_PROXY_NAME above) — otherwise the login SPA's XSRF/origin check rejects the request
  // ("Something went wrong") even though the plain REST calls above (no real browser) are fine.
  process.env.CONFLUENCE_URL = `http://${ds.host}:8090`;
  console.log('[confluence] Stack ready');
}

/** Stops and fully removes the Confluence stack along with its volumes */
export function teardown(): void {
  if (process.env.CONFLUENCE_URL) {
    return;
  }
  console.log('[confluence] Removing stack...');
  stack.sh(`docker compose -p ${stack.COMPOSE_PROJECT} -f ${stack.COMPOSE_FILE} down --volumes --remove-orphans`, {
    ignoreErrors: true,
  });
}
