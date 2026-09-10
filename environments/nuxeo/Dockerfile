# Thin layer over the official Nuxeo image that only bakes the ONLYOFFICE package build from
# artifacts/ into the image. The package itself is installed by the image's own entrypoint on the
# container's first start (NUXEO_PACKAGES in docker-compose.yml, together with its nuxeo-web-ui
# dependency from Nuxeo Connect) — see tests/setup/nuxeo.ts.
#
# An image layer rather than a bind mount or `docker cp`: the daemon resolves bind-mount sources on
# the docker host, so when the tests themselves run in a container (CI) the paths under
# environments/nuxeo/ are invisible to it, and `docker cp` into a not-yet-started container can't
# fix the file's owner/mode for the unprivileged user Nuxeo runs as. COPY --chown does both from
# wherever the client sees the build context.
ARG NUXEO_IMAGE
FROM ${NUXEO_IMAGE}

# 900:0 is the `nuxeo` user the image runs as (its USER instruction) — nuxeoctl must be able to
# read the zip when the entrypoint installs it.
COPY --chown=900:0 artifacts/*.zip /opt/nuxeo/local-packages/
