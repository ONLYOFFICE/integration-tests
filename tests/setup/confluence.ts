import { stackFor, waitForHttp } from '../stack';
import type { DocumentServer } from './document-server';

const stack = stackFor('confluence');

// TODO: install the ONLYOFFICE plugin and configure it (like alfresco.ts) — next step.
/**
 * Spins up the Confluence stack from environments/confluence (Confluence + Postgres) and
 * waits for it to be ready. The resulting address is passed to the tests via process.env.CONFLUENCE_URL.
 */
export async function setup(_ds: DocumentServer): Promise<void> {
  console.log(
    `[confluence] Starting Confluence ${process.env.CONFLUENCE_VERSION ?? '10.2.14'} (project ${stack.COMPOSE_PROJECT})...`,
  );
  stack.sh(`docker compose -p ${stack.COMPOSE_PROJECT} -f ${stack.COMPOSE_FILE} up -d --quiet-pull`, {
    env: { CONFLUENCE_VERSION: process.env.CONFLUENCE_VERSION ?? '10.2.14' },
  });

  const confluenceUrl = 'http://localhost:8090';
  console.log('[confluence] Waiting for Confluence (first start can take a few minutes)...');
  await waitForHttp(
    'Confluence',
    `${confluenceUrl}/status`,
    async (r) => r.ok && (await r.text()).includes('RUNNING'),
    900_000,
  );

  process.env.CONFLUENCE_URL = confluenceUrl;
  console.log('[confluence] Stack ready');
}

/** Stops and fully removes the Confluence stack along with its volumes */
export function teardown(): void {
  console.log('[confluence] Removing stack...');
  stack.sh(`docker compose -p ${stack.COMPOSE_PROJECT} -f ${stack.COMPOSE_FILE} down --volumes --remove-orphans`, {
    ignoreErrors: true,
  });
}
