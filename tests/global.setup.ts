import { startDocumentServer } from './setup/document-server';
import { selectedSystems, standFor } from './setup/registry';

/**
 * Spins up a disposable stack before the tests: a Document Server, then the
 * stack of whichever single system the tests are running against (see
 * tests/setup/registry.ts). The logic for spinning up a specific system lives
 * in tests/setup/<system>.ts.
 *
 * Only one system runs per Playwright invocation — each system's
 * docker-compose.yml publishes fixed host ports (e.g. 8080, 5432), so two
 * stands up at once would collide. There is no "run everything" command; run
 * one of npm run test:alfresco / test:confluence / test:jira / test:liferay.
 */
export default async function globalSetup(): Promise<void> {
  const systems = selectedSystems();
  if (systems.length > 1) {
    throw new Error(
      `Refusing to start ${systems.length} stands at once (${systems.join(', ')}) — their docker-compose ` +
        'stacks publish fixed host ports and would collide. Run a single system, ' +
        'e.g. npm run test:alfresco (or npx playwright test --project=<system>).',
    );
  }
  const [system] = systems;
  console.log(`[global.setup] Starting stack: ${system}`);

  const ds = await startDocumentServer();
  await standFor(system).setup(ds);

  console.log('[global.setup] Stack ready');
}
