<?php

/**
 * Installs the module build from the artifacts directory into the Drupal codebase (run by
 * ./Dockerfile): php install-module.php <artifacts dir> <module dir>.
 *
 * Takes either build format: the onlyoffice-drupal/ directory CI uploads (the module repository's
 * artifact.yml), or the onlyoffice-drupal-X.Y.Z.zip of a GitHub release, which wraps that same
 * directory.
 */

[, $artifacts, $target] = $argv;

function fail(string $message): never {
  fwrite(STDERR, "[install-module] $message\n");
  exit(1);
}

function run(string $command): void {
  echo "[install-module] $command\n";
  passthru($command, $code);
  if ($code !== 0) {
    fail("Command failed with exit code $code");
  }
}

/** The directory holding onlyoffice.info.yml, at most two levels below $dir */
function findModule(string $dir): ?string {
  foreach (['', '/*', '/*/*'] as $level) {
    $found = glob($dir . $level . '/onlyoffice.info.yml');
    if ($found) {
      return dirname($found[0]);
    }
  }
  return NULL;
}

$module = findModule($artifacts);
if ($module === NULL) {
  $zips = glob("$artifacts/*.zip");
  if (count($zips) !== 1) {
    fail("Expected the module directory or exactly one .zip in $artifacts, found " . count($zips) . ' zip(s) — see artifacts/README.md');
  }
  $zip = new ZipArchive();
  if ($zip->open($zips[0]) !== TRUE || !$zip->extractTo('/tmp/onlyoffice-module')) {
    fail("Could not extract {$zips[0]}");
  }
  $zip->close();
  $module = findModule('/tmp/onlyoffice-module') ?? fail("No onlyoffice.info.yml in {$zips[0]}");
}

if (!glob("$module/assets/document-templates/*")) {
  fail("$module/assets/document-templates is empty — the build must include the document-templates submodule");
}

run('mkdir -p ' . escapeshellarg(dirname($target)));
run('cp -a ' . escapeshellarg($module) . ' ' . escapeshellarg($target));

$composer = json_decode(file_get_contents("$module/composer.json"), TRUE);
$packages = ['drush/drush'];
foreach ($composer['require'] ?? [] as $name => $constraint) {
  if ($name !== 'drupal/core') {
    $packages[] = "$name:$constraint";
  }
}
run('composer require --no-interaction --working-dir=/opt/drupal ' . implode(' ', array_map('escapeshellarg', $packages)));
