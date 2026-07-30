import { randomBytes } from 'node:crypto';
import * as os from 'node:os';
import { DS_CONTAINER, sh, waitForHttp } from '../stack';

export interface DocumentServer {
  /** Document Server URL, reachable from both the browser and the host systems' containers */
  url: string;
  secret: string;
  /** Host IP shared by the browser and the host systems' docker containers */
  host: string;
}

function hostIpCandidates(): string[] {
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
 * Picks the host IP that containers can use to reach published ports:
 * from inside the DS container we probe its own healthcheck through every
 * machine address (hairpin: container → host IP → published port → container).
 */
function detectHostIp(): string {
  const candidates = hostIpCandidates();
  for (const ip of candidates) {
    const code = sh(
      `docker exec ${DS_CONTAINER} curl -s -o /dev/null -w "%{http_code}" --max-time 5 http://${ip}/healthcheck`,
      { ignoreErrors: true },
    );
    if (code === '200') {
      return ip;
    }
  }
  throw new Error(
    `Could not find a host IP reachable from containers (candidates: ${candidates.join(', ') || 'none'}). ` +
      'Check the firewall.',
  );
}

/**
 * Spins up a disposable Document Server container (image — DOCUMENTSERVER_IMAGE) with
 * a generated JWT secret, and detects the host IP shared by the browser and the host
 * systems' containers. A shared step for all systems — independent of which one is tested.
 */
export async function startDocumentServer(): Promise<DocumentServer> {
  const dsImage = process.env.DOCUMENTSERVER_IMAGE ?? 'onlyoffice/documentserver:latest';
  const secret = randomBytes(24).toString('hex');

  console.log(`[document-server] Starting Document Server: ${dsImage} (container ${DS_CONTAINER}, port 80)...`);
  sh(`docker rm -f ${DS_CONTAINER}`, { ignoreErrors: true });
  sh(
    `docker run -d --name ${DS_CONTAINER} -p 80:80 ` +
      `-e JWT_ENABLED=true -e JWT_SECRET=${secret} -e JWT_HEADER=Authorization ${dsImage}`,
  );
  await waitForHttp(
    'Document Server',
    `http://localhost:80/healthcheck`,
    async (r) => r.ok && (await r.text()).trim() === 'true',
    300_000,
  );

  const host = detectHostIp();
  const url = `http://${host}/`;
  console.log(`[document-server] Host IP: ${host} (Document Server: ${url})`);

  return { url, secret, host };
}

/** Stops and removes the Document Server container */
export function stopDocumentServer(): void {
  sh(`docker rm -f ${DS_CONTAINER}`, { ignoreErrors: true });
}
