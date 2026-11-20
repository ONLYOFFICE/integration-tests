# onlyoffice-nuxeo package artifacts

Put the package build (a single `onlyoffice-nuxeo-package-*.zip`) here.
`tests/setup/nuxeo.ts` bakes it into a thin image layer over `NUXEO_IMAGE`
(see `../Dockerfile`), lets the image's entrypoint install it on first start
together with its `nuxeo-web-ui` dependency (`NUXEO_PACKAGES`, which needs
`NUXEO_CLID` — see `.env.example`), then points the package at the Document
Server through its own settings endpoint (`POST /nuxeo/api/v1/onlyoffice/settings`)
and checks the connection through the validation results that call returns.

Nuxeo accounts, the `integration-tests` workspace and its permissions are set
up automatically by `tests/setup/nuxeo.ts` on every stack startup — no files
need to be placed here for that.

The build must match the Nuxeo generation `NUXEO_IMAGE` runs: a package built
against `nuxeo-parent 2021.x` (the published 3.0.0 release, target platform
`[2021,)`) fails to deploy on Nuxeo 2025 — its bundles still reference
`javax.servlet`, which 2025 (Jakarta EE) no longer ships — so for a 2025 image
use a 3.1.0+ build (`nuxeo-parent 2025.x`, target platform `[2025,)`). `nuxeoctl mp-install` itself accepts either; the mismatch
only shows up in the server log at startup (`NoClassDefFoundError:
javax/servlet/ServletRequest`), which `tests/setup/nuxeo.ts` dumps to
`test-results/` when the container fails to start.

Release versions: <https://github.com/ONLYOFFICE/onlyoffice-nuxeo/releases>
