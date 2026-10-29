import assert from 'node:assert/strict';
import { setup, vacancy, message, state } from './import-fixtures.mjs';
import { chromium } from './browser.mjs';
const cleanups = [],
  h = await setup({
    after(fn) {
      cleanups.push(fn);
    },
  });
let browser;
try {
  const a = await h.account('import-browser@example.test');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies([
    {
      name: 'rm_session',
      value: a.cookie.slice('rm_session='.length),
      url: h.base,
      httpOnly: true,
      sameSite: 'Lax',
    },
  ]);
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const source = {
    sourceAccount: a.user.email,
    items: [
      vacancy(),
      message(a, {
        text: 'Original untrusted source <img src=x onerror="window.importAttack=true"> must remain text.',
      }),
    ],
  };
  const loaded = await page.goto(h.base + '/imports');
  assert.equal(loaded.status(), 200, 'The import journey must be a real authenticated web page');
  await page.locator('#import-file').setInputFiles({
    name: 'selected-ja-import.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(source)),
  });
  const before = await state(h, a);
  await page.locator('#import-preview').click();
  await page.locator('#import-items input[type=checkbox]').first().waitFor();
  assert.deepEqual(await state(h, a), before, 'Preview must not import durable account data');
  assert.equal(await page.locator('#import-items input[type=checkbox]').count(), 2);
  for (const check of await page.locator('#import-items input[type=checkbox]').all())
    await check.check();
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
      path: '/evidence/import-preview-' + viewport.width + '.png',
      fullPage: true,
    });
  }
  await page.locator('#import-commit').click();
  await page.waitForFunction(async () => {
    const s = await (await fetch('/api/state')).json();
    return s.messages.length === 1 && s.opportunities.length === 1;
  });
  const committed = await state(h, a);
  assert.equal(committed.mailDispatches.length, 0);
  assert.equal(committed.historicalAttempts.length, 1);
  assert.equal(await page.evaluate(() => window.importAttack), undefined);
  await page.reload();
  await page.locator('#import-file').setInputFiles({
    name: 'same-source-again.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(source, null, 2)),
  });
  await page.locator('#import-preview').click();
  await page
    .locator('#import-items')
    .getByText(/duplicate/i)
    .first()
    .waitFor();
  assert.deepEqual(await state(h, a), committed);
  assert.deepEqual(errors, []);
  console.log(
    'IMPORT-WEB01 PASS: file bundle -> read-only preview -> selected explicit commit -> canonical history; replay dedupe; desktop/mobile; escaped source; no sends.',
  );
} finally {
  await browser?.close();
  for (const fn of cleanups.reverse()) await fn();
}
