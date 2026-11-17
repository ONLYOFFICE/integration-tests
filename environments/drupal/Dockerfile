# Thin layer over the official Drupal image: the ONLYOFFICE module build from artifacts/ goes to
# web/modules/contrib/onlyoffice, and its composer requirements plus drush (which the official
# image doesn't ship) into the Drupal codebase. The site itself is installed and configured by
# tests/setup/drupal.ts once the container runs.
#
# An image layer rather than a bind mount, for the same reason as environments/nuxeo/Dockerfile:
# when the tests run in a container (CI), the daemon can't see paths under environments/drupal/.
ARG DRUPAL_IMAGE
FROM ${DRUPAL_IMAGE}

ENV COMPOSER_ALLOW_SUPERUSER=1

COPY artifacts/ /tmp/artifacts/
COPY install-module.php /tmp/install-module.php
RUN php /tmp/install-module.php /tmp/artifacts /opt/drupal/web/modules/contrib/onlyoffice \
    && rm -rf /tmp/artifacts /tmp/install-module.php /tmp/onlyoffice-module
