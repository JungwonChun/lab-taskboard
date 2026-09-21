// These tests are sequential and order-dependent: later tests reuse users,
// jobs, and browser pages/state created by earlier ones (nameA, aUserId,
// bUserId, job titles, admin promotion, etc). Always run the whole file —
// `npm run test:ui` — never a single test in isolation with node --test's
// name/only filters.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { LOCAL_URL, ANON_KEY, uniq, cleanup, admin, newUser, promote } from './helpers.mjs';

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
let contextB;
let pageB;
let aUserId;
let attachTitleGlobal;
const consoleErrors = [];
const createdUserIds = [];

function findRow(title) {
  return Array.from(document.querySelectorAll('.row')).find((r) => r.querySelector('.title')?.textContent === title);
}
function hasRow(title) {
  return Array.from(document.querySelectorAll('.row')).some((r) => r.querySelector('.title')?.textContent === title);
}

// Reload is safe now (see src/api.js onAuthChange: the auth-state callback
// is deferred with setTimeout so it never runs while supabase-js still
// holds its session-recovery lock). Used wherever it's the simplest way to
// get a guaranteed-fresh view of server state, instead of waiting on
// realtime timing.
async function reloadAndWaitReady(pageX) {
  await pageX.reload({ waitUntil: 'networkidle0', timeout: 15000 });
  await pageX.waitForSelector('.topbar .me', { timeout: 15000 });
}

// Every mutation in this app causes *two* re-renders of anything currently
// open: the delegated listener's own post-mutation `refresh(); renderAll();`,
// and — shortly after, indeterminately — the realtime subscription noticing
// the very same row change and doing the same thing again. Puppeteer's
// ordinary `.click()` spans several CDP round trips (locate element, scroll
// into view, read its bounding box, dispatch mouse down/up), which leaves a
// real window for a stray re-render to swap the target out from under it
// mid-click. Re-querying the DOM and dispatching a real `.click()` inside a
// single evaluate() call closes that window: it can't observe a
// half-replaced tree because renders are synchronous (one `innerHTML =`
// assignment), so whatever's found is either the old element or the new one,
// never a detached reference to either.
async function clickAction(pageX, selector, { timeout = 10000 } = {}) {
  await pageX.waitForSelector(selector, { timeout });
  const clicked = await pageX.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    // .focus() before .click(): a real mouse click blurs whatever field
    // was previously focused as part of the browser's own focusing steps,
    // but a script-dispatched .click() does not — so a submit button
    // clicked this way left an earlier textarea as document.activeElement,
    // and modalHasDraft() reads any focused textarea/input/select as an
    // unsaved draft, permanently blocking the post-submit re-render.
    el.focus();
    el.click();
    return true;
  }, selector);
  assert.ok(clicked, `expected to find and click ${selector}`);
}

// Same idea as clickAction, for a <select> whose change listener is
// delegated the same way — set .value and dispatch 'change' inside one
// evaluate() call so a re-render between query and interaction can't leave
// us holding a detached node.
async function selectAction(pageX, selector, value, { timeout = 10000 } = {}) {
  await pageX.waitForSelector(selector, { timeout });
  const ok = await pageX.evaluate((sel, val) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.value = val;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, selector, value);
  assert.ok(ok, `expected to find and select ${value} on ${selector}`);
}

// Same idea as clickAction, for a row identified by its title text rather
// than a stable selector.
async function clickRow(pageX, title) {
  await pageX.waitForFunction(hasRow, { timeout: 15000 }, title);
  const clicked = await pageX.evaluate((t) => {
    const row = Array.from(document.querySelectorAll('.row')).find((r) => r.querySelector('.title')?.textContent === t);
    if (!row) return false;
    row.click();
    return true;
  }, title);
  assert.ok(clicked, `expected to find and click a row titled ${title}`);
}

// A condition wait, not a blind sleep: waits for network activity to settle
// rather than a fixed delay. Used at the few points where a test keeps
// interacting with the *same already-open* modal right after a mutation —
// the mutation's own post-success refresh() and the (separately arriving)
// realtime echo of that same change both fire a REST round trip, and if the
// next step's DOM check/write lands in between, it can see a form the
// second, delayed re-render is about to reset (e.g. wiping the inline
// 완료/반려 form it had just injected). Reloading or opening a fresh job
// (openAsB, createJobForB) already starts from a clean slate and doesn't
// need this.
async function waitForQuiet(pageX) {
  await pageX.waitForNetworkIdle({ idleTime: 300, timeout: 5000 }).catch(() => {});
}

async function closeModalIfOpen(pageX) {
  if (await pageX.$('.modal')) {
    await clickAction(pageX, '[data-action="close-modal"]');
    await pageX.waitForFunction(() => !document.querySelector('.modal'), { timeout: 5000 }).catch(() => {});
  }
}

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
  if (pageB) await pageB.close().catch(() => {});
  if (contextB) await contextB.close().catch(() => {});
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
  await page.waitForSelector('form[data-form="auth"]', { timeout: 5000 });
  await page.type('form[data-form="auth"] input[name="name"]', nameA);
  await Promise.all([
    page.waitForSelector('.topbar .me', { timeout: 15000 }),
    clickAction(page, 'form[data-form="auth"] button.primary'),
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
  aUserId = uid;
});

test('reload while logged in still shows the queue', async () => {
  // Regression test for the reload deadlock: onAuthStateChange's callback
  // used to run synchronously while supabase-js still held its
  // session-recovery lock, so a reload's loadAll() never issued a single
  // REST request and the app hung on a blank screen forever. Fixed by
  // deferring the callback with setTimeout (src/api.js onAuthChange).
  await page.reload({ waitUntil: 'networkidle0', timeout: 15000 });
  await page.waitForSelector('.topbar .me', { timeout: 15000 });
  const meText = await page.$eval('.topbar .me', (el) => el.textContent);
  assert.equal(meText, nameA);
  await page.waitForSelector('.rows', { timeout: 15000 });
});

const keyword = uniq('PULSE');
let jobTitle;

test('create a new job assigned to self with a new keyword, urgency 5, past deadline', async () => {
  jobTitle = uniq('작업');
  await clickAction(page, '[data-action="new-job"]');
  await page.waitForSelector('form[data-form="job"]', { timeout: 5000 });

  await page.type('form[data-form="job"] input[name="title"]', jobTitle);
  await page.type('form[data-form="job"] input[name="new_project"]', keyword);
  await clickAction(page, 'form[data-form="job"] input[name="urgency"][value="5"]');

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
    clickAction(page, 'form[data-form="job"] button.primary'),
  ]);

  await page.waitForSelector('.row .pos', { timeout: 15000 });
  const row = await page.waitForFunction((title) => {
    const rows = Array.from(document.querySelectorAll('.row'));
    return rows.find((r) => r.querySelector('.title')?.textContent === title) ? true : false;
  }, { timeout: 15000 }, jobTitle);
  assert.ok(row);

  const rowInfo = await page.evaluate((title) => {
    const row = Array.from(document.querySelectorAll('.row')).find((r) => r.querySelector('.title')?.textContent === title);
    if (!row) return null;
    return {
      pos: row.querySelector('.pos').textContent.trim(),
      emoji: row.querySelector('.emoji').textContent.trim(),
      isOverdue: row.classList.contains('overdue'),
      meta: row.querySelector('.meta').textContent,
    };
  }, jobTitle);
  assert.ok(rowInfo, `expected to find a row titled ${jobTitle}`);
  assert.equal(rowInfo.pos, '1');
  assert.equal(rowInfo.emoji, '🥵');
  assert.ok(rowInfo.isOverdue, 'row should have the overdue class');
  assert.ok(rowInfo.meta.includes(`#${keyword}`), `expected meta to include #${keyword}, got: ${rowInfo.meta}`);
});

test('보낸 의뢰 tab lists the created job', async () => {
  await clickAction(page, '[data-action="view"][data-view="sent"]');
  await page.waitForFunction((title) => {
    const rows = Array.from(document.querySelectorAll('.row'));
    return rows.some((r) => r.querySelector('.title')?.textContent === title);
  }, { timeout: 10000 }, jobTitle);
  const found = await page.evaluate((title) => {
    return Array.from(document.querySelectorAll('.row')).some((r) => r.querySelector('.title')?.textContent === title);
  }, jobTitle);
  assert.ok(found, 'expected the sent job to be listed under 보낸 의뢰');
  // switch back to queue for later steps
  await clickAction(page, '[data-action="view"][data-view="queue"]');
  await page.waitForSelector('.rows', { timeout: 10000 });
});

test('project filter hides/shows the job by keyword', async () => {
  await selectAction(page, 'select[data-action="project-filter"]', '00000000-0000-0000-0000-000000000000'); // 미분류
  await page.waitForFunction((title) => {
    return !Array.from(document.querySelectorAll('.row')).some((r) => r.querySelector('.title')?.textContent === title);
  }, { timeout: 10000 }, jobTitle);

  const keywordValue = await page.evaluate((kw) => {
    const opts = Array.from(document.querySelectorAll('select[data-action="project-filter"] option'));
    return opts.find((o) => o.textContent === kw)?.value;
  }, keyword);
  assert.ok(keywordValue, `expected a filter option for keyword ${keyword}`);

  await selectAction(page, 'select[data-action="project-filter"]', keywordValue);
  await page.waitForFunction((title) => {
    return Array.from(document.querySelectorAll('.row')).some((r) => r.querySelector('.title')?.textContent === title);
  }, { timeout: 10000 }, jobTitle);
});

test('attach a file to the job and see the attachment count', async () => {
  // test 5 left the project filter on the custom keyword; reset to 'all' so a
  // new job in the default (미분류) project is actually visible in the queue.
  await selectAction(page, 'select[data-action="project-filter"]', 'all');
  await page.waitForSelector('.rows', { timeout: 10000 });

  const tmpPath = path.join(os.tmpdir(), `smoke-attach-${Date.now()}.txt`);
  fs.writeFileSync(tmpPath, 'hello from the ui smoke test\n');

  await clickAction(page, '[data-action="new-job"]');
  await page.waitForSelector('form[data-form="job"]', { timeout: 5000 });
  const attachTitle = uniq('첨부작업');
  attachTitleGlobal = attachTitle;
  await page.type('form[data-form="job"] input[name="title"]', attachTitle);

  const fileInput = await page.$('form[data-form="job"] input[name="files"]');
  await fileInput.uploadFile(tmpPath);

  await Promise.all([
    page.waitForFunction(() => !document.getElementById('modal-root') || document.getElementById('modal-root').hidden, { timeout: 15000 }),
    clickAction(page, 'form[data-form="job"] button.primary'),
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

// ───────────────────────── Task 6: job detail modal ─────────────────────────
// A second user (B) is signed up in its own browser context so the two act as
// independent clients sharing the same local Supabase backend, the way a
// requester and an assignee would in two separate browsers.

const nameB = uniq('스모크B');
let bUserId;

test('sign up user B in a separate browser context', async () => {
  contextB = await browser.createBrowserContext();
  pageB = await contextB.newPage();
  await pageB.evaluateOnNewDocument((url, key) => {
    window.TASKBOARD_CONFIG = { SUPABASE_URL: url, SUPABASE_ANON_KEY: key };
  }, LOCAL_URL, ANON_KEY);
  pageB.on('pageerror', (err) => consoleErrors.push(`B pageerror: ${err.message}`));
  pageB.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(`B console.error: ${msg.text()}`);
  });

  await pageB.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await pageB.waitForSelector('.auth', { timeout: 10000 });
  await pageB.waitForSelector('form[data-form="auth"]', { timeout: 5000 });
  await pageB.type('form[data-form="auth"] input[name="name"]', nameB);
  await Promise.all([
    pageB.waitForSelector('.topbar .me', { timeout: 15000 }),
    clickAction(pageB, 'form[data-form="auth"] button.primary'),
  ]);
  const meText = await pageB.$eval('.topbar .me', (el) => el.textContent);
  assert.equal(meText, nameB);

  bUserId = await pageB.evaluate(async () => {
    const cfg = window.TASKBOARD_CONFIG;
    const client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
    const { data } = await client.auth.getSession();
    return data.session?.user?.id ?? null;
  });
  if (bUserId) createdUserIds.push(bUserId);

  // A's page needs B's profile row (for the assignee <select>) before it can
  // create a job for B. Reload is simple and reliable now (see the
  // onAuthChange fix in src/api.js).
  await reloadAndWaitReady(page);
  await page.waitForFunction(
    (uid) => !!document.querySelector(`select[data-action="assignee"] option[value="${uid}"]`),
    { timeout: 15000 }, bUserId,
  );
});

async function createJobForB(title) {
  await closeModalIfOpen(page);
  await clickAction(page, '[data-action="new-job"]');
  await page.waitForSelector('form[data-form="job"]', { timeout: 5000 });
  await page.type('form[data-form="job"] input[name="title"]', title);
  await page.select('form[data-form="job"] select[name="assignee_id"]', bUserId);
  await Promise.all([
    page.waitForFunction(() => !document.getElementById('modal-root') || document.getElementById('modal-root').hidden, { timeout: 15000 }),
    clickAction(page, 'form[data-form="job"] button.primary'),
  ]);
  await waitForQuiet(page);
}

// Reload B's page for a guaranteed-fresh queue (rather than waiting on
// realtime timing), then open the named job.
async function openAsB(title) {
  await reloadAndWaitReady(pageB);
  await clickRow(pageB, title);
  await pageB.waitForSelector('.modal', { timeout: 5000 });
}

let job1Title;

test('A creates a job for B; B opens it, sees queue position 1, and starts it', async () => {
  job1Title = uniq('작업1');
  await createJobForB(job1Title);
  await openAsB(job1Title);

  const hasQueueHint = await pageB.evaluate(() =>
    Array.from(document.querySelectorAll('.modal .hint')).some((el) => el.textContent.includes('큐 1번째')));
  assert.ok(hasQueueHint, 'expected the 큐 1번째 queue-position hint in the detail modal');
  const startBtn = await pageB.$('[data-action="job-start"]');
  assert.ok(startBtn, 'expected a 진행중으로 button for the assignee on a waiting job');

  await clickAction(pageB, '[data-action="job-start"]');
  await pageB.waitForFunction(() => document.querySelector('.modal .badge')?.textContent === '진행중', { timeout: 10000 });
  const hasStart = await pageB.evaluate(() => document.querySelector('.modal').textContent.includes('시작'));
  assert.ok(hasStart, 'expected a 시작 (started) timestamp once in_progress');
  await waitForQuiet(pageB);
});

test('B finishes the job with a memo; badge, memo box, and result upload appear', async () => {
  await clickAction(pageB, '[data-action="job-done"]');
  await pageB.waitForSelector('#inline-form form[data-form="done"] textarea[name="result_note"]', { timeout: 5000 });
  const memo = uniq('완료메모');
  await pageB.type('#inline-form textarea[name="result_note"]', memo);
  await clickAction(pageB, '#inline-form button.primary');
  await pageB.waitForFunction(() => document.querySelector('.modal .badge')?.textContent === '완료', { timeout: 10000 });

  const bodyText = await pageB.$eval('.modal', (el) => el.textContent);
  assert.ok(bodyText.includes(memo), 'expected the completion memo to be shown');
  const resultInput = await pageB.$('input[type="file"][data-action="att-upload"][data-kind="result"]');
  assert.ok(resultInput, 'expected a result-attachment file input on a done job (assignee can still attach results)');
});

let job2Title;

test('second job: B\'s empty reject reason is blocked, then a real reason rejects it', async () => {
  job2Title = uniq('작업2');
  await createJobForB(job2Title);
  await openAsB(job2Title);

  await clickAction(pageB, '[data-action="job-reject"]');
  await pageB.waitForSelector('#inline-form form[data-form="reject"] textarea[name="reject_reason"]', { timeout: 5000 });
  await clickAction(pageB, '#inline-form button.danger');
  // blocked by the textarea's `required` attribute: no navigation, form still there
  const stillOpen = await pageB.$('#inline-form form[data-form="reject"]');
  assert.ok(stillOpen, 'expected the reject form to remain open when the reason is empty');
  const badgeStill = await pageB.$eval('.modal .badge', (el) => el.textContent);
  assert.equal(badgeStill, '대기', 'status should not have changed while the reason was empty');

  const reason = uniq('반려사유');
  await pageB.type('#inline-form textarea[name="reject_reason"]', reason);
  await clickAction(pageB, '#inline-form button.danger');
  await pageB.waitForFunction(() => document.querySelector('.modal .badge')?.textContent === '반려', { timeout: 10000 });
  const bodyText = await pageB.$eval('.modal', (el) => el.textContent);
  assert.ok(bodyText.includes(reason), 'expected the reject reason to be shown in the red box');
});

let job3Title;

test('third job: B hands off to A; it lands at the end of A\'s queue and leaves B\'s', async () => {
  job3Title = uniq('작업3');
  await createJobForB(job3Title);
  await openAsB(job3Title);

  await clickAction(pageB, '[data-action="job-handoff"]');
  await pageB.waitForSelector('#inline-form form[data-form="handoff"] select[name="assignee_id"]', { timeout: 5000 });
  await pageB.select('#inline-form select[name="assignee_id"]', aUserId);
  await clickAction(pageB, '#inline-form button.primary');
  await pageB.waitForFunction(() => document.querySelector('.modal .badge')?.textContent === '대기', { timeout: 10000 });

  // B's queue no longer lists it (assignee changed away from B) — reload
  // for a guaranteed-fresh check rather than trusting whatever's cached.
  await reloadAndWaitReady(pageB);
  const stillInB = await pageB.evaluate(hasRow, job3Title);
  assert.equal(stillInB, false, 'expected job3 to have left B\'s open queue after handoff');

  // it shows up at the end of A's open queue, after the pre-existing jobs
  await reloadAndWaitReady(page);
  await page.waitForFunction(hasRow, { timeout: 15000 }, job3Title);
  const order = await page.evaluate((titles) => {
    // the open queue is the first ".rows" block (the "past" one lives inside <details>)
    const rowTitles = Array.from(document.querySelector('.rows').querySelectorAll('.row .title')).map((el) => el.textContent);
    return titles.map((t) => rowTitles.indexOf(t));
  }, [jobTitle, attachTitleGlobal, job3Title]);
  assert.ok(order[2] > order[0] && order[2] > order[1], `expected job3 after A's pre-existing open jobs, got indices ${JSON.stringify(order)}`);
  const badge = await page.evaluate((title) => {
    const row = Array.from(document.querySelectorAll('.row')).find((r) => r.querySelector('.title')?.textContent === title);
    return row?.querySelector('.badge')?.textContent;
  }, job3Title);
  assert.equal(badge, '대기');
});

test('A edits job3\'s title, then cancels it', async () => {
  await clickRow(page, job3Title);
  await page.waitForSelector('.modal', { timeout: 5000 });

  const editBtn = await page.$('[data-action="job-edit"]');
  assert.ok(editBtn, 'expected a 수정 button for the requester on a waiting job');

  await clickAction(page, '[data-action="job-edit"]');
  await page.waitForSelector('form[data-form="job"]', { timeout: 5000 });
  const newTitle = uniq('수정된작업3');
  await page.evaluate(() => { document.querySelector('form[data-form="job"] input[name="title"]').value = ''; });
  await page.type('form[data-form="job"] input[name="title"]', newTitle);
  await Promise.all([
    page.waitForFunction((title) => document.querySelector('.modal h3')?.textContent.includes(title), { timeout: 15000 }, newTitle),
    clickAction(page, 'form[data-form="job"] button.primary'),
  ]);
  job3Title = newTitle;
  await waitForQuiet(page);

  await page.evaluate(() => { window.confirm = () => true; });
  await clickAction(page, '[data-action="job-cancel"]');
  await page.waitForFunction(() => document.querySelector('.modal .badge')?.textContent === '취소', { timeout: 10000 });
});

let job7Title, job8Title;

test('editing survives a background list update triggered by another job (editingJobId protects the modal)', async () => {
  job7Title = uniq('작업7');
  job8Title = uniq('작업8');
  await closeModalIfOpen(page);
  await createJobForB(job7Title);
  await createJobForB(job8Title);

  // A opens job7 (as requester) and starts editing it, changing only urgency
  await clickAction(page, '[data-action="view"][data-view="sent"]');
  await clickRow(page, job7Title);
  await page.waitForSelector('.modal', { timeout: 5000 });
  await clickAction(page, '[data-action="job-edit"]');
  await page.waitForSelector('form[data-form="job"]', { timeout: 5000 });
  await clickAction(page, 'form[data-form="job"] input[name="urgency"][value="5"]');

  // B starts job8 — a different job — from her own page. The resulting
  // 'jobs' table change still reaches A's long-lived realtime subscription
  // and triggers a background renderAll() while A's edit form is open.
  await openAsB(job8Title);
  await clickAction(pageB, '[data-action="job-start"]');
  await pageB.waitForFunction(() => document.querySelector('.modal .badge')?.textContent === '진행중', { timeout: 10000 });

  // A's row list (behind the still-open edit form) picks up job8's new
  // status live — proving the background re-render actually ran...
  await page.waitForFunction((title) => {
    const row = Array.from(document.querySelectorAll('.row')).find((r) => r.querySelector('.title')?.textContent === title);
    return row?.querySelector('.badge')?.textContent === '진행중';
  }, { timeout: 15000 }, job8Title);

  // ...while A's edit form — a completely different modal — was left alone.
  const stillEditing = await page.evaluate(() => ({
    formPresent: !!document.querySelector('form[data-form="job"]'),
    urgency: document.querySelector('form[data-form="job"] input[name="urgency"]:checked')?.value,
  }));
  assert.ok(stillEditing.formPresent, 'expected the edit form to still be open');
  assert.equal(stillEditing.urgency, '5', 'expected the changed urgency radio to still be selected');

  // A saves; the (unchanged) title and the new urgency both persist
  await Promise.all([
    page.waitForFunction((title) => document.querySelector('.modal h3')?.textContent.includes(title), { timeout: 15000 }, job7Title),
    clickAction(page, 'form[data-form="job"] button.primary'),
  ]);
  const h3Text = await page.$eval('.modal h3', (el) => el.textContent);
  assert.ok(h3Text.includes(job7Title), 'expected the unchanged title to persist');
  assert.ok(h3Text.includes('🥵'), 'expected the urgency-5 emoji to show after saving');
});

let job5Title;

test('comments: A posts one, B sees it live, only the author can delete', async () => {
  // a fresh, still-open job (rather than reusing a done job, which sits
  // inside a collapsed <details> whose `open` state a background re-render
  // would reset)
  job5Title = uniq('작업5');
  await closeModalIfOpen(page);
  await createJobForB(job5Title);

  await clickAction(page, '[data-action="view"][data-view="sent"]');
  await clickRow(page, job5Title);
  await page.waitForSelector('.modal', { timeout: 5000 });

  const commentText = uniq('댓글A');
  await page.type('form[data-form="comment"] textarea[name="body"]', commentText);
  await clickAction(page, 'form[data-form="comment"] button.primary');
  await page.waitForFunction((text) =>
    Array.from(document.querySelectorAll('.comments li .text')).some((el) => el.textContent === text), { timeout: 10000 }, commentText);
  const who = await page.evaluate((text) => {
    const li = Array.from(document.querySelectorAll('.comments li')).find((li) => li.querySelector('.text')?.textContent === text);
    return li?.querySelector('.who')?.textContent;
  }, commentText);
  assert.equal(who, nameA);

  // B sees the same comment — reload for a guaranteed-fresh view.
  await reloadAndWaitReady(pageB);
  await clickRow(pageB, job5Title);
  await pageB.waitForSelector('.modal', { timeout: 5000 });
  await pageB.waitForFunction((text) =>
    Array.from(document.querySelectorAll('.comments li .text')).some((el) => el.textContent === text), { timeout: 10000 }, commentText);
  const delBtnOnB = await pageB.$('.comments li button[data-action="comment-delete"]');
  assert.equal(delBtnOnB, null, 'B should not see a delete button on A\'s own comment');

  // A deletes her own comment
  await clickAction(page, '.comments li button[data-action="comment-delete"]');
  await page.waitForFunction((text) =>
    !Array.from(document.querySelectorAll('.comments li .text')).some((el) => el.textContent === text), { timeout: 10000 }, commentText);
});

test('uploads a result attachment from the detail modal, then deletes it', async () => {
  const jobXTitle = uniq('작업X');
  await closeModalIfOpen(page);
  await createJobForB(jobXTitle);
  await openAsB(jobXTitle);

  const tmpPath = path.join(os.tmpdir(), `smoke-result-${Date.now()}.txt`);
  fs.writeFileSync(tmpPath, 'result file contents\n');

  const fileInput = await pageB.$('input[type="file"][data-action="att-upload"][data-kind="result"]');
  assert.ok(fileInput, 'expected a result-attachment file input (B is the assignee)');
  await fileInput.uploadFile(tmpPath);
  // app.js's att-upload handler now refreshes and reopens the job itself so
  // the newly uploaded file shows as a real (signed-URL) link without any
  // manual close/reopen here — regression test for the attUrls-staleness fix.
  await pageB.waitForFunction(() => !!document.querySelector('.files a'), { timeout: 15000 });
  const fileHref = await pageB.$eval('.files a', (el) => el.getAttribute('href'));
  assert.ok(fileHref, 'expected the uploaded result attachment to show as a link without reopening the modal');

  await pageB.evaluate(() => { window.confirm = () => true; });
  await clickAction(pageB, '.files button[data-action="att-delete"]');
  await pageB.waitForFunction(() => !document.querySelector('.files a'), { timeout: 10000 });

  fs.unlinkSync(tmpPath);
});

test('draft preservation: A\'s unsent comment survives a background re-render from B\'s change', async () => {
  const job4Title = uniq('작업4');
  await closeModalIfOpen(page);
  await clickAction(page, '[data-action="view"][data-view="queue"]');
  await createJobForB(job4Title);

  // A opens it as requester (in 보낸 의뢰) and starts typing a comment, without submitting
  await clickAction(page, '[data-action="view"][data-view="sent"]');
  await clickRow(page, job4Title);
  await page.waitForSelector('.modal', { timeout: 5000 });

  // B opens the same job in the other browser context
  await openAsB(job4Title);

  const draftText = uniq('초안');
  await page.type('form[data-form="comment"] textarea[name="body"]', draftText);

  // B changes the status while A's textarea has unsent text
  await clickAction(pageB, '[data-action="job-start"]');
  await pageB.waitForFunction(() => document.querySelector('.modal .badge')?.textContent === '진행중', { timeout: 10000 });

  // There's no positive DOM signal for "a background re-render was
  // attempted and correctly suppressed" — the point of this assertion is
  // that nothing visibly changes. This bounded wait just gives A's realtime
  // subscription (api.subscribe → refresh(); renderAll()) a realistic
  // window to have fired at least once before we check the draft survived.
  await new Promise((r) => setTimeout(r, 1500));
  const stillDraft = await page.$eval('form[data-form="comment"] textarea[name="body"]', (el) => el.value);
  assert.equal(stillDraft, draftText, 'expected the in-progress comment draft to survive a background re-render');

  await clickAction(page, 'form[data-form="comment"] button.primary');
  await page.waitForFunction(() => document.querySelector('.modal .badge')?.textContent === '진행중', { timeout: 10000 });
  const bodyText = await page.$eval('.modal', (el) => el.textContent);
  assert.ok(bodyText.includes(draftText), 'expected the submitted draft comment to now be visible, alongside the status B set');
});

// ───────────────────────── Task 7: keyword management + admin panel ─────────────────────────

function findManageListItem(nameWithHash) {
  return Array.from(document.querySelectorAll('.list-manage li')).find((li) => li.querySelector('.name')?.textContent.includes(nameWithHash));
}

test('keyword modal: add K1, rename to K2, delete it, and its job falls back to 미분류', async () => {
  await closeModalIfOpen(page);
  await clickAction(page, '[data-action="view"][data-view="queue"]');
  await selectAction(page, 'select[data-action="project-filter"]', 'all');

  const k1 = uniq('K1');
  const k2 = uniq('K2');

  await clickAction(page, '[data-action="manage-projects"]');
  await page.waitForSelector('form[data-form="project-add"]', { timeout: 5000 });
  await page.type('form[data-form="project-add"] input[name="name"]', k1);
  await clickAction(page, 'form[data-form="project-add"] button.primary');
  // 15s, matching every other post-mutation wait in this suite (see e.g. the
  // job-creation waits above): this round-trips through the server (insert
  // + refresh() + re-render, or the realtime echo of the same), same class
  // of wait as those, so it gets the same budget rather than the tighter
  // 10s a first draft of this test used, which one CI run exceeded under load.
  await page.waitForFunction((k) => Array.from(document.querySelectorAll('.list-manage li')).some((li) => li.querySelector('.name')?.textContent.includes('#' + k)), { timeout: 15000 }, k1);

  // window.prompt is synchronous and blocking in a real browser; stub it to
  // hand back the new name instead, the way the app's own prompt() call for
  // project-rename expects.
  await page.evaluate((newName) => { window.prompt = () => newName; }, k2);
  await clickAction(page, `.list-manage li button[data-action="project-rename"][data-name="${k1}"]`);
  await page.waitForFunction((k) => Array.from(document.querySelectorAll('.list-manage li')).some((li) => li.querySelector('.name')?.textContent.includes('#' + k)), { timeout: 15000 }, k2);
  const stillHasK1 = await page.evaluate((k) => Array.from(document.querySelectorAll('.list-manage li')).some((li) => li.querySelector('.name')?.textContent.includes('#' + k)), k1);
  assert.equal(stillHasK1, false, 'expected the old K1 name to be gone after rename');

  // the locked 미분류 row shows "고정" and no action buttons
  const uncategorized = await page.evaluate(() => {
    const li = Array.from(document.querySelectorAll('.list-manage li')).find((li) => li.querySelector('.name')?.textContent.includes('#미분류'));
    if (!li) return null;
    return { hasFixedHint: li.textContent.includes('고정'), hasButtons: !!li.querySelector('button') };
  });
  assert.ok(uncategorized, 'expected a #미분류 row in the keyword modal');
  assert.ok(uncategorized.hasFixedHint, 'expected 고정 hint on the 미분류 row');
  assert.equal(uncategorized.hasButtons, false, 'expected no buttons on the 미분류 row');

  await closeModalIfOpen(page);

  // create a job under K2
  const k2JobTitle = uniq('K2작업');
  await clickAction(page, '[data-action="new-job"]');
  await page.waitForSelector('form[data-form="job"]', { timeout: 5000 });
  await page.type('form[data-form="job"] input[name="title"]', k2JobTitle);
  const k2Value = await page.evaluate((k) => {
    const opts = Array.from(document.querySelectorAll('form[data-form="job"] select[name="project_id"] option'));
    return opts.find((o) => o.textContent === '#' + k || o.textContent === k)?.value;
  }, k2);
  assert.ok(k2Value, `expected a project_id option for #${k2}`);
  await selectAction(page, 'form[data-form="job"] select[name="project_id"]', k2Value);
  await Promise.all([
    page.waitForFunction(() => !document.getElementById('modal-root') || document.getElementById('modal-root').hidden, { timeout: 15000 }),
    clickAction(page, 'form[data-form="job"] button.primary'),
  ]);
  await page.waitForFunction((title) => Array.from(document.querySelectorAll('.row')).some((r) => r.querySelector('.title')?.textContent === title), { timeout: 15000 }, k2JobTitle);

  // delete K2 (confirm -> true)
  await page.evaluate(() => { window.confirm = () => true; });
  await clickAction(page, '[data-action="manage-projects"]');
  await page.waitForSelector('form[data-form="project-add"]', { timeout: 5000 });
  await clickAction(page, `.list-manage li button[data-action="project-delete"][data-name="${k2}"]`);
  await page.waitForFunction((k) => !Array.from(document.querySelectorAll('.list-manage li')).some((li) => li.querySelector('.name')?.textContent.includes('#' + k)), { timeout: 15000 }, k2);
  await closeModalIfOpen(page);

  await page.waitForFunction((title) => {
    const row = Array.from(document.querySelectorAll('.row')).find((r) => r.querySelector('.title')?.textContent === title);
    return row?.querySelector('.meta')?.textContent.includes('#미분류');
  }, { timeout: 15000 }, k2JobTitle);
});

let cUserId;
const nameC = uniq('스모크C');
let contextC, pageC;

test('admin panel: no 관리 button before promotion, appears after, lists users, and deletes a throwaway user', async () => {
  const hadAdminBefore = await page.evaluate(() => !!document.querySelector('[data-action="admin"]'));
  assert.equal(hadAdminBefore, false, 'expected no 관리 button before A is promoted');

  await promote(aUserId);
  await reloadAndWaitReady(page);
  await page.waitForFunction(() => !!document.querySelector('[data-action="admin"]'), { timeout: 15000 });

  // set up throwaway user C, sign in on their own browser page, and give A's
  // page a fresh view of the profiles list so C shows up in the assignee select
  const { user: cUser } = await newUser(nameC);
  cUserId = cUser.id;
  createdUserIds.push(cUserId);

  contextC = await browser.createBrowserContext();
  pageC = await contextC.newPage();
  await pageC.evaluateOnNewDocument((url, key) => {
    window.TASKBOARD_CONFIG = { SUPABASE_URL: url, SUPABASE_ANON_KEY: key };
  }, LOCAL_URL, ANON_KEY);
  await pageC.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
  await pageC.waitForSelector('.auth', { timeout: 10000 });
  await pageC.type('form[data-form="auth"] input[name="name"]', nameC);
  await Promise.all([
    pageC.waitForSelector('.topbar .me', { timeout: 15000 }),
    clickAction(pageC, 'form[data-form="auth"] button.primary'),
  ]);

  await reloadAndWaitReady(page);
  await page.waitForFunction((uid) => !!document.querySelector(`select[data-action="assignee"] option[value="${uid}"]`), { timeout: 15000 }, cUserId);

  const cJobTitle = uniq('C작업');
  await clickAction(page, '[data-action="new-job"]');
  await page.waitForSelector('form[data-form="job"]', { timeout: 5000 });
  await page.type('form[data-form="job"] input[name="title"]', cJobTitle);
  await selectAction(page, 'form[data-form="job"] select[name="assignee_id"]', cUserId);
  await Promise.all([
    page.waitForFunction(() => !document.getElementById('modal-root') || document.getElementById('modal-root').hidden, { timeout: 15000 }),
    clickAction(page, 'form[data-form="job"] button.primary'),
  ]);
  await waitForQuiet(page);

  await clickAction(page, '[data-action="admin"]');
  await page.waitForSelector('.list-manage', { timeout: 5000 });
  const rowInfo = await page.evaluate((name) => {
    const li = Array.from(document.querySelectorAll('.list-manage li')).find((li) => li.querySelector('.name')?.textContent.includes(name));
    if (!li) return null;
    return { text: li.textContent, hasDeleteBtn: !!li.querySelector('button[data-action="user-delete"]') };
  }, nameC);
  assert.ok(rowInfo, `expected user ${nameC} listed in the admin modal`);
  assert.ok(/받은/.test(rowInfo.text) && /보낸/.test(rowInfo.text), 'expected 받은/보낸 counts in the admin row');
  assert.ok(rowInfo.hasDeleteBtn, 'expected a delete button for a non-self user');

  await page.evaluate(() => { window.confirm = () => true; });
  await clickAction(page, `.list-manage li button[data-action="user-delete"][data-name="${nameC}"]`);
  await page.waitForFunction((name) => !Array.from(document.querySelectorAll('.list-manage li')).some((li) => li.querySelector('.name')?.textContent.includes(name)), { timeout: 15000 }, nameC);
  await closeModalIfOpen(page);

  // A's sent view now shows the job as assigned to "탈퇴자"
  await clickAction(page, '[data-action="view"][data-view="sent"]');
  await page.waitForFunction((title) => {
    const row = Array.from(document.querySelectorAll('.row')).find((r) => r.querySelector('.title')?.textContent === title);
    return row?.querySelector('.meta')?.textContent.includes('탈퇴자');
  }, { timeout: 15000 }, cJobTitle);
  await clickAction(page, '[data-action="view"][data-view="queue"]');

  // The job A made for C is now assignee_id = null (C's profile is gone).
  // As admin, A should be able to pick a 미배정 option in the assignee
  // select, see the job listed there under a 미배정 큐 heading, and hand it
  // off to B from the detail modal.
  await reloadAndWaitReady(page);
  await page.waitForFunction(() => !!document.querySelector('select[data-action="assignee"] option[value="__unassigned__"]'), { timeout: 15000 });
  await selectAction(page, 'select[data-action="assignee"]', '__unassigned__');
  await page.waitForFunction((title) => Array.from(document.querySelectorAll('.row')).some((r) => r.querySelector('.title')?.textContent === title), { timeout: 15000 }, cJobTitle);
  const heading = await page.$eval('h2', (el) => el.textContent);
  assert.ok(heading.includes('미배정 큐'), `expected a 미배정 큐 heading, got: ${heading}`);

  await clickRow(page, cJobTitle);
  await page.waitForSelector('.modal', { timeout: 5000 });
  await clickAction(page, '[data-action="job-handoff"]');
  await page.waitForSelector('#inline-form form[data-form="handoff"] select[name="assignee_id"]', { timeout: 5000 });
  await page.select('#inline-form select[name="assignee_id"]', bUserId);
  await clickAction(page, '#inline-form button.primary');
  await page.waitForFunction(() => document.querySelector('.modal .badge')?.textContent === '대기', { timeout: 10000 });
  await closeModalIfOpen(page);

  await reloadAndWaitReady(pageB);
  await pageB.waitForFunction((title) => Array.from(document.querySelectorAll('.row')).some((r) => r.querySelector('.title')?.textContent === title), { timeout: 15000 }, cJobTitle);

  await selectAction(page, 'select[data-action="assignee"]', aUserId);

  // C's own page ends up signed out (their profile no longer exists) on its next reload
  await pageC.reload({ waitUntil: 'networkidle0', timeout: 15000 });
  await pageC.waitForSelector('.auth', { timeout: 15000 });
  await pageC.close();
  await contextC.close();
});

test('admin sees 삭제 on a job they neither requested nor are assigned, and can delete it', async () => {
  const dTitle = uniq('작업D');
  await closeModalIfOpen(pageB);
  await clickAction(pageB, '[data-action="new-job"]');
  await pageB.waitForSelector('form[data-form="job"]', { timeout: 5000 });
  await pageB.type('form[data-form="job"] input[name="title"]', dTitle);
  await Promise.all([
    pageB.waitForFunction(() => !document.getElementById('modal-root') || document.getElementById('modal-root').hidden, { timeout: 15000 }),
    clickAction(pageB, 'form[data-form="job"] button.primary'),
  ]);
  await waitForQuiet(pageB);

  await selectAction(page, 'select[data-action="assignee"]', bUserId);
  await clickRow(page, dTitle);
  await page.waitForSelector('.modal', { timeout: 5000 });
  const hasDelete = await page.evaluate(() => !!document.querySelector('[data-action="job-delete"]'));
  assert.ok(hasDelete, 'expected admin to see a 삭제 button on a job they neither requested nor are assigned');

  await page.evaluate(() => { window.confirm = () => true; });
  await clickAction(page, '[data-action="job-delete"]');
  await page.waitForFunction((title) => !Array.from(document.querySelectorAll('.row')).some((r) => r.querySelector('.title')?.textContent === title), { timeout: 15000 }, dTitle);
  await selectAction(page, 'select[data-action="assignee"]', aUserId);
});

test('backdrop click dismisses the keyword modal, and it stays dismissed after a background realtime update', async () => {
  const title = uniq('배경알림K');
  await closeModalIfOpen(page);
  await createJobForB(title);
  await clickAction(page, '[data-action="view"][data-view="sent"]');
  await page.waitForFunction((t) => Array.from(document.querySelectorAll('.row')).some((r) => r.querySelector('.title')?.textContent === t), { timeout: 15000 }, title);

  await clickAction(page, '[data-action="manage-projects"]');
  await page.waitForSelector('.list-manage', { timeout: 5000 });
  await page.mouse.click(5, 5);
  await page.waitForFunction(() => document.getElementById('modal-root').hidden, { timeout: 5000 });

  // trigger a realtime change from B's context: starting the job changes its
  // status, which A's row list (rendered independently of any modal) picks up live.
  await openAsB(title);
  await clickAction(pageB, '[data-action="job-start"]');
  await pageB.waitForFunction(() => document.querySelector('.modal .badge')?.textContent === '진행중', { timeout: 10000 });

  await page.waitForFunction((t) => {
    const row = Array.from(document.querySelectorAll('.row')).find((r) => r.querySelector('.title')?.textContent === t);
    return row?.querySelector('.badge')?.textContent === '진행중';
  }, { timeout: 15000 }, title);

  const stillHidden = await page.evaluate(() => document.getElementById('modal-root').hidden);
  assert.ok(stillHidden, 'expected the keyword modal to remain closed after a background realtime re-render');
});

test('backdrop click dismisses the job detail modal, and it stays dismissed after a background realtime update', async () => {
  const title = uniq('배경알림J');
  await closeModalIfOpen(page);
  await createJobForB(title);
  await clickAction(page, '[data-action="view"][data-view="sent"]');
  await clickRow(page, title);
  await page.waitForSelector('.modal', { timeout: 5000 });

  await page.mouse.click(5, 5);
  await page.waitForFunction(() => document.getElementById('modal-root').hidden, { timeout: 5000 });

  await openAsB(title);
  await clickAction(pageB, '[data-action="job-start"]');
  await pageB.waitForFunction(() => document.querySelector('.modal .badge')?.textContent === '진행중', { timeout: 10000 });

  await page.waitForFunction((t) => {
    const row = Array.from(document.querySelectorAll('.row')).find((r) => r.querySelector('.title')?.textContent === t);
    return row?.querySelector('.badge')?.textContent === '진행중';
  }, { timeout: 15000 }, title);

  const stillHidden = await page.evaluate(() => document.getElementById('modal-root').hidden);
  assert.ok(stillHidden, 'expected the job detail modal to remain closed after a background realtime re-render');
});

test('realtime debounce: two rapid comments from B both land in A\'s open modal', async () => {
  // Two mutations fired back-to-back, well inside the 250ms debounce window
  // (see app.js scheduleRefresh). A's page is never reloaded here — only the
  // realtime subscription's debounced refresh can bring these in — so this
  // is a correctness check that the debounce coalesces bursts without
  // dropping the last event, not a call-count check.
  const job6Title = uniq('작업6');
  await closeModalIfOpen(page);
  await createJobForB(job6Title);

  await clickAction(page, '[data-action="view"][data-view="sent"]');
  await clickRow(page, job6Title);
  await page.waitForSelector('.modal', { timeout: 5000 });

  await openAsB(job6Title);

  // Set the textarea's value and click submit inside one evaluate() call
  // (rather than page.type() + a separate clickAction()): B's own realtime
  // echo of her own two inserts can reopen her modal (a fresh
  // renderJobDetail()) between the two mutations, and a multi-step
  // type-then-click sequence can lose keystrokes or the focused element to
  // that swap. A single synchronous evaluate() can't observe a
  // half-replaced tree, matching the pattern clickAction()/clickRow() use
  // above for the same reason.
  // Waits for the submit button to be enabled (see app.js's submit
  // listener: it disables button.primary for the duration of the
  // await fn(form) + refresh() + renderAll() sequence) before writing to it
  // — the previous submission's post-mutation renderAll() replaces the whole
  // form with a fresh one, and clicking a disabled button is a silent no-op,
  // which is why firing this twice with no wait in between only produced one
  // POST. Then waits for B's own comment list to show the just-posted text,
  // confirming this submission's own refresh()/renderAll() round-trip
  // finished before the next call runs.
  async function postCommentAsB(text) {
    await pageB.waitForSelector('form[data-form="comment"] textarea[name="body"]', { timeout: 10000 });
    await pageB.waitForFunction(() => {
      const btn = document.querySelector('form[data-form="comment"] button.primary');
      return !!btn && !btn.disabled;
    }, { timeout: 10000 });
    const ok = await pageB.evaluate((body) => {
      const form = document.querySelector('form[data-form="comment"]');
      if (!form) return false;
      form.querySelector('textarea[name="body"]').value = body;
      const btn = form.querySelector('button.primary');
      btn.focus();
      btn.click();
      return true;
    }, text);
    assert.ok(ok, 'expected to find and submit the comment form');
    await pageB.waitForFunction((t) =>
      Array.from(document.querySelectorAll('.comments li .text')).some((el) => el.textContent === t),
      { timeout: 10000 }, text);
  }

  const c1 = uniq('댓글빠1');
  const c2 = uniq('댓글빠2');
  await postCommentAsB(c1);
  await postCommentAsB(c2);

  await page.waitForFunction((t1, t2) => {
    const texts = Array.from(document.querySelectorAll('.comments li .text')).map((el) => el.textContent);
    return texts.includes(t1) && texts.includes(t2);
  }, { timeout: 15000 }, c1, c2);
});

test('connection banner: a REST outage shows it, recovery hides it and reloads data', async () => {
  // Simulates an outage without touching the Supabase stack (other tests
  // depend on it staying up): intercept and abort every /rest/v1/ request
  // from A's page, then drive the same path a real tab-focus takes by
  // dispatching visibilitychange — scheduleRefresh() -> refresh() -> the
  // aborted requests make loadAll() reject -> setBanner(...).
  await closeModalIfOpen(page);
  await reloadAndWaitReady(page);

  let blocking = true;
  const onRequest = (req) => {
    if (blocking && req.url().includes('/rest/v1/')) req.abort();
    else req.continue();
  };
  await page.setRequestInterception(true);
  page.on('request', onRequest);

  try {
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(() => {
      const b = document.getElementById('banner');
      return !b.hidden && b.textContent.includes('서버에 연결할 수 없습니다');
    }, { timeout: 10000 });

    blocking = false;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.waitForFunction(() => document.getElementById('banner').hidden, { timeout: 10000 });
    await page.waitForSelector('.rows', { timeout: 10000 });
  } finally {
    page.off('request', onRequest);
    await page.setRequestInterception(false);
  }
});

test('진행상황: all four status buttons are always offered, and 대기 rolls a finished job back', async () => {
  const title = uniq('상태전환');
  await createJobForB(title);
  await openAsB(title);

  const labels = () => pageB.evaluate(() =>
    Array.from(document.querySelectorAll('.status-actions button')).map((b) => b.textContent));
  assert.deepEqual(await labels(), ['대기', '진행중', '완료', '반려'],
    'expected all four status buttons on a waiting job');
  const currentOnWaiting = await pageB.evaluate(() =>
    document.querySelector('.status-actions button[aria-current]')?.textContent);
  assert.equal(currentOnWaiting, '대기');

  // 완료 -> the four buttons must still be there (status is always changeable)
  await clickAction(pageB, '[data-action="job-done"]');
  await pageB.waitForSelector('form[data-form="done"]', { timeout: 5000 });
  await clickAction(pageB, 'form[data-form="done"] button.primary');
  await pageB.waitForFunction(() => document.querySelector('.modal .badge')?.textContent === '완료', { timeout: 15000 });
  assert.deepEqual(await labels(), ['대기', '진행중', '완료', '반려'],
    'expected the status buttons to stay available on a finished job');
  assert.equal(await pageB.evaluate(() =>
    document.querySelector('.status-actions button[aria-current]')?.textContent), '완료');

  // 완료 -> 대기 (the new job-wait action), which also clears the finish time
  await clickAction(pageB, '[data-action="job-wait"]');
  await pageB.waitForFunction(() => document.querySelector('.modal .badge')?.textContent === '대기', { timeout: 15000 });
  const kv = await pageB.evaluate(() => document.querySelector('.modal .kv')?.textContent || '');
  assert.ok(!kv.includes('종료'), 'expected 종료 time to be cleared when rolled back to 대기');
});

test('키워드는 담당자 소유: B의 키워드는 B를 담당자로 골랐을 때만 목록에 뜬다', async () => {
  const keyword = uniq('B키워드');
  const title = uniq('키워드소유');
  await closeModalIfOpen(page);
  await clickAction(page, '[data-action="new-job"]');
  await page.waitForSelector('form[data-form="job"]', { timeout: 5000 });
  await page.type('form[data-form="job"] input[name="title"]', title);
  await page.select('form[data-form="job"] select[name="assignee_id"]', bUserId);
  await page.type('form[data-form="job"] input[name="new_project"]', keyword);
  await Promise.all([
    page.waitForFunction(() => document.getElementById('modal-root').hidden, { timeout: 15000 }),
    clickAction(page, 'form[data-form="job"] button.primary'),
  ]);
  await waitForQuiet(page);

  const optionsFor = async (userId) => {
    await clickAction(page, '[data-action="new-job"]');
    await page.waitForSelector('form[data-form="job"]', { timeout: 5000 });
    await page.select('form[data-form="job"] select[name="assignee_id"]', userId);
    // the change handler swaps the keyword list in place
    await page.waitForFunction(() => document.getElementById('job-project-select'), { timeout: 5000 });
    const opts = await page.evaluate(() =>
      Array.from(document.querySelectorAll('#job-project-select option')).map((o) => o.textContent));
    await closeModalIfOpen(page);
    return opts;
  };

  const forB = await optionsFor(bUserId);
  assert.ok(forB.includes(keyword), `expected ${keyword} in B's keyword list, got ${forB.join(',')}`);
  const forA = await optionsFor(aUserId);
  assert.ok(!forA.includes(keyword), `expected ${keyword} to be hidden when A is the assignee, got ${forA.join(',')}`);
  assert.ok(forA.includes('미분류'), 'expected 미분류 to stay available for everyone');
});

test('no unexpected console errors were captured', () => {
  // ERR_FAILED entries are the browser's own console noise from the
  // connection-banner test's deliberate request-interception aborts above —
  // expected, not a real app error.
  const benign = (e) => /config\.js/i.test(e) || /404/i.test(e) || /ERR_FAILED/i.test(e);

  // Name-only login probes sign-in first and falls back to sign-up, so the very
  // first login of each brand-new name logs exactly one 400 from /auth/v1/token.
  // Three names are created through the form in this suite (A, B, and the
  // throwaway user in the admin test); anything beyond that is a real error.
  const FRESH_SIGNUPS = 3;
  const expected400 = consoleErrors.filter((e) => !benign(e) && /status of 400/.test(e));
  assert.ok(expected400.length <= FRESH_SIGNUPS,
    `too many 400s (${expected400.length} > ${FRESH_SIGNUPS}): ${JSON.stringify(expected400, null, 2)}`);

  const unexpected = consoleErrors.filter((e) => !benign(e) && !/status of 400/.test(e));
  assert.deepEqual(unexpected, [], `unexpected console errors: ${JSON.stringify(unexpected, null, 2)}`);
});
