import * as fs from 'node:fs';
import * as path from 'node:path';
import { AlfrescoAdapter } from '@adapters/alfresco';
import { stackFor, waitForHttp } from '../stack';
import type { DocumentServer } from './document-server';

const MMT = '/usr/local/tomcat/alfresco-mmt/alfresco-mmt*.jar';

const stack = stackFor('alfresco');
const ALFRESCO_CONTAINER = `${stack.COMPOSE_PROJECT}-alfresco-1`;
const SHARE_CONTAINER = `${stack.COMPOSE_PROJECT}-share-1`;

// setup() publishes the fresh stack's address via process.env.ALFRESCO_URL for the fixtures to
// pick up, so teardown() can't tell "reused" from "just started" by re-checking that var — it
// has to be captured up front, before setup() overwrites it.
let reusingExisting = false;

/**
 * Spins up the Alfresco stack from environments/alfresco (version — ALFRESCO_VERSION),
 * installs the plugin's AMP packages and its settings (alfresco-global.properties)
 * with a restart, and verifies the plugin ↔ Document Server connection.
 * The resulting address is passed to the tests via process.env.ALFRESCO_URL.
 */
export async function setup(ds: DocumentServer): Promise<void> {
  reusingExisting = Boolean(process.env.ALFRESCO_URL);
  if (reusingExisting) {
    console.log(`[alfresco] Using existing Alfresco at ${process.env.ALFRESCO_URL} (ALFRESCO_URL is set) — skipping stack setup`);
    return;
  }

  const alfrescoUrl = `http://${ds.host}:8080`;

  console.log(
    `[alfresco] Starting Alfresco ${process.env.ALFRESCO_VERSION ?? '26.1.0'} (project ${stack.COMPOSE_PROJECT})...`,
  );
  stack.sh(`docker compose -p ${stack.COMPOSE_PROJECT} -f ${stack.COMPOSE_FILE} up -d --quiet-pull`, {
    env: {
      ALFRESCO_VERSION: process.env.ALFRESCO_VERSION ?? '26.1.0',
      ALFRESCO_HOST: ds.host,
    },
  });

  const readyProbe = `${alfrescoUrl}/alfresco/api/-default-/public/alfresco/versions/1/probes/-ready-`;
  console.log('[alfresco] Waiting for Alfresco (first start can take a few minutes)...');
  await waitForHttp('Alfresco', readyProbe, (r) => r.ok, 900_000);

  console.log('[alfresco] Installing plugin AMP packages and restarting alfresco/share...');
  shipAmp(ALFRESCO_CONTAINER, 'onlyoffice-integration-repo.amp', '/usr/local/tomcat/amps');
  shipAmp(SHARE_CONTAINER, 'onlyoffice-integration-share.amp', '/usr/local/tomcat/amps_share');
  stack.sh(
    `docker exec -u root ${ALFRESCO_CONTAINER} bash -c ` +
      `"java -jar ${MMT} install /usr/local/tomcat/amps/onlyoffice-integration-repo.amp /usr/local/tomcat/webapps/alfresco -nobackup -force"`,
  );
  stack.sh(
    `docker exec -u root ${SHARE_CONTAINER} bash -c ` +
      `"java -jar ${MMT} install /usr/local/tomcat/amps_share/onlyoffice-integration-share.amp /usr/local/tomcat/webapps/share -nobackup -force"`,
  );
  // Plugin settings — via alfresco-global.properties (the documented approach);
  // they'll be picked up by the same restart that activates the AMP
  stack.sh(
    `docker exec -u root ${ALFRESCO_CONTAINER} bash -c ` +
      `"printf 'onlyoffice.url=%s\\nonlyoffice.security.key=%s\\n' '${ds.url}' '${ds.secret}' ` +
      `>> /usr/local/tomcat/shared/classes/alfresco-global.properties"`,
  );
  stack.sh(`docker restart ${ALFRESCO_CONTAINER} ${SHARE_CONTAINER}`);

  await waitForHttp('Alfresco (after plugin install)', readyProbe, (r) => r.ok, 300_000);
  await waitForHttp('Share', `${alfrescoUrl}/share/page/`, (r) => r.ok, 300_000);

  console.log('[alfresco] Verifying plugin ↔ Document Server connection...');
  const adapter = new AlfrescoAdapter({
    baseUrl: alfrescoUrl,
    admin: { username: 'admin', password: 'admin' },
    secondUser: { username: 'autotest2', password: 'automation123' },
    readOnlyUser: { username: 'autotest3', password: 'automation123' },
  });
  await adapter.validateDocumentServer();

  // Force Save is off by default — without it, pressing Save in an open editing session has
  // nothing to persist until the session (tab) closes, which is what the force-save scenario
  // specifically needs to tell apart from the regular close-triggered save.
  console.log('[alfresco] Enabling Force Save...');
  await adapter.configureDocumentServer(ds.url, ds.secret, true);

  console.log('[alfresco] Creating the second test account...');
  await adapter.ensureSecondUser();

  console.log('[alfresco] Creating the read-only test account...');
  await adapter.ensureReadOnlyUser();

  // Playwright workers inherit process.env — the address will reach the fixtures
  process.env.ALFRESCO_URL = alfrescoUrl;
  console.log('[alfresco] Stack ready');
}

/**
 * Ships one AMP from environments/alfresco/artifacts into a running container.
 * `docker cp` rather than a compose bind mount on purpose: the daemon resolves mount sources on
 * the docker host, so when the tests themselves run in a container (CI) the artifacts path exists
 * only inside that container and the daemon silently mounts an empty directory in its place —
 * alfresco-mmt then fails with "File Not Found, ...amp (Is a directory)". `docker cp` streams the
 * file through the API from wherever the client sees it, so both layouts work.
 */
function shipAmp(container: string, amp: string, targetDir: string): void {
  const source = path.join(stack.ENV_DIR, 'artifacts', amp);
  if (!fs.existsSync(source) || !fs.statSync(source).isFile()) {
    throw new Error(`[alfresco] No ${amp} found in ${path.dirname(source)} — see artifacts/README.md`);
  }
  stack.sh(`docker exec -u root ${container} mkdir -p ${targetDir}`);
  stack.sh(`docker cp "${source}" ${container}:${targetDir}/${amp}`);
}

/** Stops and fully removes the Alfresco stack along with its volumes */
export function teardown(): void {
  if (reusingExisting) {
    return;
  }
  console.log('[alfresco] Removing stack...');
  stack.sh(`docker compose -p ${stack.COMPOSE_PROJECT} -f ${stack.COMPOSE_FILE} down --volumes --remove-orphans`, {
    ignoreErrors: true,
  });
}
