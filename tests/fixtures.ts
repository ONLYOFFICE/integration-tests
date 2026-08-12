import { registerAdapter, test, expect } from '@core';
import { AlfrescoAdapter } from '@adapters/alfresco';
import { ConfluenceAdapter } from '@adapters/confluence';
import { JiraAdapter } from '@adapters/jira';
import { LiferayAdapter } from '@adapters/liferay';

// Each Playwright project from playwright.config.ts has its own adapter.
// A new system = a new registerAdapter + a new project in the config.
registerAdapter('alfresco', () => {
  return new AlfrescoAdapter({
    baseUrl: process.env.ALFRESCO_URL ?? 'http://localhost:8080',
    admin: { username: 'admin', password: 'admin' },
    secondUser: { username: 'autotest2', password: 'automation123' },
    readOnlyUser: { username: 'autotest3', password: 'automation123' },
  });
});

registerAdapter('confluence', () => {
  return new ConfluenceAdapter({
    baseUrl: process.env.CONFLUENCE_URL ?? 'http://127.0.0.1:8090',
    admin: { username: 'admin', password: 'admin' },
    secondUser: { username: 'autotest2', password: 'automation123' },
    readOnlyUser: { username: 'autotest3', password: 'automation123' },
  });
});

registerAdapter('jira', () => {
  return new JiraAdapter({
    baseUrl: process.env.JIRA_URL ?? 'http://127.0.0.1:8080',
    admin: { username: 'admin', password: 'admin' },
    secondUser: { username: 'autotest2', password: 'automation123' },
    readOnlyUser: { username: 'autotest3', password: 'automation123' },
  });
});

registerAdapter('liferay', () => {
  return new LiferayAdapter({
    baseUrl: process.env.LIFERAY_URL ?? 'http://localhost:8080',
    admin: {
      username: 'test@liferay.com',
      // Set by tests/setup/liferay.ts once it knows whether the bundled demo account's
      // forced first-login password reset actually fired — see its own comment.
      password: process.env.LIFERAY_PASSWORD ?? 'Automation1',
    },
    secondUser: { username: 'autotest2@example.com', password: 'automation123' },
    readOnlyUser: { username: 'autotest3@example.com', password: 'automation123' },
  });
});

export { test, expect };
