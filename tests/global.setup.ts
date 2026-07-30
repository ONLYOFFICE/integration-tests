import { startDocumentServer } from './setup/document-server';
import { selectedSystems, standFor } from './setup/registry';

/**
 * Spins up a disposable stack before the tests: a Document Server shared by all
 * systems, then the stack(s) of whichever system (or systems) the tests are
 * actually running against (see tests/setup/registry.ts). The logic for spinning
 * up a specific system lives in tests/setup/<system>.ts.
 */
export default async function globalSetup(): Promise<void> {
  const systems = selectedSystems();
  console.log(`[global.setup] Starting stacks: ${systems.join(', ')}`);

  const ds = await startDocumentServer();

  for (const system of systems) {
    await standFor(system).setup(ds);
  }

  console.log('[global.setup] Stack ready');
}
