// Removes all test stacks (containers, networks, and volumes prefixed with onlyoffice-it-)
// left behind by abnormally interrupted runs.
import { execSync } from 'node:child_process';

function docker(args) {
  try {
    return execSync(`docker ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return '';
  }
}

const containers = docker('ps -aq --filter "name=^onlyoffice-it-"');
if (containers) {
  // -v also removes each container's anonymous volumes (e.g. Document Server's) —
  // without it they silently pile up across interrupted runs
  docker(`rm -f -v ${containers.split('\n').join(' ')}`);
  console.log(`Removed containers: ${containers.split('\n').length}`);
} else {
  console.log('No onlyoffice-it-* containers found');
}

const networks = docker('network ls -q --filter "name=^onlyoffice-it-"');
if (networks) {
  docker(`network rm ${networks.split('\n').join(' ')}`);
  console.log(`Removed networks: ${networks.split('\n').length}`);
}

const volumes = docker('volume ls -q --filter "name=^onlyoffice-it-"');
if (volumes) {
  docker(`volume rm ${volumes.split('\n').join(' ')}`);
  console.log(`Removed volumes: ${volumes.split('\n').length}`);
} else {
  console.log('No onlyoffice-it-* volumes found');
}
