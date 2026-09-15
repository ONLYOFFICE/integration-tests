import * as fs from 'node:fs';
import * as path from 'node:path';
import { loadConvertTemplate } from '@core';
import { stackFor, waitForHttp } from '../stack';
import type { DocumentServer } from './document-server';

const stack = stackFor('mattermost');

let MATTERMOST_URL = 'http://127.0.0.1:8065';
const ADMIN_USER = 'admin';
const ADMIN_PASSWORD = 'adminadmin';
const SECOND_USER = 'autotest1';
const SECOND_PASSWORD = 'automation123';
const READONLY_USER = 'autotest2';
const READONLY_PASSWORD = 'automation123';

const PLUGIN_ID = 'com.onlyoffice.mattermost';
const DES_JWT_HEADER = 'AuthorizationJWT';

const TEST_TEAM_NAME = 'integration-tests';
const TEST_CHANNEL_NAME = 'integration-tests';

if (process.argv.includes('--project=mattermost')) {
  process.env.DOCUMENTSERVER_HEADER ??= DES_JWT_HEADER;
}

const MATTERMOST_CONTAINER = `${stack.COMPOSE_PROJECT}-mattermost-1`;

let reusingExisting = false;
let composeFileArgs = '';

interface AdminSession {
  request(path: string, init?: RequestInit): Promise<Response>;
}

async function createAdminSession(): Promise<AdminSession> {
  const response = await fetch(`${MATTERMOST_URL}/api/v4/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ login_id: ADMIN_USER, password: ADMIN_PASSWORD }),
  });

  const token = response.headers.get('Token');
  if (!response.ok || !token) {
    throw new Error(`[mattermost] Admin login failed: HTTP ${response.status} ${await response.text().catch(() => '')}`);
  }

  return {
    async request(reqPath, init = {}) {
      const headers: Record<string, string> = {
        ...(init.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${token}`,
      };

      const res = await fetch(`${MATTERMOST_URL}${reqPath}`, { ...init, headers });
      if (!res.ok) {
        throw new Error(`[mattermost] API ${init.method ?? 'GET'} ${reqPath}: ${res.status} ${await res.text().catch(() => '')}`);
      }

      return res;
    },
  };
}

function createUsers(): void {
  console.log('[mattermost] Creating test accounts...');
  stack.sh(
    `docker exec ${MATTERMOST_CONTAINER} mmctl --local user create ` +
      `--email admin@example.com --username ${ADMIN_USER} --password ${ADMIN_PASSWORD} --system-admin --email-verified`,
  );
  stack.sh(
    `docker exec ${MATTERMOST_CONTAINER} mmctl --local user create ` +
      `--email autotest1@example.com --username ${SECOND_USER} --password ${SECOND_PASSWORD} --email-verified`,
  );
  stack.sh(
    `docker exec ${MATTERMOST_CONTAINER} mmctl --local user create ` +
      `--email autotest2@example.com --username ${READONLY_USER} --password ${READONLY_PASSWORD} --email-verified`,
  );
}

function createTeamAndChannel(): void {
  console.log(`[mattermost] Creating team/channel (${TEST_TEAM_NAME})...`);
  stack.sh(
    `docker exec ${MATTERMOST_CONTAINER} mmctl --local team create ` +
      `--name ${TEST_TEAM_NAME} --display-name "Integration Tests" --email admin@example.com`,
  );
  stack.sh(`docker exec ${MATTERMOST_CONTAINER} mmctl --local team users add ${TEST_TEAM_NAME} ${ADMIN_USER} ${SECOND_USER} ${READONLY_USER}`);
  stack.sh(
    `docker exec ${MATTERMOST_CONTAINER} mmctl --local channel create ` +
      `--team ${TEST_TEAM_NAME} --name ${TEST_CHANNEL_NAME} --display-name "Integration Tests"`,
  );
  stack.sh(
    `docker exec ${MATTERMOST_CONTAINER} mmctl --local channel users add ` +
      `${TEST_TEAM_NAME}:${TEST_CHANNEL_NAME} ${ADMIN_USER} ${SECOND_USER} ${READONLY_USER}`,
  );
}

async function resolveTeamAndChannelIds(session: AdminSession): Promise<{ teamId: string; channelId: string }> {
  const channel = (await (
    await session.request(`/api/v4/teams/name/${TEST_TEAM_NAME}/channels/name/${TEST_CHANNEL_NAME}`)
  ).json()) as { id: string; team_id: string };

  return { teamId: channel.team_id, channelId: channel.id };
}

async function installPlugin(session: AdminSession): Promise<void> {
  const artifactsDir = path.join(stack.ENV_DIR, 'artifacts');
  const artifactName = fs.readdirSync(artifactsDir).find((name) => name.endsWith('.tar.gz'));
  if (!artifactName) {
    throw new Error(`[mattermost] No plugin .tar.gz found in ${artifactsDir} — see artifacts/README.md`);
  }

  console.log(`[mattermost] Installing plugin ${artifactName}...`);

  const form = new FormData();
  form.append('plugin', new Blob([fs.readFileSync(path.join(artifactsDir, artifactName))]), artifactName);

  await session.request('/api/v4/plugins', { method: 'POST', body: form });
  await session.request(`/api/v4/plugins/${PLUGIN_ID}/enable`, { method: 'POST' });
}

async function configureDocumentServer(session: AdminSession, ds: DocumentServer): Promise<void> {
  console.log('[mattermost] Configuring the plugin to use the Document Server...');
  const config = (await (await session.request('/api/v4/config')).json()) as {
    PluginSettings: { Plugins: Record<string, unknown> };
    ServiceSettings: { EnableOnboardingFlow?: boolean };
  };

  config.PluginSettings.Plugins[PLUGIN_ID] = {
    DESAddress: ds.url,
    DESJwt: ds.secret,
    DESJwtHeader: ds.header,
    DESJwtPrefix: 'Bearer ',
    DESAllowPrivate: true,
    DemoEnabled: false,
    Formats: '',
    OwnerProtected: false,
    PluginsEnabled: true,
    MacrosEnabled: true,
    HealthNotificationsEnabled: false,
  };

  config.ServiceSettings.EnableOnboardingFlow = false;
  await session.request('/api/v4/config', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });

  console.log('[mattermost] Waiting for the plugin to confirm the Document Server connection...');
  await waitForHttp(
    'ONLYOFFICE plugin health',
    `${MATTERMOST_URL}/plugins/${PLUGIN_ID}/api/health`,
    async (r) => r.ok && (await r.json()).healthy === true,
    60_000,
  );
}

async function warmUpConverter(session: AdminSession, channelId: string): Promise<void> {
  console.log("[mattermost] Warming up Document Server's converter (works around the plugin's 4s convert timeout)...");
  try {
    const form = new FormData();
    form.append('channel_id', channelId);
    form.append('files', new Blob([new Uint8Array(loadConvertTemplate('odt'))]), 'warmup.odt');

    const uploadResponse = await session.request('/api/v4/files', {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(15_000),
    });

    const fileId = ((await uploadResponse.json()) as { file_infos: { id: string }[] }).file_infos[0].id;

    await session.request('/api/v4/posts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel_id: channelId, message: '', file_ids: [fileId] }),
      signal: AbortSignal.timeout(15_000),
    });

    await session.request(`/plugins/${PLUGIN_ID}/api/convert`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (error) {
    console.log(`[mattermost] Converter warm-up call didn't succeed (expected on a genuinely cold start) — ${error}`);
  }
}

export async function setup(ds: DocumentServer): Promise<void> {
  reusingExisting = Boolean(process.env.MATTERMOST_URL);
  if (reusingExisting) {
    console.log(`[mattermost] Using existing Mattermost at ${process.env.MATTERMOST_URL} (MATTERMOST_URL is set) — skipping stack setup`);
    return;
  }

  MATTERMOST_URL = `http://${ds.host}:8065`;

  const buildArm = process.env.MATTERMOST_ARM === 'true';
  const version = process.env.MATTERMOST_VERSION ?? '11.10.1';
  const image = process.env.MATTERMOST_IMAGE ?? (buildArm ? 'onlyoffice-it-mattermost-arm64:local' : `mattermost/mattermost-team-edition:${version}`);
  const composeFiles = [stack.COMPOSE_FILE, ...(buildArm ? ['docker-compose.arm.yml'] : [])];
  composeFileArgs = composeFiles.map((file) => `-f ${file}`).join(' ');

  process.env.MATTERMOST_IMAGE = image;
  process.env.MATTERMOST_VERSION = version;
  process.env.MATTERMOST_HOST = ds.host;

  console.log(`[mattermost] Starting Mattermost (${image}, project ${stack.COMPOSE_PROJECT})...`);
  stack.sh(`docker compose -p ${stack.COMPOSE_PROJECT} ${composeFileArgs} up -d --quiet-pull${buildArm ? ' --build' : ''}`, {
    env: {
      MATTERMOST_IMAGE: image,
      MATTERMOST_HOST: ds.host,
      MATTERMOST_VERSION: version,
    },
  });

  console.log('[mattermost] Waiting for the Mattermost web interface (first start can take a minute)...');
  await waitForHttp('Mattermost', `${MATTERMOST_URL}/api/v4/system/ping`, (r) => r.ok, 300_000);

  createUsers();
  createTeamAndChannel();

  const session = await createAdminSession();
  const { teamId, channelId } = await resolveTeamAndChannelIds(session);
  await installPlugin(session);
  await configureDocumentServer(session, ds);
  await warmUpConverter(session, channelId);

  process.env.MATTERMOST_URL = MATTERMOST_URL;
  process.env.MATTERMOST_CHANNEL_ID = channelId;
  process.env.MATTERMOST_TEAM_ID = teamId;

  console.log('[mattermost] Stack ready');
}

export function teardown(): void {
  if (reusingExisting) {
    return;
  }

  console.log('[mattermost] Removing stack...');
  stack.sh(`docker compose -p ${stack.COMPOSE_PROJECT} ${composeFileArgs || `-f ${stack.COMPOSE_FILE}`} down --volumes --remove-orphans`, {
    ignoreErrors: true,
  });
}
