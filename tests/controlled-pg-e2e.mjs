import { readCapacityObservation } from './pg-capacity.mjs';
// WEB01-WEB05, LOCK-RM-014-001. Real browser/gateway; synthetic adapters only.
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from './browser.mjs';
import { createPublicServer } from '../app/public-server.mjs';
const reservation = http.createServer();
await new Promise((r) => reservation.listen(0, '127.0.0.1', r));
const port = reservation.address().port;
await new Promise((r) => reservation.close(r));
const origin = 'http://127.0.0.1:' + port,
  directory = await mkdtemp(join(tmpdir(), 'rm-controlled-web-')),
  mail = [],
  outbound = [];
const namespace = 'controlled_web_' + randomBytes(6).toString('hex');
let server, browser;
try {
  server = await createPublicServer({
    capacityObservation: await readCapacityObservation(),
    storeDir: directory,
    env: {
      PUBLIC_ORIGIN: origin,
      PUBLIC_ALLOW_HTTP_LOOPBACK: '1',
      PUBLIC_REGISTRATION_ENABLED: '1',
      PUBLIC_POLICY_ENFORCEMENT: '1',
      CATALOG_BACKEND: 'postgres',
      CATALOG_DATABASE_URL: process.env.RM_TEST_PG,
      CATALOG_NAMESPACE: namespace,
      CONTROLLED_LOCAL_MODE: '1',
    },
    sendAccountMail: async (m) => mail.push(m),
    mailProvider: {
      send: async (m) => {
        outbound.push(m);
        throw Error('Forbidden external send');
      },
    },
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(10000);
  page.on('pageerror', (error) => console.error('BROWSER_ERROR', error.message));
  page.on('response', async (response) => {
    const path = new URL(response.url()).pathname;
    if (response.status() >= 400 && path.startsWith('/api/') && path !== '/api/account/me')
      console.error('API_ERROR', path, response.status(), await response.text());
  });
  await page.goto(origin + '/account?view=register');
  await page.locator('#register-name').fill('Synthetic Candidate');
  await page.locator('#register-email').fill('controlled@example.com');
  await page.locator('#register-password').fill('controlled-password-123');
  await page.locator('#register-terms').check();
  await page.locator('#register-privacy').check();
  await page.locator('#register-form button[type=submit]').click();
  await page.getByRole('heading', { name: 'Check your email', exact: true }).waitFor();
  assert.equal(mail.length, 1);
  const verification = mail[0].text.match(/http:\/\/[^\s]+\/account\?verify=[^\s]+/)?.[0];
  assert.ok(verification);
  await page.goto(verification);
  await page.getByRole('button', { name: 'Verify email address', exact: true }).click();
  await page.locator('#login-email').fill('controlled@example.com');
  await page.locator('#login-password').fill('controlled-password-123');
  await page.locator('#login-form button[type=submit]').click();
  await page
    .getByText('Signed in. Open your workspace when you are ready.', { exact: true })
    .waitFor();
  await page.getByRole('link', { name: 'Open workspace', exact: true }).first().waitFor();
  await page.getByRole('link', { name: 'Open workspace', exact: true }).first().click();
  const cacheReply = await page.request.get(origin + '/api/vacancies?q=Python');
  assert.equal(cacheReply.status(), 200, await cacheReply.text());
  const cached = await cacheReply.json();
  assert.equal(
    cached.collection?.mode,
    'sequential-rounds',
    'WEB02 missing PostgreSQL/separate-worker collection contract',
  );
  const health = await (await page.request.get(origin + '/health')).json();
  assert.equal(
    health.catalogBackend,
    'postgres',
    'selected backend must never silently fall back to SQLite',
  );
  await page.locator('#facts').fill('Built Python PostgreSQL services and operated Kubernetes.');
  await page.locator('#roles').fill('Backend Engineer');
  await page.locator('#country').fill('Portugal');
  await page.locator('#profile-form button[type=submit]').click();
  await page.getByRole('status').filter({ hasText: 'Profile and career goal saved' }).waitFor();
  // The controlled fixture is a synthetic catalog posting, supplied by the explicit test-mode adapter.
  await page.getByRole('button', { name: 'Companies', exact: true }).click();
  await page.locator('#vacancy-browser>details>summary').click();
  await page.locator('#vacancy-query').fill('Controlled Backend Engineer');
  await page.getByRole('button', { name: 'Search vacancies', exact: true }).click();
  const vacancy = page
    .locator('#vacancy-browser article')
    .filter({ hasText: 'Controlled Backend Engineer' })
    .first();
  await vacancy.getByRole('button', { name: 'Review and save vacancy', exact: true }).click();
  await page.getByRole('button', { name: 'Saved jobs', exact: true }).click();
  await page.locator('.saved-job').filter({ hasText: 'Controlled Backend Engineer' }).waitFor();
  await page
    .getByRole('button', { name: 'Prepare application / correspondence', exact: true })
    .first()
    .click();
  await page.getByLabel('CV version', { exact: true }).fill('Synthetic controlled CV');
  await page
    .getByLabel('CV text', { exact: true })
    .fill('Built Python PostgreSQL services and operated Kubernetes.');
  await page.getByRole('button', { name: 'Save application packet', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Application packet saved' }).waitFor();
  await page
    .locator('#application-email-form')
    .getByLabel('Recipient email', { exact: true })
    .fill('candidate-test@example.com');
  await page
    .getByLabel('Application email subject', { exact: true })
    .fill('Controlled application');
  await page
    .getByLabel('Application email body', { exact: true })
    .fill('Please review this synthetic application.');
  await page.locator('#application-email-confirm').check();
  await page.getByRole('button', { name: 'Simulate application email', exact: true }).click();
  await page.getByText('Simulated; no email sent', { exact: true }).first().waitFor();
  await page.locator('#test-mail-tools>summary').click();
  await page.getByRole('button', { name: 'Simulate reply', exact: true }).click();
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByText('Controlled reply received', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Mark notification read', exact: true }).first().click();
  await page.reload();
  const state = await (await page.request.get(origin + '/api/state')).json();
  assert.equal(state.opportunities.length, 1);
  assert.ok(state.opportunities[0].snapshot.catalogRevision);
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].read, true);
  assert.equal(outbound.length, 0, 'no provider send attempt');
  const foreign = await browser.newContext();
  assert.equal((await foreign.request.get(origin + '/api/state')).status(), 401);
  await foreign.close();
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log('WEB01-WEB05 controlled PostgreSQL browser flow PASS; zero external sends');
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
  const cleanup = new pg.Client({ connectionString: process.env.RM_TEST_PG });
  await cleanup.connect();
  await cleanup.query('DROP SCHEMA IF EXISTS ' + namespace + ' CASCADE');
  await cleanup.end();
  await rm(directory, { recursive: true, force: true });
}
