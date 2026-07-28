import { execSync } from 'node:child_process';
import * as path from 'node:path';

/** Compose project with the Alfresco stack managed by global.setup/teardown */
export const COMPOSE_PROJECT = 'onlyoffice-tests';
export const COMPOSE_FILE = 'docker-compose.alfresco.yml';
export const ENV_DIR = path.resolve(__dirname, '..', 'environments');

export const ALFRESCO_CONTAINER = `${COMPOSE_PROJECT}-alfresco-1`;
export const SHARE_CONTAINER = `${COMPOSE_PROJECT}-share-1`;
export const DS_CONTAINER = process.env.DOCUMENTSERVER_CONTAINER ?? 'onlyoffice-ds-tests';

/** The tests spin up and tear down the stack themselves; STACK_MANAGED=false — the stack is set up manually */
export function isStackManaged(): boolean {
  return process.env.STACK_MANAGED !== 'false';
}

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
