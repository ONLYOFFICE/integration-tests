# Environments

Each host system gets its own directory with its full environment:

```
environments/
  alfresco/
    docker-compose.yml   # Alfresco stack (repo, share, postgres, solr, ...)
    commons/base.yaml    # traefik proxy and routes (from acs-deployment)
    artifacts/           # onlyoffice-alfresco plugin builds (see README there)
  confluence/            # (future systems follow the same pattern)
```

The stack is managed by `tests/global.setup.ts` / `global.teardown.ts`: spun up
before the tests, plugin installed, fully removed after the run. Document Server
is spun up as a separate container; its image is configured in `.env`.
