import { createApi } from './src/api.js';
import { validateName, translateAuthError, validateFiles } from './src/lib.js';
import { renderAuth, renderShell, toast, setBanner, closeModal, renderQueue, renderSent, renderJobForm, openModal, renderJobDetail, inlineForm } from './src/ui.js';

const cfg = window.TASKBOARD_CONFIG;
const client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const api = createApi(client);
const root = document.getElementById('app');

export const state = {
  session: null, me: null, profiles: [], projects: [], jobs: [], attachments: [], comments: [],
  view: 'queue', assigneeId: null, projectFilter: 'all', authMode: 'login', authError: '',
  openJobId: null,
};
let attUrls = {};

async function openJob(id) {
  state.openJobId = id;
  const job = state.jobs.find(j => j.id === id);
  if (!job) { state.openJobId = null; closeModal(); return; }
  attUrls = {};
  for (const a of state.attachments.filter(a => a.job_id === id)) {
    try { attUrls[a.id] = await api.attachmentUrl(a.storage_path); } catch { /* link stays plain */ }
  }
  openModal(renderJobDetail(state, job, attUrls));
}
const curJob = () => state.jobs.find(j => j.id === state.openJobId);

async function refresh() {
  try {
    Object.assign(state, await api.loadAll());
    state.me = state.profiles.find(p => p.id === state.session.user.id) || null;
    if (!state.assigneeId) state.assigneeId = state.session.user.id;
    setBanner(null);
  } catch (e) {
    setBanner('서버에 연결할 수 없습니다. 관리자에게 Supabase 복구를 요청하세요. (' + e.message + ')');
  }
}

export function renderMain() {
  return state.view === 'sent' ? renderSent(state) : renderQueue(state);
}

export function render() {
  if (!state.session || !state.me) {
    root.innerHTML = renderAuth(state.authMode, state.authError);
    return;
  }
  root.innerHTML = renderShell(state, renderMain());
}

// re-render open modal after every render(), but never wipe a draft the user is typing
function modalHasDraft() {
  const root = document.getElementById('modal-root');
  if (root.hidden) return false;
  const active = document.activeElement;
  if (active && root.contains(active) && ['TEXTAREA', 'INPUT', 'SELECT'].includes(active.tagName)) return true;
  return Array.from(root.querySelectorAll('textarea, input[type=text], input[name=title]')).some(el => el.value.trim() !== '' && el.defaultValue !== el.value);
}
let pendingModalRefresh = false;
const _render = render;
export function renderAll() {
  _render();
  if (!state.openJobId) return;
  const j = curJob();
  if (!j) { state.openJobId = null; closeModal(); return; }
  if (modalHasDraft()) { pendingModalRefresh = true; return; }   // redraw later, after the form is submitted or blurred
  pendingModalRefresh = false;
  openModal(renderJobDetail(state, j, attUrls));
}
document.getElementById('modal-root').addEventListener('focusout', () => {
  setTimeout(() => { if (pendingModalRefresh && !modalHasDraft()) renderAll(); }, 50);
});

// ── event wiring (delegated) ──
export const actions = {
  'auth-mode': (el) => { state.authMode = el.dataset.mode; state.authError = ''; renderAll(); },
  'view': (el) => { state.view = el.dataset.view; renderAll(); },
  'logout': async () => { await api.signOut(); },
  'new-job': () => openModal(renderJobForm(state)),
  'close-modal': () => { state.openJobId = null; closeModal(); },
  'open-job': (el) => openJob(el.dataset.id),
  'job-start': async () => { await api.startJob(state.openJobId); toast('진행중으로 바꿨습니다'); },
  'job-done': () => { document.getElementById('inline-form').innerHTML = inlineForm('done', state, curJob()); },
  'job-reject': () => { document.getElementById('inline-form').innerHTML = inlineForm('reject', state, curJob()); },
  'job-handoff': () => { document.getElementById('inline-form').innerHTML = inlineForm('handoff', state, curJob()); },
  'job-cancel': async () => { if (confirm('이 의뢰를 취소할까요?')) { await api.cancelJob(state.openJobId); toast('취소했습니다'); } },
  'job-edit': () => openModal(renderJobForm(state, curJob())),
  'job-delete': async () => { if (confirm('의뢰를 완전히 삭제할까요?')) { await api.deleteJob(state.openJobId); state.openJobId = null; closeModal(); toast('삭제했습니다'); } },
  'comment-delete': async (el) => { await api.deleteComment(el.dataset.id); },
  'att-delete': async (el) => { const a = state.attachments.find(x => x.id === el.dataset.id); if (a && confirm(`${a.filename} 삭제?`)) await api.deleteAttachment(a); },
};
export const changes = {
  'assignee': (el) => { state.assigneeId = el.value; renderAll(); },
  'project-filter': (el) => { state.projectFilter = el.value; renderAll(); },
  'att-upload': async (el) => {
    const files = Array.from(el.files);
    const chk = validateFiles(files);
    if (!chk.ok) { toast(`20MB 초과: ${chk.tooLarge.join(', ')}`, 'error'); el.value = ''; return; }
    for (const f of files) await api.uploadAttachment(state.openJobId, el.dataset.kind, f);
    toast('첨부했습니다');
  },
};
export const forms = {
  'auth': async (form) => {
    const fd = new FormData(form);
    const v = validateName(fd.get('name'));
    if (!v.ok) { state.authError = v.error; renderAll(); return; }
    try {
      if (form.dataset.mode === 'signup') await api.signUp(v.name, fd.get('password'));
      else await api.signIn(v.name, fd.get('password'));
      state.authError = '';
    } catch (e) {
      state.authError = translateAuthError(e.message);
      renderAll();
    }
  },
  // form.reset() before the outer listener's renderAll(): without it the
  // memo/reason textarea still holds its typed value when modalHasDraft()
  // runs, which reads as an unsaved draft and blocks the re-render that
  // would otherwise replace this inline form with the updated detail view —
  // permanently, since nothing else ever asks it to look again.
  'done': async (form) => { await api.finishJob(state.openJobId, String(new FormData(form).get('result_note') || '')); form.reset(); toast('완료 처리했습니다'); },
  'reject': async (form) => { await api.rejectJob(state.openJobId, String(new FormData(form).get('reject_reason') || '').trim()); form.reset(); toast('반려했습니다'); },
  'handoff': async (form) => { await api.handoffJob(state.openJobId, new FormData(form).get('assignee_id')); toast('넘겼습니다'); },
  'comment': async (form) => { await api.addComment(state.openJobId, String(new FormData(form).get('body')).trim()); form.reset(); },
};

async function resolveProject(fd) {
  const name = String(fd.get('new_project') || '').trim();
  if (!name) return fd.get('project_id');
  const existing = state.projects.find(p => p.name === name);
  if (existing) return existing.id;
  const p = await api.addProject(name);
  return p.id;
}

forms['job'] = async (form) => {
  const fd = new FormData(form);
  const files = fd.getAll('files').filter(f => f && f.size > 0);
  const chk = validateFiles(files);
  if (!chk.ok) { toast(`20MB 초과: ${chk.tooLarge.join(', ')}`, 'error'); return; }
  const fields = {
    assignee_id: fd.get('assignee_id'),
    project_id: await resolveProject(fd),
    title: String(fd.get('title')).trim(),
    body: String(fd.get('body') || ''),
    urgency: Number(fd.get('urgency') || 3),
    deadline: fd.get('deadline') ? new Date(fd.get('deadline')).toISOString() : null,
    seraph_path: String(fd.get('seraph_path') || '').trim(),
  };
  const id = form.dataset.id;
  const job = id ? await api.updateJob(id, fields) : await api.createJob(fields);
  const failed = [];
  for (const f of files) {
    try { await api.uploadAttachment(job.id, 'request', f); } catch (e) { failed.push(`${f.name} (${e.message})`); }
  }
  closeModal();
  await refresh();
  if (id) { state.openJobId = job.id; await openJob(job.id); } else { state.openJobId = null; }
  renderAll();
  toast(id ? '수정했습니다' : `의뢰를 제출했습니다 (${displayNameOf(job.assignee_id)} 큐)`);
  if (failed.length) toast(`첨부 실패: ${failed.join('; ')} — 상세 화면에서 다시 올릴 수 있습니다`, 'error');
};
function displayNameOf(id) { return state.profiles.find(p => p.id === id)?.name ?? '탈퇴자'; }

// Actions/changes/forms that write to the server without re-rendering
// themselves — the delegated listeners below are responsible for the
// post-mutation `refresh(); renderAll();` for exactly these. Everything else
// (view/tab toggles, opening a modal, the auth and job forms) already renders
// itself; forcing an extra network refresh + full re-render after those too
// would (a) race the fast, self-contained UI update with a slower server
// round-trip that clobbers in-flight interactions (observed: it silently ate
// the project-filter <select>'s change event further down the test suite),
// and (b) for job-edit specifically, re-open the read-only detail modal on
// top of the edit form it just opened, since state.openJobId is still set.
const MUTATING_ACTIONS = new Set(['job-start', 'job-cancel', 'job-delete', 'comment-delete', 'att-delete']);
const MUTATING_CHANGES = new Set(['att-upload']);
const MUTATING_FORMS = new Set(['done', 'reject', 'handoff', 'comment']);

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'SELECT') return;
  const name = el.dataset.action;
  const fn = actions[name];
  if (!fn) return;
  try {
    await fn(el);
    if (MUTATING_ACTIONS.has(name)) { if (state.session) await refresh(); renderAll(); }
  } catch (err) { toast(err.message, 'error'); if (state.session) await refresh(); renderAll(); }
});
document.addEventListener('change', async (e) => {
  const el = e.target.closest('select[data-action], input[data-action]');
  if (!el) return;
  const name = el.dataset.action;
  const fn = changes[name];
  if (!fn) return;
  try {
    await fn(el);
    if (MUTATING_CHANGES.has(name)) { if (state.session) await refresh(); renderAll(); }
  } catch (err) { toast(err.message, 'error'); if (state.session) await refresh(); renderAll(); }
});
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const name = form.dataset.form;
  const fn = forms[name];
  if (!fn) return;
  const btn = form.querySelector('button.primary'); if (btn) btn.disabled = true;
  try {
    await fn(form);
    if (MUTATING_FORMS.has(name)) { if (state.session) await refresh(); renderAll(); }
  } catch (err) { toast(err.message, 'error'); }
  finally { if (btn) btn.disabled = false; }
});
document.getElementById('modal-root').addEventListener('click', (e) => {
  if (e.target.id === 'modal-root') closeModal();
});

let unsubscribe = null;
let bootstrapped = false;
async function onSession(session) {
  const sameUser = (session?.user?.id ?? null) === (state.session?.user?.id ?? null);
  if (bootstrapped && sameUser && (session === null || state.me)) {
    // TOKEN_REFRESHED / repeated INITIAL_SESSION for the same user: nothing to reload.
    state.session = session;
    return;
  }
  bootstrapped = true;
  state.session = session;
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  if (session) {
    await refresh();
    unsubscribe = api.subscribe(async () => { await refresh(); renderAll(); });
  } else {
    Object.assign(state, { me: null, profiles: [], projects: [], jobs: [], attachments: [], comments: [], assigneeId: null });
    closeModal();
  }
  renderAll();
}

api.onAuthChange(onSession);
export { api, refresh };
