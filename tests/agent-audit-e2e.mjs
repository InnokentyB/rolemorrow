// Fully fictional public-release fixture; no personal career record.
import { createHash } from 'node:crypto';
import { readCapacityObservation } from './pg-capacity.mjs';
// GEN-WEB01 full generated application workflow, deterministic fixture only.
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from './browser.mjs';
import { TERMS_VERSION, PRIVACY_VERSION, policyDigest } from '../app/policies.mjs';
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
  const masterFact = 'Built Python PostgreSQL services and operated Kubernetes.';
  let cover = 'I would like to discuss the Backend Engineer role. ' + masterFact;
  let answers =
    'Question: What database experience do you have?\nAnswer: ' +
    masterFact +
    '\nQuestion: Do you hold a Kubernetes certification?\nAnswer: Not supplied in my confirmed profile.';
  const masterFacts = [
    masterFact,
    'At Synthetic Platform Co, Platform Manager from March 2021 to April 2023. Led five platform products and reduced time-to-market by 37%.',
    'At Synthetic AI Co, Service Product Manager from June 2023 to September 2025. Delivered an AI workflow with 63% automatic processing.',
    'Led gradual decomposition of billing and ordering services from a legacy monolith.',
  ];
  await page.locator('#facts').fill(masterFacts.join('\n'));
  await page.locator('#roles').fill('Backend Engineer');
  await page.locator('#country').fill('Canada');
  await page.locator('#profile-form button[type=submit]').click();
  await page.getByRole('status').filter({ hasText: 'Profile and career goal saved' }).waitFor();
  // Exercise a real UI fixture scan so its assessment/rejection history exists before saving a catalog role.
  await page.getByRole('button', { name: 'Companies', exact: true }).click();
  await page
    .locator('#company-sources')
    .fill('Northstar | https://northstar.example | https://northstar.example/careers | AI');
  await page.getByRole('button', { name: 'Save companies', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Company sources saved' }).waitFor();
  await page.locator('#mode').selectOption('fixture');
  await page.locator('#scan').click();
  await page.getByText('Check complete.', { exact: true }).waitFor();
  // The controlled fixture is a synthetic catalog posting, supplied by the explicit test-mode adapter.
  await page.getByRole('button', { name: 'Companies', exact: true }).click();
  await page.locator('#vacancy-browser>details>summary').click();
  await page.locator('#vacancy-query').fill('Controlled Backend Engineer');
  await page.getByRole('button', { name: 'Search vacancies', exact: true }).click();
  const vacancy = page
    .locator('#vacancy-browser article')
    .filter({ hasText: 'Controlled Backend Engineer' })
    .first();
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
    vacancy.getByRole('button', { name: 'Review and save vacancy', exact: true }).click(),
  ]);
  await page.waitForFunction(() => !document.querySelector('#example').disabled);
  await page.getByRole('button', { name: 'Saved jobs', exact: true }).click();
  await page.locator('.saved-job').filter({ hasText: 'Controlled Backend Engineer' }).waitFor();
  await page
    .getByRole('button', { name: 'Prepare application / correspondence', exact: true })
    .first()
    .click();
  // Preserve a previously saved attachment in the same session before generating.
  await page.getByLabel('CV version', { exact: true }).fill('Existing reviewed CV');
  await page.getByLabel('CV text', { exact: true }).fill(masterFact);
  await page.locator('#cv-files').setInputFiles({
    name: 'support.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Synthetic attachment content'),
  });
  {
    const savedResponse = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        /^\/api\/applications\/[^/]+$/.test(new URL(r.url()).pathname),
    );
    await page.getByRole('button', { name: 'Save application packet', exact: true }).click();
    const response = await savedResponse;
    assert.equal(response.status(), 200, await response.text());
  }
  await page.getByRole('status').filter({ hasText: 'Application packet saved' }).waitFor();
  const originalPacket = (await (await page.request.get(origin + '/api/state')).json())
    .applications[0];
  assert.equal(originalPacket.files.length, 1);
  const employerQuestions = [
    'What database experience do you have?',
    'Do you hold a Kubernetes certification?',
  ];
  await page.locator('#prepare-questions').fill(employerQuestions.join('\n'));
  await page.locator('#prepare-consent').check();
  const prepareRequest = page.waitForRequest(
    (r) => r.method() === 'POST' && r.url().endsWith('/prepare'),
  );
  await page.locator('#prepare-packet').click();
  assert.deepEqual(
    (await prepareRequest).postDataJSON().questions,
    employerQuestions,
    'textarea must preserve two exact questions',
  );
  await page.locator('#prepare-status').filter({ hasText: 'Draft ready for review' }).waitFor();
  const cv = await page.getByLabel('CV text', { exact: true }).inputValue();
  cover = await page.getByLabel('Cover letter', { exact: true }).inputValue();
  answers = await page.getByLabel('Screening answers', { exact: true }).inputValue();
  assert.ok(cv.includes(masterFact));
  for (const section of ['Professional Summary', 'Skills', 'Experience'])
    assert.ok(cv.includes(section));
  assert.ok(cv.includes('37%'));
  assert.ok(cv.includes('63%'));
  assert.ok(cover.includes('Controlled Tech'));
  assert.notEqual(cover, cv);
  assert.doesNotMatch(cover, /Please review this draft|Saved evidence relevant|review required/i);
  assert.doesNotMatch(answers, /Saved evidence relevant|review required/i);
  assert.ok(answers.includes(employerQuestions[0]));
  assert.ok(answers.includes(employerQuestions[1]));
  assert.match(answers, /not stated|not supplied|not specified|clarify|unknown/i);
  assert.doesNotMatch(answers, /I am certified/);
  assert.ok((await page.locator('#prepare-sources').textContent()).includes(masterFact));
  assert.ok(
    (await page.locator('#prepare-sources').textContent()).includes(
      'Synthetic preparation; no live AI.',
    ),
  );
  await page.screenshot({ path: '/evidence/agent-audit-application-desktop.png', fullPage: true });
  const generatedRequestId = (await prepareRequest).postDataJSON().requestId;
  const beforeSave = await (await page.request.get(origin + '/api/state')).json();
  assert.equal(beforeSave.applications.length, 1, 'generation never auto-saves');
  assert.equal(
    beforeSave.applications[0].cvText,
    masterFact,
    'existing packet unchanged before explicit save',
  );
  assert.equal(beforeSave.mailDispatches.length, 0, 'generation never auto-dispatches');
  {
    const savedResponse = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        /^\/api\/applications\/[^/]+$/.test(new URL(r.url()).pathname),
    );
    await page.getByRole('button', { name: 'Save application packet', exact: true }).click();
    const response = await savedResponse;
    assert.equal(response.request().postDataJSON().preparedRequestId, generatedRequestId);
    assert.equal(response.status(), 200, await response.text());
  }
  await page.getByRole('status').filter({ hasText: 'Application packet saved' }).waitFor();
  let saved = await (await page.request.get(origin + '/api/state')).json();
  assert.equal(saved.applications.length, 1);
  assert.equal(saved.applications[0].files.length, 1);
  assert.equal(saved.applications[0].files[0].id, originalPacket.files[0].id);
  const fileResponse = await page.request.get(
    origin +
      '/api/application-files/' +
      saved.opportunities[0].id +
      '/' +
      saved.applications[0].files[0].id,
  );
  assert.equal(fileResponse.status(), 200);
  assert.equal((await fileResponse.body()).toString(), 'Synthetic attachment content');
  assert.equal(saved.applications[0].cvText, cv);
  assert.equal(saved.applications[0].coverLetter, cover);
  assert.equal(saved.applications[0].answers, answers);
  assert.equal(saved.applications[0].profileVersion, saved.profile.version);
  assert.equal(saved.profile.facts[0].text, masterFact);
  // Manual editing must remove verified-generation claims while retaining the normal save flow.
  await page.getByLabel('Cover letter', { exact: true }).fill(cover + ' Manual review.');
  await page.getByLabel('Cover letter', { exact: true }).fill(cover);
  const manualSaveResponse = page.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      /^\/api\/applications\/[^/]+$/.test(new URL(r.url()).pathname),
  );
  await page.getByRole('button', { name: 'Save application packet', exact: true }).click();
  const manualSaved = await manualSaveResponse;
  assert.equal(manualSaved.status(), 200, await manualSaved.text());
  assert.equal(
    manualSaved.request().postDataJSON().preparedRequestId,
    undefined,
    'edited text must not retain exact generated proof',
  );
  await page.getByRole('status').filter({ hasText: 'Application packet saved' }).waitFor();
  await page.reload();
  await page.getByRole('button', { name: 'Applications', exact: true }).click();
  assert.equal(await page.getByLabel('CV text', { exact: true }).inputValue(), cv);
  assert.equal(await page.getByLabel('Cover letter', { exact: true }).inputValue(), cover);
  assert.equal(await page.getByLabel('Screening answers', { exact: true }).inputValue(), answers);
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
  assert.equal(state.applications[0].cvText, cv);
  assert.equal(state.applications[0].coverLetter, cover);
  assert.equal(state.applications[0].answers, answers);
  assert.equal(state.mailDispatches.length, 1);
  assert.equal(state.mailDispatches[0].opportunityId, state.opportunities[0].id);
  assert.equal(state.mailDispatches[0].packetRevision, state.applications[0].revision);
  assert.equal(state.messages.length, 1);
  assert.equal(state.messages[0].opportunityId, state.opportunities[0].id);
  assert.equal(state.notifications[0].messageId, state.messages[0].id);
  assert.equal(state.notifications[0].opportunityId, state.opportunities[0].id);
  assert.equal(state.notifications.length, 1);
  assert.equal(state.notifications[0].read, true);
  assert.equal(outbound.length, 0, 'no provider send attempt');
  const foreign = await browser.newContext();
  assert.equal((await foreign.request.get(origin + '/api/state')).status(), 401);
  const beforeOwner = await (await page.request.get(origin + '/api/state')).json();
  const email = 'other-controlled@example.com',
    password = 'other-controlled-password-123';
  const registered = await foreign.request.post(origin + '/api/account/register', {
    headers: { Origin: origin },
    data: {
      email,
      password,
      name: 'Other synthetic candidate',
      acceptance: {
        termsAccepted: true,
        privacyAcknowledged: true,
        termsVersion: TERMS_VERSION,
            termsDigest: policyDigest('terms'),
            privacyDigest: policyDigest('privacy'),
        privacyVersion: PRIVACY_VERSION,
      },
    },
  });
  assert.equal(registered.status(), 202, await registered.text());
  const token = mail.find((m) => m.to === email).text.match(/[?&]verify=([^\s]+)/)[1];
  assert.equal(
    (
      await foreign.request.post(origin + '/api/account/verify', {
        headers: { Origin: origin },
        data: { token: decodeURIComponent(token) },
      })
    ).status(),
    200,
  );
  const login = await foreign.request.post(origin + '/api/account/login', {
    headers: { Origin: origin },
    data: { email, password },
  });
  assert.equal(login.status(), 200);
  const foreignUser = (await login.json()).user;
  const beforeForeign = await (await foreign.request.get(origin + '/api/state')).json();
  const requestId = '22222222-2222-4222-8222-222222222222';
  for (const [suffix, body] of [
    [
      'prepare',
      {
        baseRevision: beforeForeign.revision,
        revision: 0,
        profileVersion: beforeOwner.profile.version,
        questions: [],
        consent: true,
        requestId,
      },
    ],
    ['prepare/cancel', { requestId }],
  ]) {
    const denied = await foreign.request.post(
      origin + '/api/applications/' + beforeOwner.opportunities[0].id + '/' + suffix,
      { headers: { Origin: origin, 'X-Rolemorrow-Account-ID': foreignUser.id }, data: body },
    );
    assert.equal(denied.status(), 404, await denied.text());
  }
  const ownerId = (await (await page.request.get(origin + '/api/account/me')).json()).user.id;
  const mismatch = await foreign.request.post(
    origin + '/api/applications/' + beforeOwner.opportunities[0].id + '/prepare',
    { headers: { Origin: origin, 'X-Rolemorrow-Account-ID': ownerId }, data: { requestId } },
  );
  assert.equal(mismatch.status(), 409);
  assert.deepEqual(await (await page.request.get(origin + '/api/state')).json(), beforeOwner);
  assert.deepEqual(await (await foreign.request.get(origin + '/api/state')).json(), beforeForeign);

  const auditBefore = await (await page.request.get(origin + '/api/audit')).json();
  assert.equal(auditBefore.available, true, 'public account audit must be available');
  for (const action of [
    'assessment',
    'recommendation',
    'opportunity-save',
    'packet-save',
    'notification-create',
    'notification-read',
    'dispatch-approval',
  ])
    assert.ok(
      auditBefore.events.some((e) => e.action === action),
      'missing typed action ' + action,
    );
  assert.ok(auditBefore.events.some((e) => e.action.startsWith('preparation:')));
  assert.ok(
    auditBefore.events.some((e) => e.status === 'simulated'),
    'fixture correspondence must not claim real employer event',
  );
  const ownId = beforeOwner.opportunities[0].id;
  await page.locator('[data-tab="audit"]').click();
  await page
    .locator('#audit-events')
    .getByText(/assessment/i)
    .first()
    .waitFor();
  const foreignLog = await foreign.request.get(origin + '/api/audit?opportunityId=' + ownId);
  assert.equal(foreignLog.status(), 404);
  await page.locator('#audit-agent').focus();
  assert.equal(
    await page.locator('#audit-agent').evaluate((el) => el === document.activeElement),
    true,
  );
  const evidenceDetails = page
    .locator('#audit-events details')
    .filter({ has: page.getByText('Input / decision snapshot', { exact: true }) })
    .first();
  await evidenceDetails.locator('summary').click();
  await evidenceDetails
    .getByText(/Built Python PostgreSQL|Lead|platform|Synthetic/)
    .first()
    .waitFor();
  await page.screenshot({ path: '/evidence/agent-audit-desktop.png', fullPage: false });
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#audit-export').click();
  const download = await downloadPromise;
  assert.match(download.suggestedFilename(), /\.jsonl$|\.ndjson$/);
  const data = await readFile(await download.path(), 'utf8');
  const records = data
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.ok(records.some((r) => JSON.stringify(r).includes('assessment')));
  await page.reload();
  await page.locator('[data-tab="audit"]').click();
  await page
    .locator('#audit-events')
    .getByText(/assessment/i)
    .first()
    .waitFor();
  assert.equal(
    (await (await page.request.get(origin + '/api/audit')).json()).events.length,
    auditBefore.events.length,
    'view/export/reload must not add business events',
  );
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: '/evidence/agent-audit-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.getByRole('button', { name: 'Applications', exact: true }).click();
  await page.screenshot({ path: '/evidence/agent-audit-application-mobile.png', fullPage: true });
  const allExport = JSON.stringify(records);
  const expectedFileHash = createHash('sha256')
    .update('Synthetic attachment content')
    .digest('hex');
  assert.ok(
    allExport.includes(expectedFileHash),
    'attachment evidence must hash actual file bytes',
  );
  let releaseOld, enteredOld;
  const staleGate = new Promise((r) => (releaseOld = r)),
    staleEntered = new Promise((r) => (enteredOld = r));
  const oldHandler = async (route) => {
    enteredOld();
    await staleGate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(auditBefore),
    });
  };
  await page.route('**/api/audit?*', oldHandler);
  await page.locator('[data-tab="audit"]').click();
  await staleEntered;
  await page.locator('#delete').click();
  await page.locator('#confirm-delete').click();
  await page.getByRole('status').filter({ hasText: 'Workspace cleared' }).waitFor();
  releaseOld();
  await page.waitForTimeout(100);
  assert.equal(
    await page.locator('#audit-events').textContent(),
    '',
    'old pending history must not resurrect cleared private data',
  );
  await page.unroute('**/api/audit?*', oldHandler);
  await page.locator('[data-tab="audit"]').click();
  await page.locator('#audit-empty').waitFor();
  assert.equal((await (await page.request.get(origin + '/api/audit')).json()).events.length, 0);
  assert.ok(!(await page.locator('#audit-view').textContent()).includes('Synthetic Platform Co'));
  await foreign.close();
  console.log(
    'AUDIT-WEB01 fullaudit+GEN2-WEB01 master profile -> generated evidence-based CV/cover/answers -> explicit save -> simulated dispatch/reply -> persistent notification PASS; fixture only; zero external sends',
  );
} finally {
  if (browser) await browser.close();
  if (server) await new Promise((r) => server.close(r));
  const cleanup = new pg.Client({ connectionString: process.env.RM_TEST_PG });
  await cleanup.connect();
  await cleanup.query('DROP SCHEMA IF EXISTS ' + namespace + ' CASCADE');
  await cleanup.end();
  await rm(directory, { recursive: true, force: true });
}
