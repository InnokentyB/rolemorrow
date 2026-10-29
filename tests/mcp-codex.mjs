import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createPublicServer } from '../app/public-server.mjs';
const reservation = http.createServer();
await new Promise((r) => reservation.listen(0, '127.0.0.1', r));
const port = reservation.address().port;
await new Promise((r) => reservation.close(r));
const origin = 'http://127.0.0.1:' + port,
  dir = await mkdtemp(join(tmpdir(), 'mcp-codex-')),
  mail = [];
let server, login;
const env = { ...process.env, HOME: dir, CODEX_HOME: join(dir, 'codex') };
async function command(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('/usr/local/bin/codex', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    p.stdout.on('data', (d) => (output += d));
    p.stderr.on('data', (d) => (output += d));
    p.on('error', reject);
    p.on('exit', (code) =>
      code === 0 ? resolve(output) : reject(Error('Codex command failed: ' + output)),
    );
  });
}
try {
  await mkdir(env.CODEX_HOME, { mode: 0o700 });
  server = await createPublicServer({
    storeDir: join(dir, 'data'),
    env: {
      PUBLIC_ORIGIN: origin,
      PUBLIC_ALLOW_HTTP_LOOPBACK: '1',
      PUBLIC_REGISTRATION_ENABLED: '1',
      MCP_ENABLED: '1',
    },
    sendAccountMail: async (m) => mail.push(m),
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const post = async (path, body, cookie) =>
    fetch(origin + path, {
      method: 'POST',
      headers: {
        Origin: origin,
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify(body),
    });
  const email = 'codex-client@example.test',
    password = 'Synthetic-MCP-Password-2026!';
  await post('/api/account/register', { name: 'Codex Candidate', email, password });
  const token = mail[0].token ?? JSON.stringify(mail[0]).match(/[?&]verify=([^\s"'<>\\]+)/)?.[1];
  await post('/api/account/verify', { token });
  const signed = await post('/api/account/login', { email, password }),
    cookie = signed.headers
      .getSetCookie()
      .find((c) => c.startsWith('rm_session='))
      .split(';')[0];
  await writeFile(
    join(env.CODEX_HOME, 'config.toml'),
    '[mcp_servers.rolemorrow-synthetic]\nurl = ' +
      JSON.stringify(origin + '/mcp') +
      '\n[mcp_servers.rolemorrow-synthetic.oauth]\nclient_id = "rolemorrow-codex"\ncallback_url = "http://127.0.0.1/callback"\n',
  );
  let output = '';
  login = spawn(
    '/usr/local/bin/codex',
    ['mcp', 'login', 'rolemorrow-synthetic', '--no-browser', '--scopes', 'mcp:read,mcp:write'],
    { env, stdio: ['pipe', 'pipe', 'pipe'] },
  );
  login.stdout.on('data', (d) => (output += d));
  login.stderr.on('data', (d) => (output += d));
  const deadline = Date.now() + 15000;
  let url;
  while (Date.now() < deadline) {
    url = output.match(/http:\/\/127\.0\.0\.1:\d+\/oauth\/authorize\?[^\s]+/)?.[0];
    if (url) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(url, 'Actual Codex must emit OAuth authorization URL: ' + output);
  const page = await fetch(url, { headers: { Cookie: cookie }, redirect: 'manual' }),
    html = await page.text();
  assert.equal(
    page.status,
    200,
    'Actual Codex callback ' +
      new URL(url).searchParams.get('redirect_uri') +
      ' must be accepted: ' +
      html,
  );
  const requestId = html.match(/name=["']requestId["'][^>]*value=["']([^"']+)/)?.[1];
  assert.ok(requestId);
  const consent = await post('/api/connections/authorize', { requestId, consent: true }, cookie);
  assert.equal(consent.status, 200);
  const redirectTo = (await consent.json()).redirectTo;
  login.stdin.write(redirectTo + '\n');
  const code = await Promise.race([
    new Promise((r) => login.on('exit', r)),
    new Promise((_, reject) =>
      setTimeout(() => reject(Error('Codex login timeout: ' + output)), 15000),
    ),
  ]);
  assert.equal(code, 0, output);
  const list = await command(['mcp', 'list']);
  assert.match(list, /rolemorrow-synthetic/);
  const files = await readFile(join(dir, 'codex', 'config.toml'), 'utf8');
  assert.match(files, /rolemorrow-codex/);
  console.log(
    'CODEX-OAUTH01 PASS: installed Codex CLI native OAuth login against synthetic Rolemorrow; no model calls.',
  );
} finally {
  login?.kill('SIGTERM');
  if (server) await new Promise((r) => server.close(r));
  await rm(dir, { recursive: true, force: true });
}
