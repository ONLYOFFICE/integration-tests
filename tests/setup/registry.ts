import * as alfresco from './alfresco';
import * as confluence from './confluence';
import * as jira from './jira';
import * as liferay from './liferay';
import type { DocumentServer } from './document-server';

export interface SystemStand {
  setup(ds: DocumentServer): Promise<void>;
  teardown(): void;
}

const SYSTEMS: Record<string, SystemStand> = { alfresco, confluence, jira, liferay };

/**
 * Systems the tests are actually running against — from --project=<name> in the
 * Playwright arguments (see testMatch in playwright.config.ts). Without the flag —
 * all known systems.
 */
export function selectedSystems(): string[] {
  const requested = process.argv
    .filter((arg) => arg.startsWith('--project='))
    .map((arg) => arg.slice('--project='.length))
    .filter((name) => name in SYSTEMS);
  return requested.length ? requested : Object.keys(SYSTEMS);
}

export function standFor(system: string): SystemStand {
  return SYSTEMS[system];
}
