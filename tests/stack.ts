import { execSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';

/**
 * Unique run identifier (testcontainers-style): isolates container, network,
 * and volume names across parallel runs. Stored in env so that global.setup
 * and global.teardown see the same value; can be pinned externally:
 * OIT_RUN_ID=deadbeef01 npx playwright test.
 */
function runId(): string {
  if (!process.env.OIT_RUN_ID) {
    process.env.OIT_RUN_ID = randomBytes(5).toString('hex');
  }
  return process.env.OIT_RUN_ID;
}

/** Compose project with the Alfresco stack managed by global.setup/teardown */
export const COMPOSE_PROJECT = `onlyoffice-it-${runId()}`;
export const COMPOSE_FILE = 'docker-compose.yml';
export const ENV_DIR = path.resolve(__dirname, '..', 'environments', 'alfresco');

export const ALFRESCO_CONTAINER = `${COMPOSE_PROJECT}-alfresco-1`;
export const SHARE_CONTAINER = `${COMPOSE_PROJECT}-share-1`;
export const DS_CONTAINER = `${COMPOSE_PROJECT}-ds`;

export function sh(command: string, options: { env?: Record<string, string>; ignoreErrors?: boolean } = {}): string {
  try {
    return execSync(command, {
      cwd: ENV_DIR,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...options.env },
    }).trim();
  } catch (error) {
    if (options.ignoreErrors) {
      return '';
    }
    throw error;
  }
}

export async function waitForHttp(
  label: string,
  url: string,
  isReady: (response: Response) => Promise<boolean> | boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (await isReady(response)) {
        return;
      }
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`${label} not ready after ${Math.round(timeoutMs / 1000)}s (${url}: ${lastError})`);
}
