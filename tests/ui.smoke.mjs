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
// Every mutation triggers *two* independent re-renders of an open detail
// modal: the delegated listener's own post-mutation `refresh(); renderAll();`,
// and — shortly after, indeterminately — the realtime subscription noticing
// the very same row change and doing the same thing again. The first is what
// the waitForFunction() badge checks below observe; the second can still
// land a beat later and swap out the modal's DOM out from under an
// immediately-following click. A short settle after each confirmed
// transition absorbs that second, otherwise-unsynchronized re-render.
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));

async function closeModalIfOpen(pageX) {
  if (await pageX.$('.modal')) {
    await pageX.click('[data-action="close-modal"]').catch(() => {});
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
  aUserId = uid;
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
  attachTitleGlobal = attachTitle;
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
  await pageB.click('[data-action="auth-mode"][data-mode="signup"]');
  await pageB.waitForSelector('form[data-form="auth"][data-mode="signup"]', { timeout: 5000 });
  await pageB.type('form[data-form="auth"] input[name="name"]', nameB);
  await pageB.type('form[data-form="auth"] input[name="password"]', 'secret123');
  await Promise.all([
    pageB.waitForSelector('.topbar .me', { timeout: 15000 }),
    pageB.click('form[data-form="auth"] button.primary'),
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
  // create a job for B. NOTE: navigating an already-authenticated page again
  // (page.reload()/page.goto()) hangs forever in this environment — the
  // bundled supabase-js client's session-recovery path never resolves on a
  // second load of a page that already has a persisted session in
  // localStorage (reproduced in isolation: refresh() never completes, no
  // REST request is even issued). So instead of reloading, we rely on A's
  // page never having navigated away: its realtime subscription (wired up
  // once at login) picks up the new 'profiles' row in the background, and we
  // just wait for that to land in the always-live topbar <select>.
  await page.waitForFunction(
    (uid) => !!document.querySelector(`select[data-action="assignee"] option[value="${uid}"]`),
    { timeout: 15000 }, bUserId,
  );
});

async function createJobForB(title) {
  await page.click('[data-action="new-job"]');
  await page.waitForSelector('form[data-form="job"]', { timeout: 5000 });
  await page.type('form[data-form="job"] input[name="title"]', title);
  await page.select('form[data-form="job"] select[name="assignee_id"]', bUserId);
  await Promise.all([
    page.waitForFunction(() => !document.getElementById('modal-root') || document.getElementById('modal-root').hidden, { timeout: 15000 }),
    page.click('form[data-form="job"] button.primary'),
  ]);
}

// B never reloads either (same hang risk as above) — her page has had a live
// realtime subscription since she signed up, so a job just created for her
// shows up in her queue on its own; we just wait for it.
async function openAsB(title) {
  // if a previous test left B's detail modal open, its full-screen backdrop
  // sits on top of the row list and swallows the click below meant for the
  // new row (closing the stale modal instead of opening the new one) —
  // start from a clean slate every time.
  await closeModalIfOpen(pageB);
  await pageB.waitForFunction(hasRow, { timeout: 15000 }, title);
  const rowHandle = await pageB.evaluateHandle(findRow, title);
  await rowHandle.click();
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

  await pageB.click('[data-action="job-start"]');
  await pageB.waitForFunction(() => document.querySelector('.modal .badge')?.textContent === '진행중', { timeout: 10000 });
  const hasStart = await pageB.evaluate(() => document.querySelector('.modal').textContent.includes('시작'));
  assert.ok(hasStart, 'expected a 시작 (started) timestamp once in_progress');
  await settle();
});

test('B finishes the job with a memo; badge, memo box, and result upload appear', async () => {
  await pageB.click('[data-action="job-done"]');
  await pageB.waitForSelector('#inline-form form[data-form="done"] textarea[name="result_note"]', { timeout: 5000 });
  const memo = uniq('완료메모');
  await pageB.type('#inline-form textarea[name="result_note"]', memo);
  await pageB.click('#inline-form button.primary');
  await pageB.waitForFunction(() => document.querySelector('.modal .badge')?.textContent === '완료', { timeout: 10000 });

  const bodyText = await pageB.$eval('.modal', (el) => el.textContent);
  assert.ok(bodyText.includes(memo), 'expected the completion memo to be shown');
  const resultInput = await pageB.$('input[type="file"][data-action="att-upload"][data-kind="result"]');
  assert.ok(resultInput, 'expected a result-attachment file input on a done job (assignee can still attach results)');
  await settle();
});

let job2Title;

test('second job: B\'s empty reject reason is blocked, then a real reason rejects it', async () => {
  job2Title = uniq('작업2');
  await createJobForB(job2Title);
  await openAsB(job2Title);

  await pageB.click('[data-action="job-reject"]');
  await pageB.waitForSelector('#inline-form form[data-form="reject"] textarea[name="reject_reason"]', { timeout: 5000 });
  await pageB.click('#inline-form button.danger');
  // blocked by the textarea's `required` attribute: no navigation, form still there
  const stillOpen = await pageB.$('#inline-form form[data-form="reject"]');
  assert.ok(stillOpen, 'expected the reject form to remain open when the reason is empty');
  const badgeStill = await pageB.$eval('.modal .badge', (el) => el.textContent);
  assert.equal(badgeStill, '대기', 'status should not have changed while the reason was empty');

  const reason = uniq('반려사유');
  await pageB.type('#inline-form textarea[name="reject_reason"]', reason);
  await pageB.click('#inline-form button.danger');
  await pageB.waitForFunction(() => document.querySelector('.modal .badge')?.textContent === '반려', { timeout: 10000 });
  const bodyText = await pageB.$eval('.modal', (el) => el.textContent);
  assert.ok(bodyText.includes(reason), 'expected the reject reason to be shown in the red box');
  await settle();
});

let job3Title;

test('third job: B hands off to A; it lands at the end of A\'s queue and leaves B\'s', async () => {
  job3Title = uniq('작업3');
  await createJobForB(job3Title);
  await openAsB(job3Title);

  await pageB.click('[data-action="job-handoff"]');
  await pageB.waitForSelector('#inline-form form[data-form="handoff"] select[name="assignee_id"]', { timeout: 5000 });
  await pageB.select('#inline-form select[name="assignee_id"]', aUserId);
  await pageB.click('#inline-form button.primary');
  await pageB.waitForFunction(() => document.querySelector('.modal .badge')?.textContent === '대기', { timeout: 10000 });
  await settle();

  // B's queue no longer lists it (assignee changed away from B)
  await pageB.click('[data-action="close-modal"]');
  const stillInB = await pageB.evaluate(hasRow, job3Title);
  assert.equal(stillInB, false, 'expected job3 to have left B\'s open queue after handoff');

  // it shows up at the end of A's open queue (picked up live via A's own
  // realtime subscription — see the no-reload note above), after the
  // pre-existing jobs
  await page.click('[data-action="view"][data-view="queue"]');
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
  await settle();
});

test('A edits job3\'s title, then cancels it', async () => {
  const rowHandle = await page.evaluateHandle(findRow, job3Title);
  await rowHandle.click();
  await page.waitForSelector('.modal', { timeout: 5000 });

  const editBtn = await page.$('[data-action="job-edit"]');
  assert.ok(editBtn, 'expected a 수정 button for the requester on a waiting job');

  await page.click('[data-action="job-edit"]');
  await page.waitForSelector('form[data-form="job"]', { timeout: 5000 });
  const newTitle = uniq('수정된작업3');
  await page.evaluate(() => { document.querySelector('form[data-form="job"] input[name="title"]').value = ''; });
  await page.type('form[data-form="job"] input[name="title"]', newTitle);
  await Promise.all([
    page.waitForFunction((title) => document.querySelector('.modal h3')?.textContent.includes(title), { timeout: 15000 }, newTitle),
    page.click('form[data-form="job"] button.primary'),
  ]);
  job3Title = newTitle;
  await settle();

  await page.evaluate(() => { window.confirm = () => true; });
  await page.click('[data-action="job-cancel"]');
  await page.waitForFunction(() => document.querySelector('.modal .badge')?.textContent === '취소', { timeout: 10000 });
  await settle();
});

let job5Title;

test('comments: A posts one, B sees it live, only the author can delete', async () => {
  // a fresh, still-open job (rather than reusing the done job1, which sits
  // inside a collapsed <details> whose `open` state a background re-render
  // would reset, racing with the click below)
  job5Title = uniq('작업5');
  await closeModalIfOpen(page);
  await createJobForB(job5Title);
  await settle();

  await page.click('[data-action="view"][data-view="sent"]');
  await page.waitForFunction(hasRow, { timeout: 15000 }, job5Title);
  const rowHandle = await page.evaluateHandle(findRow, job5Title);
  await rowHandle.click();
  await page.waitForSelector('.modal', { timeout: 5000 });

  const commentText = uniq('댓글A');
  await page.type('form[data-form="comment"] textarea[name="body"]', commentText);
  await page.click('form[data-form="comment"] button.primary');
  await page.waitForFunction((text) =>
    Array.from(document.querySelectorAll('.comments li .text')).some((el) => el.textContent === text), { timeout: 10000 }, commentText);
  const who = await page.evaluate((text) => {
    const li = Array.from(document.querySelectorAll('.comments li')).find((li) => li.querySelector('.text')?.textContent === text);
    return li?.querySelector('.who')?.textContent;
  }, commentText);
  assert.equal(who, nameA);

  // B sees the same comment live (her page's own realtime subscription;
  // no reload — see the no-reload note near the B-signup test above). By
  // this point several other realtime events have already gone over the
  // same channel in this test run, so give this one a longer window.
  await openAsB(job5Title);
  await pageB.waitForFunction((text) =>
    Array.from(document.querySelectorAll('.comments li .text')).some((el) => el.textContent === text), { timeout: 20000 }, commentText);
  const delBtnOnB = await pageB.$('.comments li button[data-action="comment-delete"]');
  assert.equal(delBtnOnB, null, 'B should not see a delete button on A\'s own comment');

  // A deletes her own comment
  await page.click('.comments li button[data-action="comment-delete"]');
  await page.waitForFunction((text) =>
    !Array.from(document.querySelectorAll('.comments li .text')).some((el) => el.textContent === text), { timeout: 10000 }, commentText);
  await settle();
});

test('draft preservation: A\'s unsent comment survives a background re-render from B\'s change', async () => {
  const job4Title = uniq('작업4');
  await closeModalIfOpen(page);
  await page.click('[data-action="view"][data-view="queue"]');
  await createJobForB(job4Title);
  await settle();

  // A opens it as requester (in 보낸 의뢰) and starts typing a comment, without submitting
  await page.click('[data-action="view"][data-view="sent"]');
  await page.waitForFunction(hasRow, { timeout: 15000 }, job4Title);
  const rowHandle = await page.evaluateHandle(findRow, job4Title);
  await rowHandle.click();
  await page.waitForSelector('.modal', { timeout: 5000 });

  // B opens the same job in the other browser context
  await openAsB(job4Title);

  const draftText = uniq('초안');
  await page.type('form[data-form="comment"] textarea[name="body"]', draftText);

  // B changes the status while A's textarea has unsent text
  await pageB.click('[data-action="job-start"]');
  await pageB.waitForFunction(() => document.querySelector('.modal .badge')?.textContent === '진행중', { timeout: 10000 });

  // give A's realtime subscription (api.subscribe → refresh(); renderAll())
  // time to fire and attempt a re-render of the open detail modal
  await new Promise((r) => setTimeout(r, 1500));
  const stillDraft = await page.$eval('form[data-form="comment"] textarea[name="body"]', (el) => el.value);
  assert.equal(stillDraft, draftText, 'expected the in-progress comment draft to survive a background re-render');

  await page.click('form[data-form="comment"] button.primary');
  await page.waitForFunction(() => document.querySelector('.modal .badge')?.textContent === '진행중', { timeout: 10000 });
  const bodyText = await page.$eval('.modal', (el) => el.textContent);
  assert.ok(bodyText.includes(draftText), 'expected the submitted draft comment to now be visible, alongside the status B set');
});

test('no unexpected console errors were captured', () => {
  const unexpected = consoleErrors.filter((e) => !/config\.js/i.test(e) && !/404/i.test(e));
  assert.deepEqual(unexpected, [], `unexpected console errors: ${JSON.stringify(unexpected, null, 2)}`);
});
