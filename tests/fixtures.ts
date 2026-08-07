import { registerAdapter, test, expect } from '@core';
import { AlfrescoAdapter } from '@adapters/alfresco';
import { ConfluenceAdapter } from '@adapters/confluence';
import { JiraAdapter } from '@adapters/jira';

// Each Playwright project from playwright.config.ts has its own adapter.
// A new system = a new registerAdapter + a new project in the config.
registerAdapter('alfresco', () => {
  return new AlfrescoAdapter({
    baseUrl: process.env.ALFRESCO_URL ?? 'http://localhost:8080',
    admin: {
      username: process.env.ALFRESCO_USER ?? 'admin',
      password: process.env.ALFRESCO_PASSWORD ?? 'admin',
    },
    secondUser: {
      username: process.env.ALFRESCO_USER2 ?? 'autotest2',
      password: process.env.ALFRESCO_PASSWORD2 ?? 'automation123',
    },
    readOnlyUser: {
      username: process.env.ALFRESCO_USER3 ?? 'autotest3',
      password: process.env.ALFRESCO_PASSWORD3 ?? 'automation123',
    },
  });
});

registerAdapter('confluence', () => {
  return new ConfluenceAdapter({
    baseUrl: process.env.CONFLUENCE_URL ?? 'http://127.0.0.1:8090',
    admin: {
      username: process.env.CONFLUENCE_USER ?? 'admin',
      password: process.env.CONFLUENCE_PASSWORD ?? 'admin',
    },
    secondUser: {
      username: process.env.CONFLUENCE_USER2 ?? 'autotest2',
      password: process.env.CONFLUENCE_PASSWORD2 ?? 'automation123',
    },
    readOnlyUser: {
      username: process.env.CONFLUENCE_USER3 ?? 'autotest3',
      password: process.env.CONFLUENCE_PASSWORD3 ?? 'automation123',
    },
  });
});

registerAdapter('jira', () => {
  return new JiraAdapter({
    baseUrl: process.env.JIRA_URL ?? 'http://127.0.0.1:8080',
    admin: {
      username: process.env.JIRA_USER ?? 'admin',
      password: process.env.JIRA_PASSWORD ?? 'admin',
    },
    secondUser: {
      username: process.env.JIRA_USER2 ?? 'autotest2',
      password: process.env.JIRA_PASSWORD2 ?? 'automation123',
    },
    readOnlyUser: {
      username: process.env.JIRA_USER3 ?? 'autotest3',
      password: process.env.JIRA_PASSWORD3 ?? 'automation123',
    },
  });
});

export { test, expect };
