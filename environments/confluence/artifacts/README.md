# onlyoffice-confluence plugin artifacts

The plugin build goes here; global.setup will install it into the container
before the tests (similar to `environments/alfresco/artifacts/`) — this will
be added at the plugin install/configure step in `tests/setup/confluence.ts`.

Confluence's own setup wizard (database, license, deployment type, admin
account, etc.) is completed automatically by `tests/setup/confluence.ts` on
every stack startup — no files need to be placed here for that.
