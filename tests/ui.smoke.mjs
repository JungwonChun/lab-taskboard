import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { LOCAL_URL, ANON_KEY, uniq, cleanup, admin } from './helpers.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PORT = 5599;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

let server;
let browser;
let page;
const consoleErrors = [];
const createdUserIds = [];

function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      const urlPath = req.url.split('?')[0];
      if (urlPath === '/config.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' });
        res.end('// injected by test harness\n');
        return;
      }
      const rel = urlPath === '/' ? '/index.html' : urlPath;
      const filePath = path.join(ROOT, rel);
      if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      fs.readFile(filePath, (err, data) => {
        if (err) { res.writeHead(404); res.end('not found'); return; }
        const type = MIME[path.extname(filePath)] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': type });
        res.end(data);
      });
    });
    server.listen(PORT, '127.0.0.1', resolve);
  });
}

before(async () => {
  await startServer();
  browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu'],
  });
  page = await browser.newPage();
  await page.evaluateOnNewDocument((url, key) => {
    window.TASKBOARD_CONFIG = { SUPABASE_URL: url, SUPABASE_ANON_KEY: key };
  }, LOCAL_URL, ANON_KEY);
  page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`console.error: ${msg.text()}`);
  });
  page.on('requestfailed', (req) => {
    // config.js is intentionally served empty by us; a real network-level 404
    // for it is harmless and expected in some environments.
  });
});

after(async () => {
  if (page) await page.close().catch(() => {});
  if (browser) await browser.close().catch(() => {});
  if (server) await new Promise((r) => server.close(r));
  await cleanup(createdUserIds);
});

test('shows the auth card on first load', async () => {
  await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.auth', { timeout: 10000 });
  const hasAuth = await page.$('.auth');
  assert.ok(hasAuth, 'expected .auth card to be present');
});

const nameA = uniq('스모크A');

test('sign up user A shows their name in the top bar', async () => {
  await page.click('[data-action="auth-mode"][data-mode="signup"]');
  await page.waitForSelector('form[data-form="auth"][data-mode="signup"]', { timeout: 5000 });
  await page.type('form[data-form="auth"] input[name="name"]', nameA);
  await page.type('form[data-form="auth"] input[name="password"]', 'secret123');
  await Promise.all([
    page.waitForSelector('.topbar .me', { timeout: 15000 }),
    page.click('form[data-form="auth"] button.primary'),
  ]);
  const meText = await page.$eval('.topbar .me', (el) => el.textContent);
  assert.equal(meText, nameA);

  // record the created user id for cleanup
  const uid = await page.evaluate(async () => {
    const cfg = window.TASKBOARD_CONFIG;
    const client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    const { data } = await client.auth.getSession();
    return data.session?.user?.id ?? null;
  });
  if (uid) createdUserIds.push(uid);
});

const keyword = uniq('PULSE');
let jobTitle;

test('create a new job assigned to self with a new keyword, urgency 5, past deadline', async () => {
  jobTitle = uniq('작업');
  await page.click('[data-action="new-job"]');
  await page.waitForSelector('form[data-form="job"]', { timeout: 5000 });

  await page.type('form[data-form="job"] input[name="title"]', jobTitle);
  await page.type('form[data-form="job"] input[name="new_project"]', keyword);
  await page.click('form[data-form="job"] input[name="urgency"][value="5"]');

  // a deadline in the past (yesterday)
  const past = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  const localValue = `${past.getFullYear()}-${pad(past.getMonth() + 1)}-${pad(past.getDate())}T${pad(past.getHours())}:${pad(past.getMinutes())}`;
  await page.evaluate((val) => {
    document.querySelector('form[data-form="job"] input[name="deadline"]').value = val;
  }, localValue);

  // assignee defaults to self already (self-assignment allowed); confirm explicitly.
  await page.select('form[data-form="job"] select[name="assignee_id"]', await page.evaluate(() => {
    const sel = document.querySelector('form[data-form="job"] select[name="assignee_id"]');
    return sel.value;
  }));

  await Promise.all([
    page.waitForFunction(() => !document.getElementById('modal-root') || document.getElementById('modal-root').hidden, { timeout: 15000 }),
    page.click('form[data-form="job"] button.primary'),
  ]);

  await page.waitForSelector('.row .pos', { timeout: 15000 });
  const row = await page.waitForFunction((title) => {
    const rows = Array.from(document.querySelectorAll('.row'));
    return rows.find((r) => r.querySelector('.title')?.textContent === title) ? true : false;
  }, { timeout: 15000 }, jobTitle);
  assert.ok(row);

  const rowHandle = await page.evaluateHandle((title) => {
    return Array.from(document.querySelectorAll('.row')).find((r) => r.querySelector('.title')?.textContent === title);
  }, jobTitle);

  const pos = await rowHandle.evaluate((el) => el.querySelector('.pos').textContent.trim());
  assert.equal(pos, '1');
  const emoji = await rowHandle.evaluate((el) => el.querySelector('.emoji').textContent.trim());
  assert.equal(emoji, '🥵');
  const isOverdue = await rowHandle.evaluate((el) => el.classList.contains('overdue'));
  assert.ok(isOverdue, 'row should have the overdue class');
  const meta = await rowHandle.evaluate((el) => el.querySelector('.meta').textContent);
  assert.ok(meta.includes(`#${keyword}`), `expected meta to include #${keyword}, got: ${meta}`);
});

test('보낸 의뢰 tab lists the created job', async () => {
  await page.click('[data-action="view"][data-view="sent"]');
  await page.waitForFunction((title) => {
    const rows = Array.from(document.querySelectorAll('.row'));
    return rows.some((r) => r.querySelector('.title')?.textContent === title);
  }, { timeout: 10000 }, jobTitle);
  const found = await page.evaluate((title) => {
    return Array.from(document.querySelectorAll('.row')).some((r) => r.querySelector('.title')?.textContent === title);
  }, jobTitle);
  assert.ok(found, 'expected the sent job to be listed under 보낸 의뢰');
  // switch back to queue for later steps
  await page.click('[data-action="view"][data-view="queue"]');
  await page.waitForSelector('.rows', { timeout: 10000 });
});

test('project filter hides/shows the job by keyword', async () => {
  await page.select('select[data-action="project-filter"]', '00000000-0000-0000-0000-000000000000'); // 미분류
  await page.waitForFunction((title) => {
    return !Array.from(document.querySelectorAll('.row')).some((r) => r.querySelector('.title')?.textContent === title);
  }, { timeout: 10000 }, jobTitle);

  const keywordValue = await page.evaluate((kw) => {
    const opts = Array.from(document.querySelectorAll('select[data-action="project-filter"] option'));
    return opts.find((o) => o.textContent === kw)?.value;
  }, keyword);
  assert.ok(keywordValue, `expected a filter option for keyword ${keyword}`);

  await page.select('select[data-action="project-filter"]', keywordValue);
  await page.waitForFunction((title) => {
    return Array.from(document.querySelectorAll('.row')).some((r) => r.querySelector('.title')?.textContent === title);
  }, { timeout: 10000 }, jobTitle);
});

test('attach a file to the job and see the attachment count', async () => {
  // test 5 left the project filter on the custom keyword; reset to 'all' so a
  // new job in the default (미분류) project is actually visible in the queue.
  await page.select('select[data-action="project-filter"]', 'all');
  await page.waitForSelector('.rows', { timeout: 10000 });

  const tmpPath = path.join(os.tmpdir(), `smoke-attach-${Date.now()}.txt`);
  fs.writeFileSync(tmpPath, 'hello from the ui smoke test\n');

  await page.click('[data-action="new-job"]');
  await page.waitForSelector('form[data-form="job"]', { timeout: 5000 });
  const attachTitle = uniq('첨부작업');
  await page.type('form[data-form="job"] input[name="title"]', attachTitle);

  const fileInput = await page.$('form[data-form="job"] input[name="files"]');
  await fileInput.uploadFile(tmpPath);

  await Promise.all([
    page.waitForFunction(() => !document.getElementById('modal-root') || document.getElementById('modal-root').hidden, { timeout: 15000 }),
    page.click('form[data-form="job"] button.primary'),
  ]);

  await page.waitForFunction((title) => {
    const row = Array.from(document.querySelectorAll('.row')).find((r) => r.querySelector('.title')?.textContent === title);
    return row && row.querySelector('.meta')?.textContent.includes('📎 1');
  }, { timeout: 15000 }, attachTitle);

  const meta = await page.evaluate((title) => {
    const row = Array.from(document.querySelectorAll('.row')).find((r) => r.querySelector('.title')?.textContent === title);
    return row?.querySelector('.meta')?.textContent ?? '';
  }, attachTitle);
  assert.ok(meta.includes('📎 1'), `expected attachment count in meta, got: ${meta}`);

  fs.unlinkSync(tmpPath);
});

test('no unexpected console errors were captured', () => {
  const unexpected = consoleErrors.filter((e) => !/config\.js/i.test(e) && !/404/i.test(e));
  assert.deepEqual(unexpected, [], `unexpected console errors: ${JSON.stringify(unexpected, null, 2)}`);
});
