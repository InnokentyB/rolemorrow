import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium } from './browser.mjs';
import { createPublicServer } from '../app/public-server.mjs';
const socket = http.createServer();
await new Promise((r) => socket.listen(0, '127.0.0.1', r));
const port = socket.address().port;
await new Promise((r) => socket.close(r));
const origin = 'http://127.0.0.1:' + port,
  directory = await mkdtemp(join(tmpdir(), 'mcp-browser-')),
  mail = [];
let server, browser;
try {
  server = await createPublicServer({
    storeDir: directory,
    env: {
      PUBLIC_ORIGIN: origin,
      PUBLIC_ALLOW_HTTP_LOOPBACK: '1',
      PUBLIC_REGISTRATION_ENABLED: '1',
      MCP_ENABLED: '1',
      ALLOW_LIVE: '0',
    },
    sendAccountMail: async (m) => mail.push(m),
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext(),
    page = await context.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const post = async (path, body) =>
    context.request.post(origin + path, { headers: { Origin: origin }, data: body });
  const email = 'mcp-browser@example.test',
    password = 'Synthetic-MCP-Password-2026!';
  assert.equal(
    (await post('/api/account/register', { name: 'Browser Candidate', email, password })).status(),
    202,
  );
  const token = mail[0].token ?? JSON.stringify(mail[0]).match(/[?&]verify=([^\s"'<>\\]+)/)?.[1];
  assert.ok(token);
  assert.equal((await post('/api/account/verify', { token })).status(), 200);
  assert.equal((await post('/api/account/login', { email, password })).status(), 200);
  const verifier = 'm'.repeat(43),
    p = {
      response_type: 'code',
      client_id: 'rolemorrow-codex',
      redirect_uri: 'http://127.0.0.1:41239/callback',
      resource: origin + '/mcp',
      scope: 'mcp:read mcp:write',
      state: 'browser-owned-state',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
    };
  let callback;
  await page.route('http://127.0.0.1:41239/callback?*', async (route) => {
    callback = new URL(route.request().url());
    await route.fulfill({ body: 'Authorized synthetic callback' });
  });
  await page.goto(origin + '/oauth/authorize?' + new URLSearchParams(p));
  await page.locator('#consent-form button').waitFor();
  assert.equal((await context.request.get(origin + '/api/connections')).status(), 200);
  assert.equal(
    (await (await context.request.get(origin + '/api/connections')).json()).connections.length,
    0,
  );
  await page.locator('#consent-form button').click();
  await page.waitForURL('http://127.0.0.1:41239/callback?*');
  assert.equal(callback.searchParams.get('state'), p.state);
  assert.ok(callback.searchParams.get('code'));
  await page.goto(origin + '/connections');
  await page.getByRole('button', { name: 'Revoke connection' }).waitFor();
  for (const viewport of [
    { width: 1280, height: 900 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      true,
    );
    await page.screenshot({
      path: '/evidence/mcp-connections-' + viewport.width + '.png',
      fullPage: true,
    });
  }
  await page.getByRole('button', { name: 'Revoke connection' }).click();
  await page.getByText('Connection revoked.', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Revoke connection' }).isDisabled(), true);
  const connections = (await (await context.request.get(origin + '/api/connections')).json())
    .connections;
  assert.equal(connections[0].active, false);
  assert.deepEqual(errors, []);
  console.log(
    'MCP-WEB01 PASS: explicit browser consent, exact callback/state, desktop/mobile, own connection revocation; sandbox enabled.',
  );
} finally {
  await browser?.close();
  if (server) await new Promise((r) => server.close(r));
  await rm(directory, { recursive: true, force: true });
}
