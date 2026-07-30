import { getConfluenceLicenseKey } from './confluence-license';
import { stackFor, waitForHttp } from '../stack';
import type { DocumentServer } from './document-server';

const stack = stackFor('confluence');
const CONFLUENCE_URL = 'http://127.0.0.1:8090'; // not localhost — fetch resolves it to ::1 and hangs

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

// TODO: install the ONLYOFFICE plugin and configure it (like alfresco.ts) — next step.
/**
 * Spins up the Confluence stack from environments/confluence (Confluence + Postgres), completes
 * the setup wizard (DB/license — via ATL_* variables, the rest — via POST requests), and waits
 * for it to be ready. The resulting address is passed to the tests via process.env.CONFLUENCE_URL.
 */
export async function setup(_ds: DocumentServer): Promise<void> {
  console.log(
    `[confluence] Starting Confluence ${process.env.CONFLUENCE_VERSION ?? '10.2.14'} (project ${stack.COMPOSE_PROJECT})...`,
  );
  const licenseKey = await getConfluenceLicenseKey();
  stack.sh(`docker compose -p ${stack.COMPOSE_PROJECT} -f ${stack.COMPOSE_FILE} up -d --quiet-pull`, {
    env: {
      CONFLUENCE_VERSION: process.env.CONFLUENCE_VERSION ?? '10.2.14',
      CONFLUENCE_LICENSE_KEY: licenseKey,
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

  process.env.CONFLUENCE_URL = CONFLUENCE_URL;
  console.log('[confluence] Stack ready');
}

/** Stops and fully removes the Confluence stack along with its volumes */
export function teardown(): void {
  console.log('[confluence] Removing stack...');
  stack.sh(`docker compose -p ${stack.COMPOSE_PROJECT} -f ${stack.COMPOSE_FILE} down --volumes --remove-orphans`, {
    ignoreErrors: true,
  });
}
