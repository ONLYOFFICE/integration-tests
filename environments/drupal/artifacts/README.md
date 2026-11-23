# onlyoffice-drupal module artifacts

Put the module build here, in either format:

- the `onlyoffice-drupal-X.Y.Z.zip` of a GitHub release;
- the `onlyoffice-drupal/` directory the module repository's `artifact.yml`
  workflow uploads (what `.github/workflows/e2e.yml` downloads in CI).

The build must include the `assets/document-templates` submodule, as both of
those do; a plain `git clone` without `--recurse-submodules` doesn't.

`../Dockerfile` (via `../install-module.php`) copies the module into
`web/modules/contrib/onlyoffice` of a thin layer over `DRUPAL_IMAGE` and installs
its composer requirements plus drush. `tests/setup/drupal.ts` then installs the
site, sets up the private file system, enables Media, JSON:API, Basic Auth, the
module and its `onlyoffice_form` submodule, adds a content type with an
ONLYOFFICE form field, points the module at the Document Server and runs the
module's own connection check.

The test accounts and their roles are created by `tests/setup/drupal.ts` on every
stack startup — no files need to be placed here for that.

Release versions: <https://github.com/ONLYOFFICE/onlyoffice-drupal/releases>
