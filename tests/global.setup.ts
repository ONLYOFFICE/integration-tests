import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import { AlfrescoAdapter } from '@adapters/alfresco';
import {
  ALFRESCO_CONTAINER,
  COMPOSE_FILE,
  COMPOSE_PROJECT,
  DS_CONTAINER,
  isStackManaged,
  sh,
  SHARE_CONTAINER,
  waitForHttp,
} from './stack';

const MMT = '/usr/local/tomcat/alfresco-mmt/alfresco-mmt*.jar';

function hostIpCandidates(): string[] {
  const candidates: string[] = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) {
        candidates.push(info.address);
      }
    }
  }
  return candidates;
}

/**
 * Picks the host IP that containers can use to reach published ports:
 * from inside the DS container we probe its own healthcheck through every
 * machine address (hairpin: container → host IP → published port → container).
 */
function detectHostIp(): string {
  const candidates = hostIpCandidates();
  for (const ip of candidates) {
    const code = sh(
      `docker exec ${DS_CONTAINER} curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://${ip}/healthcheck`,
      { ignoreErrors: true },
    );
    if (code === '200') {
      return ip;
    }
  }
  throw new Error(
    `Could not find a host IP reachable from containers (candidates: ${candidates.join(', ') || 'none'}). ` +
      'Check the firewall or set the address explicitly via TEST_HOST_IP.',
  );
}

/**
 * Spins up a disposable stack before the tests:
 *  - Document Server (image — DOCUMENTSERVER_IMAGE) with a generated JWT secret;
 *  - detects the host IP shared by the browser and the containers;
 *  - the Alfresco stack from environments/alfresco (version — ALFRESCO_VERSION);
 *  - the plugin's AMP packages and its settings (alfresco-global.properties) with a restart.
 * The resulting Alfresco address is passed to the tests via process.env.ALFRESCO_URL.
 */
export default async function globalSetup(): Promise<void> {
  if (!isStackManaged()) {
    if (!process.env.ALFRESCO_URL) {
      throw new Error('STACK_MANAGED=false requires an explicit ALFRESCO_URL in .env');
    }
    return;
  }

  const dsImage = process.env.DOCUMENTSERVER_IMAGE ?? 'onlyoffice/documentserver:latest';
  const secret = process.env.ONLYOFFICE_JWT_SECRET || randomBytes(24).toString('hex');

  console.log(`[global.setup] Starting Document Server: ${dsImage} (container ${DS_CONTAINER}, port 80)...`);
  sh(`docker rm -f ${DS_CONTAINER}`, { ignoreErrors: true });
  sh(
    `docker run -d --name ${DS_CONTAINER} -p 80:80 ` +
      `-e JWT_ENABLED=true -e JWT_SECRET=${secret} -e JWT_HEADER=Authorization ${dsImage}`,
  );
  await waitForHttp(
    'Document Server',
    `http://localhost:80/healthcheck`,
    async (r) => r.ok && (await r.text()).trim() === 'true',
    300_000,
  );

  const host = process.env.TEST_HOST_IP || detectHostIp();
  const dsUrl = `http://${host}/`;
  const alfrescoUrl = `http://${host}:8080`;
  console.log(`[global.setup] Host IP: ${host} (Alfresco: ${alfrescoUrl}, Document Server: ${dsUrl})`);

  console.log(`[global.setup] Starting Alfresco ${process.env.ALFRESCO_VERSION ?? '26.1.0'} (project ${COMPOSE_PROJECT})...`);
  sh(`docker compose -p ${COMPOSE_PROJECT} -f ${COMPOSE_FILE} up -d --quiet-pull`, {
    env: {
      ALFRESCO_VERSION: process.env.ALFRESCO_VERSION ?? '26.1.0',
      ALFRESCO_HOST: host,
    },
  });

  const readyProbe = `${alfrescoUrl}/alfresco/api/-default-/public/alfresco/versions/1/probes/-ready-`;
  console.log('[global.setup] Waiting for Alfresco (first start can take a few minutes)...');
  await waitForHttp('Alfresco', readyProbe, (r) => r.ok, 900_000);

  console.log('[global.setup] Installing plugin AMP packages and restarting alfresco/share...');
  sh(
    `docker exec -u root ${ALFRESCO_CONTAINER} bash -c ` +
      `"java -jar ${MMT} install /usr/local/tomcat/amps/onlyoffice-integration-repo.amp /usr/local/tomcat/webapps/alfresco -nobackup -force"`,
  );
  sh(
    `docker exec -u root ${SHARE_CONTAINER} bash -c ` +
      `"java -jar ${MMT} install /usr/local/tomcat/amps_share/onlyoffice-integration-share.amp /usr/local/tomcat/webapps/share -nobackup -force"`,
  );
  // Plugin settings — via alfresco-global.properties (the documented approach);
  // they'll be picked up by the same restart that activates the AMP
  sh(
    `docker exec -u root ${ALFRESCO_CONTAINER} bash -c ` +
      `"printf 'onlyoffice.url=%s\\nonlyoffice.security.key=%s\\n' '${dsUrl}' '${secret}' ` +
      `>> /usr/local/tomcat/shared/classes/alfresco-global.properties"`,
  );
  sh(`docker restart ${ALFRESCO_CONTAINER} ${SHARE_CONTAINER}`);

  await waitForHttp('Alfresco (after plugin install)', readyProbe, (r) => r.ok, 300_000);
  await waitForHttp('Share', `${alfrescoUrl}/share/page/`, (r) => r.ok, 300_000);

  console.log('[global.setup] Verifying plugin ↔ Document Server connection...');
  const adapter = new AlfrescoAdapter({
    baseUrl: alfrescoUrl,
    admin: {
      username: process.env.ALFRESCO_USER ?? 'admin',
      password: process.env.ALFRESCO_PASSWORD ?? 'admin',
    },
  });
  await adapter.validateDocumentServer();

  // Playwright workers inherit process.env — the address will reach the fixtures
  process.env.ALFRESCO_URL = alfrescoUrl;
  console.log('[global.setup] Stack ready');
}
