import { randomBytes } from 'node:crypto';
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

/**
 * Spins up a disposable stack before the tests:
 *  - the Alfresco stack from environments/docker-compose.alfresco.yml (version — ALFRESCO_VERSION);
 *  - Document Server (image — DOCUMENTSERVER_IMAGE) with a generated JWT secret;
 *  - the secret and DS URL are passed to the plugin via JAVA_OPTS (alfresco-global.properties);
 *  - the plugin's AMP packages are installed into the alfresco/share containers (as in install.bat) with a restart.
 */
export default async function globalSetup(): Promise<void> {
  if (!isStackManaged()) {
    return;
  }

  const alfrescoUrl = (process.env.ALFRESCO_URL ?? 'http://localhost:8080').replace(/\/$/, '');
  const host = new URL(alfrescoUrl).hostname;
  const dsImage = process.env.DOCUMENTSERVER_IMAGE ?? 'onlyoffice/documentserver:latest';
  const dsPort = process.env.DOCUMENTSERVER_PORT ?? '80';
  const dsUrl = `http://${host}${dsPort === '80' ? '' : `:${dsPort}`}/`;
  const secret = process.env.ONLYOFFICE_JWT_SECRET || randomBytes(24).toString('hex');

  const composeEnv = {
    ALFRESCO_VERSION: process.env.ALFRESCO_VERSION ?? '26.1.0',
    ALFRESCO_HOST: host,
  };

  console.log(`[global.setup] Starting Alfresco ${composeEnv.ALFRESCO_VERSION} (project ${COMPOSE_PROJECT})...`);
  sh(`docker compose -p ${COMPOSE_PROJECT} -f ${COMPOSE_FILE} up -d --quiet-pull`, { env: composeEnv });

  console.log(`[global.setup] Starting Document Server: ${dsImage} (container ${DS_CONTAINER}, port ${dsPort})...`);
  sh(`docker rm -f ${DS_CONTAINER}`, { ignoreErrors: true });
  sh(
    `docker run -d --name ${DS_CONTAINER} -p ${dsPort}:80 ` +
      `-e JWT_ENABLED=true -e JWT_SECRET=${secret} -e JWT_HEADER=Authorization ${dsImage}`,
  );

  await waitForHttp(
    'Document Server',
    `${dsUrl}healthcheck`,
    async (r) => r.ok && (await r.text()).trim() === 'true',
    300_000,
  );
  console.log('[global.setup] Document Server ready, waiting for Alfresco (first start can take a few minutes)...');

  const readyProbe = `${alfrescoUrl}/alfresco/api/-default-/public/alfresco/versions/1/probes/-ready-`;
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
  console.log('[global.setup] Stack ready');
}
