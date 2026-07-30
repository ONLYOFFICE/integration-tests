import { stopDocumentServer } from './setup/document-server';
import { selectedSystems, standFor } from './setup/registry';

/** Stops and removes the stack(s) of the system(s) that were spun up, and Document Server */
export default async function globalTeardown(): Promise<void> {
  console.log('[global.teardown] Removing stack...');
  for (const system of selectedSystems()) {
    standFor(system).teardown();
  }
  stopDocumentServer();
  console.log('[global.teardown] Stack stopped and removed');
}
