/** @type {(selector:string)=>any} */
const $ = (s) => document.querySelector(s),
  items = $('#import-items'),
  status = $('#import-status'),
  previewButton = $('#import-preview'),
  commitButton = $('#import-commit'),
  cancelButton = $('#import-cancel');
let account = null,
  batchId = null,
  previewHash = null,
  busy = false,
  cancelled = false,
  rows = [],
  selected = new Set();
/** @type {(tag:string,text?:string)=>any} */
const node = (tag, text) => {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  return el;
};
const say = (text, error = false) => {
  status.textContent = text;
  status.className = error ? 'warning' : 'help';
};
async function request(method, body) {
  const response = await fetch('/api/imports/' + method, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Rolemorrow-Account-ID': account.id },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok)
    throw Error(data.error ?? 'Import unavailable. Review the source and try again.');
  return data;
}
function controls() {
  previewButton.disabled = busy || !account || !$('#import-file').files.length;
  commitButton.disabled = busy || !previewHash || !selected.size;
  cancelButton.hidden = !batchId;
  cancelButton.disabled = !batchId;
}
function draw() {
  items.replaceChildren();
  for (const item of rows) {
    const row = node('article'),
      heading = node('h3', item.label ?? 'Imported source item'),
      detail = node(
        'p',
        (item.status ?? item.outcome ?? 'pending') + (item.reason ? ' · ' + item.reason : ''),
      );
    row.className = 'mail-message';
    row.append(heading, detail);
    if (item.status === 'ready' || item.status === 'duplicate') {
      const label = node('label'),
        box = node('input');
      box.type = 'checkbox';
      box.dataset.itemId = item.itemId;
      box.checked = selected.has(item.itemId);
      box.onchange = () => {
        if (box.checked) selected.add(item.itemId);
        else selected.delete(item.itemId);
        controls();
      };
      label.append(box, document.createTextNode(' Select this item'));
      row.append(label);
    }
    for (const file of item.files ?? item.attachments ?? []) {
      row.append(node('p', file.name + (file.sha256 ? ' · SHA256 ' + file.sha256 : '')));
    }
    items.append(row);
  }
  if (!rows.length) items.append(node('p', 'No source items staged.'));
  controls();
}
$('#import-file').onchange = () => controls();
previewButton.onclick = async () => {
  if (busy) return;
  busy = true;
  cancelled = false;
  selected.clear();
  previewHash = null;
  rows = [];
  draw();
  say('Reading selected source items…');
  try {
    const file = $('#import-file').files[0];
    if (!file || file.size > 8 * 1024 * 1024)
      throw Error('Choose a JSON export no larger than 8 MiB.');
    const bundle = JSON.parse(await file.text());
    if (
      !bundle ||
      Array.isArray(bundle) ||
      Object.keys(bundle).some((k) => !['sourceAccount', 'items'].includes(k)) ||
      !Array.isArray(bundle.items) ||
      !bundle.items.length ||
      bundle.items.length > 60
    )
      throw Error('Use an export containing sourceAccount and up to 60 selected items.');
    if (
      typeof bundle.sourceAccount !== 'string' ||
      bundle.sourceAccount.trim().toLowerCase() !== account.email.toLowerCase()
    )
      throw Error('The source account must match your verified destination email.');
    if (batchId) await request('cancel', { batchId });
    batchId = crypto.randomUUID();
    const records = [];
    for (const payload of bundle.items) {
      const bytes = new TextEncoder().encode(JSON.stringify(payload));
      const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) =>
        b.toString(16).padStart(2, '0'),
      ).join('');
      records.push({
        itemId: crypto.randomUUID(),
        payload,
        bytes,
        sha256: hash,
        chunks: Math.ceil(bytes.length / 49152),
      });
    }
    await request('begin', {
      batchId,
      sourceAccount: bundle.sourceAccount,
      items: records.map((r) => ({
        itemId: r.itemId,
        kind: r.payload.kind,
        bytes: r.bytes.length,
        sha256: r.sha256,
        chunks: r.chunks,
        ...(r.payload.kind === 'message' ? { subject: r.payload.subject } : {}),
      })),
    });
    controls();
    for (const record of records) {
      for (let index = 0; index < record.chunks; index++) {
        if (cancelled) throw Error('Staged import discarded.');
        const chunk = record.bytes.subarray(index * 49152, (index + 1) * 49152);
        let binary = '';
        for (const byte of chunk) binary += String.fromCharCode(byte);
        await request('chunk', { batchId, itemId: record.itemId, index, data: btoa(binary) });
      }
    }
    let offset = 0,
      total = 1;
    while (offset < total) {
      if (cancelled) throw Error('Staged import discarded.');
      const page = await request('preview', { batchId, offset, limit: 20 });
      if (previewHash && previewHash !== page.previewHash)
        throw Error('The preview changed. Discard it and preview again.');
      previewHash = page.previewHash;
      rows.push(...page.items);
      total = page.total;
      offset += page.items.length;
      if (!page.items.length) break;
    }
    draw();
    say('Preview ready. Select the exact items to import. Nothing has been saved.');
  } catch (error) {
    say(error.message, true);
  } finally {
    busy = false;
    controls();
  }
};
commitButton.onclick = async () => {
  if (busy || !selected.size) return;
  busy = true;
  controls();
  say('Importing the selected items…');
  try {
    const result = await request('commit', { batchId, previewHash, itemIds: [...selected] });
    rows = result.items ?? [];
    selected.clear();
    previewHash = null;
    draw();
    const committed = rows.filter((x) => x.status === 'committed').length;
    const duplicates = rows.filter((x) => x.status === 'duplicate').length;
    say(
      committed +
        ' items imported; ' +
        duplicates +
        ' already present. Review individual outcomes below. Unselected items were not committed.',
    );
  } catch (error) {
    say(error.message + ' Open batch progress before retrying.', true);
  } finally {
    busy = false;
    controls();
  }
};
cancelButton.onclick = async () => {
  cancelled = true;
  try {
    await request('cancel', { batchId });
    batchId = null;
    previewHash = null;
    rows = [];
    selected.clear();
    draw();
    say('Staged content discarded. Previously committed items remain in your workspace.');
  } catch (error) {
    say(error.message, true);
  }
};
try {
  const response = await fetch('/api/account/me', {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) throw Error('Sign in to your verified account before importing.');
  account = (await response.json()).user;
  $('#import-account').textContent = 'Destination: ' + account.email;
  const progressParams = new URL(location.href).searchParams;
  const progressId = progressParams.get('batch') ?? progressParams.get('batchId');
  if (progressId) {
    const progress = await request('progress', { batchId: progressId });
    batchId = progressId;
    rows = progress.items ?? progress.receipts ?? [];
    draw();
    say('Saved batch progress. A discarded or expired preview cannot commit remaining items.');
  }
  controls();
} catch (error) {
  say(error.message, true);
  const link = node('a', 'Sign in');
  link.href = '/account';
  status.after(link);
}
