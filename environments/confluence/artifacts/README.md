# onlyoffice-confluence plugin artifacts

Put the plugin build (a single `.jar`, any filename) here. `tests/setup/confluence.ts`
picks it up and installs it via the UPM REST API (`docker-compose.yml` enables unsigned
plugin uploads for this), then points the plugin at the Document Server and verifies
the connection.

Confluence's own setup wizard (database, license, deployment type, admin
account, etc.) is completed automatically by `tests/setup/confluence.ts` on
every stack startup — no files need to be placed here for that.
