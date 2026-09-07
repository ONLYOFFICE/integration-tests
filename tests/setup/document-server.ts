import { randomBytes } from 'node:crypto';
import * as dns from 'node:dns/promises';
import * as os from 'node:os';
import { DS_CONTAINER, sh } from '../stack';

export interface DocumentServer {
  /** Document Server URL, reachable from both the browser and the host systems' containers */
  url: string;
  secret: string;
  header: string;
  /** Host IP shared by the browser and the host systems' docker containers */
  host: string;
}

const IPV4 = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\b/;

/** Addresses of the machine the tests (and the browser) run on */
function localCandidates(): string[] {
  const candidates: string[] = [];
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family === 'IPv4' && !info.internal) {
        candidates.push(info.address);
      }
    }
  }
  return candidates;
}

/**
 * Where the published ports live as seen from inside a container: the gateway of every
 * network the DS container is attached to (i.e. the docker host on that bridge) and
 * host.docker.internal. This is the only usable answer when the tests themselves run
 * inside a container (Gitea/GitHub runners with a mounted docker socket): there the
 * machine's own interfaces are the *runner's* addresses, and nothing is published on them.
 */
function dockerHostCandidates(): string[] {
  const candidates: string[] = [];

  const resolved = sh(`docker exec ${DS_CONTAINER} getent hosts host.docker.internal`, { ignoreErrors: true });
  const hostGateway = resolved.match(IPV4)?.[1];
  if (hostGateway) {
    candidates.push(hostGateway);
  }

  const gateways = sh(
    `docker inspect -f "{{range .NetworkSettings.Networks}}{{.Gateway}} {{end}}" ${DS_CONTAINER}`,
    { ignoreErrors: true },
  );
  for (const gateway of gateways.split(/\s+/)) {
    if (IPV4.test(gateway)) {
      candidates.push(gateway);
    }
  }

  return candidates;
}

/** Address of a remote docker daemon (DOCKER_HOST=tcp://docker:2376 — docker-in-docker CI) */
async function dockerDaemonCandidates(): Promise<string[]> {
  const dockerHost = process.env.DOCKER_HOST;
  if (!dockerHost || !/^(tcp|ssh|https?):\/\//.test(dockerHost)) {
    return [];
  }
  const { hostname } = new URL(dockerHost);
  if (IPV4.test(hostname)) {
    return [hostname];
  }
  try {
    const { address } = await dns.lookup(hostname, { family: 4 });
    return [address];
  } catch {
    return [];
  }
}

/** Can the tests (and therefore the browser) reach the published DS port at this address? */
async function reachableFromTests(ip: string): Promise<boolean> {
  try {
    const response = await fetch(`http://${ip}/healthcheck`, { signal: AbortSignal.timeout(5_000) });
    return response.ok;
  } catch {
    return false;
  }
}

/** Can a container reach the published DS port at this address? (hairpin: DS → host IP → DS) */
function reachableFromContainers(ip: string): boolean {
  const code = sh(
    `docker exec ${DS_CONTAINER} curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://${ip}/healthcheck`,
    { ignoreErrors: true },
  );
  return code === '200';
}

/**
 * Picks the address that both sides can use to reach published ports: the browser
 * (running next to the tests) and the containers (DS itself, the host system's stack).
 * Every candidate is probed from both sides — an address that only one of them can
 * reach is worse than useless, since it silently breaks the DS callbacks or the browser.
 *
 * OIT_HOST_IP pins the answer when the automatic probe can't find one.
 */
async function detectHostIp(): Promise<string> {
  if (process.env.OIT_HOST_IP) {
    return process.env.OIT_HOST_IP;
  }

  const candidates = [...new Set([...localCandidates(), ...dockerHostCandidates(), ...(await dockerDaemonCandidates())])];
  const rejected: string[] = [];
  for (const ip of candidates) {
    const fromContainers = reachableFromContainers(ip);
    const fromTests = await reachableFromTests(ip);
    if (fromContainers && fromTests) {
      return ip;
    }
    rejected.push(`${ip} (containers: ${fromContainers ? 'ok' : 'no'}, tests: ${fromTests ? 'ok' : 'no'})`);
  }

  throw new Error(
    `Could not find a host IP reachable from both the containers and the tests. Tried: ${rejected.join('; ') || 'nothing'}. ` +
      'Check the firewall, or pin the address with OIT_HOST_IP=<ip>.',
  );
}

/** Waits until Document Server reports itself healthy inside its own container */
async function waitForDocumentServer(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = 'no response';
  while (Date.now() < deadline) {
    last = sh(`docker exec ${DS_CONTAINER} curl -s --max-time 5 http://127.0.0.1/healthcheck`, { ignoreErrors: true }).trim();
    if (last === 'true') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }

  throw new Error(
    `Document Server not ready after ${Math.round(timeoutMs / 1000)}s (healthcheck inside ${DS_CONTAINER}: ${last})`,
  );
}

/**
 * Spins up a disposable Document Server container (image — DOCUMENTSERVER_IMAGE) with
 * a generated JWT secret, and detects the host IP shared by the browser and the host
 * systems' containers. A shared step for all systems — independent of which one is tested.
 */
export async function startDocumentServer(header = 'Authorization'): Promise<DocumentServer> {
  if (process.env.DOCUMENTSERVER_URL) {
    const url = process.env.DOCUMENTSERVER_URL;
    const secret = process.env.DOCUMENTSERVER_SECRET ?? '';
    const host = new URL(url).hostname;
    console.log(`[document-server] Using existing Document Server at ${url} (DOCUMENTSERVER_URL is set) — skipping startup`);
    return { url, secret, host, header };
  }

  const dsImage = process.env.DOCUMENTSERVER_IMAGE ?? 'onlyoffice/documentserver:latest';
  const secret = randomBytes(24).toString('hex');

  console.log(`[document-server] Starting Document Server: ${dsImage} (container ${DS_CONTAINER}, port 80)...`);
  sh(`docker rm -f -v ${DS_CONTAINER}`, { ignoreErrors: true });
  sh(
    `docker run -d --name ${DS_CONTAINER} -p 80:80 --add-host host.docker.internal:host-gateway ` +
      `-e JWT_ENABLED=true -e JWT_SECRET=${secret} -e JWT_HEADER=${header} ${dsImage}`,
  );

  await waitForDocumentServer(300_000);

  const host = await detectHostIp();
  const url = `http://${host}/`;
  console.log(`[document-server] Host IP: ${host} (Document Server: ${url})`);

  return { url, secret, host, header };
}

/** Stops and removes the Document Server container along with its anonymous volumes */
export function stopDocumentServer(): void {
  if (process.env.DOCUMENTSERVER_URL) {
    return;
  }
  sh(`docker rm -f -v ${DS_CONTAINER}`, { ignoreErrors: true });
}
