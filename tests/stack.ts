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

/** Run identifier and Document Server container shared by all systems */
export const COMPOSE_PROJECT = `onlyoffice-it-${runId()}`;
export const DS_CONTAINER = `${COMPOSE_PROJECT}-ds`;

export interface Stack {
  /** Compose project for this system's stack: onlyoffice-it-<runId>-<system> */
  readonly COMPOSE_PROJECT: string;
  readonly COMPOSE_FILE: string;
  readonly ENV_DIR: string;
  sh(command: string, options?: { env?: Record<string, string>; ignoreErrors?: boolean }): string;
}

/** Stack for a specific system: environments/<system>/docker-compose.yml + its own compose project */
export function stackFor(system: string): Stack {
  const COMPOSE_PROJECT = `onlyoffice-it-${runId()}-${system}`;
  const COMPOSE_FILE = 'docker-compose.yml';
  const ENV_DIR = path.resolve(__dirname, '..', 'environments', system);

  return {
    COMPOSE_PROJECT,
    COMPOSE_FILE,
    ENV_DIR,
    sh(command, options = {}) {
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
    },
  };
}

/** sh() for commands not tied to a specific compose stack (e.g. for the DS container) */
export function sh(command: string, options: { env?: Record<string, string>; ignoreErrors?: boolean } = {}): string {
  try {
    return execSync(command, {
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
