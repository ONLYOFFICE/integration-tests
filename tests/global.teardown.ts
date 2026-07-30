import { COMPOSE_FILE, COMPOSE_PROJECT, DS_CONTAINER, sh } from './stack';

/** Stops and removes the whole stack (Alfresco stack and Document Server) along with its volumes */
export default async function globalTeardown(): Promise<void> {
  console.log('[global.teardown] Removing stack...');
  sh(`docker compose -p ${COMPOSE_PROJECT} -f ${COMPOSE_FILE} down --volumes --remove-orphans`, {
    ignoreErrors: true,
  });
  sh(`docker rm -f ${DS_CONTAINER}`, { ignoreErrors: true });
  console.log('[global.teardown] Stack stopped and removed');
}
