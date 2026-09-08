# onlyoffice-mattermost plugin artifacts

Put the plugin build (a single `com.onlyoffice.mattermost-*.tar.gz`) here.
`tests/setup/mattermost.ts` picks it up and installs it via the System Console
REST API (`POST /api/v4/plugins`), enables it, then points the plugin at the
Document Server and verifies the connection through the plugin's own health
endpoint.

Mattermost accounts, the `integration-tests` team/channel, and onboarding
disablement are handled automatically by `tests/setup/mattermost.ts` on every
stack startup — no files need to be placed here for that.

Release versions: <https://github.com/ONLYOFFICE/onlyoffice-mattermost/releases>
