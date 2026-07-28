import { registerAdapter, test, expect } from '@core';
import { AlfrescoAdapter } from '@adapters/alfresco';

// Each Playwright project from playwright.config.ts has its own adapter.
// A new system = a new registerAdapter + a new project in the config.
registerAdapter('alfresco', () => {
  return new AlfrescoAdapter({
    baseUrl: process.env.ALFRESCO_URL ?? 'http://localhost:8080',
    admin: {
      username: process.env.ALFRESCO_USER ?? 'admin',
      password: process.env.ALFRESCO_PASSWORD ?? 'admin',
    },
  });
});

export { test, expect };
