import { execFileSync } from 'node:child_process';

/**
 * Runs a command in the Drupal container. execFileSync rather than stack.sh(): arguments go to
 * docker as they are, without a shell (cmd.exe on Windows) mangling the quotes in PHP code.
 */
export function drupalExec(container: string, args: string[], options: { user?: string; input?: string } = {}): string {
  try {
    return execFileSync(
      'docker',
      ['exec', '-i', '-u', options.user ?? 'www-data', '-e', 'HOME=/tmp', '-w', '/opt/drupal', container, ...args],
      { encoding: 'utf8', input: options.input ?? '', stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();
  } catch (error) {
    const { stdout, stderr, status } = error as { stdout?: string; stderr?: string; status?: number };
    const output = [stdout, stderr].filter(Boolean).join('\n') || '(no output)';
    throw new Error(`[drupal] ${args.join(' ')} failed with exit code ${status}:\n${output}`);
  }
}

/** --uri makes the absolute URLs drush builds (e.g. for the connection check) use the stand's address */
export function drupalDrush(container: string, uri: string, ...args: string[]): string {
  return drupalExec(container, ['vendor/bin/drush', `--uri=${uri}`, ...args]);
}

/**
 * drush on the stand the tests run against — for the few things neither the UI nor JSON:API can
 * set (e.g. a secret the settings form would reject). Published by tests/setup/drupal.ts; absent
 * when the tests reuse an existing Drupal (DRUPAL_URL), so callers skip then.
 */
export function standDrush(): ((...args: string[]) => string) | undefined {
  const container = process.env.DRUPAL_CONTAINER;
  const uri = process.env.DRUPAL_URL;
  return container && uri ? (...args: string[]) => drupalDrush(container, uri, ...args) : undefined;
}
