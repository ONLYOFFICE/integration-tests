// Removes all test stacks (containers and networks prefixed with onlyoffice-it-)
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
  docker(`rm -f ${containers.split('\n').join(' ')}`);
  console.log(`Removed containers: ${containers.split('\n').length}`);
} else {
  console.log('No onlyoffice-it-* containers found');
}

const networks = docker('network ls -q --filter "name=^onlyoffice-it-"');
if (networks) {
  docker(`network rm ${networks.split('\n').join(' ')}`);
  console.log(`Removed networks: ${networks.split('\n').length}`);
}

// Anonymous stack volumes have no names — cleaned up only via docker volume prune
