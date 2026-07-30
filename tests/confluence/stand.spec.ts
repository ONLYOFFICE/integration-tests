import { test, expect } from '@playwright/test';

// Placeholder until ConfluenceAdapter exists: verifies that global.setup
// spun up the Confluence stack (not Alfresco) and wrote its address to env.
test('Confluence stack is up', async () => {
  expect(process.env.CONFLUENCE_URL).toBeTruthy();
});
