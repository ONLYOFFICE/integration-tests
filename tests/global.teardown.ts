import { stopDocumentServer } from './setup/document-server';
import { selectedSystems, standFor } from './setup/registry';

/** Stops and removes the stack that was spun up (see global.setup.ts), and Document Server */
export default async function globalTeardown(): Promise<void> {
  console.log('[global.teardown] Removing stack...');
  const [system] = selectedSystems();
  standFor(system).teardown();
  stopDocumentServer();
  console.log('[global.teardown] Stack stopped and removed');
}
