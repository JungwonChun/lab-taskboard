import { createApi } from './src/api.js';
import { validateName, translateAuthError, validateFiles } from './src/lib.js';
import { renderAuth, renderShell, toast, setBanner, closeModal, renderQueue, renderSent, renderJobForm, openModal } from './src/ui.js';

const cfg = window.TASKBOARD_CONFIG;
const client = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const api = createApi(client);
const root = document.getElementById('app');

export const state = {
  session: null, me: null, profiles: [], projects: [], jobs: [], attachments: [], comments: [],
  view: 'queue', assigneeId: null, projectFilter: 'all', authMode: 'login', authError: '',
};

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

// ── event wiring (delegated) ──
export const actions = {
  'auth-mode': (el) => { state.authMode = el.dataset.mode; state.authError = ''; render(); },
  'view': (el) => { state.view = el.dataset.view; render(); },
  'logout': async () => { await api.signOut(); },
  'new-job': () => openModal(renderJobForm(state)),
  'close-modal': () => closeModal(),
};
export const changes = {
  'assignee': (el) => { state.assigneeId = el.value; render(); },
  'project-filter': (el) => { state.projectFilter = el.value; render(); },
};
export const forms = {
  'auth': async (form) => {
    const fd = new FormData(form);
    const v = validateName(fd.get('name'));
    if (!v.ok) { state.authError = v.error; render(); return; }
    try {
      if (form.dataset.mode === 'signup') await api.signUp(v.name, fd.get('password'));
      else await api.signIn(v.name, fd.get('password'));
      state.authError = '';
    } catch (e) {
      state.authError = translateAuthError(e.message);
      render();
    }
  },
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
  await refresh(); render();
  toast(id ? '수정했습니다' : `의뢰를 제출했습니다 (${displayNameOf(job.assignee_id)} 큐)`);
  if (failed.length) toast(`첨부 실패: ${failed.join('; ')} — 상세 화면에서 다시 올릴 수 있습니다`, 'error');
};
function displayNameOf(id) { return state.profiles.find(p => p.id === id)?.name ?? '탈퇴자'; }

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-action]');
  if (!el || el.tagName === 'SELECT') return;
  const fn = actions[el.dataset.action];
  if (!fn) return;
  try { await fn(el); } catch (err) { toast(err.message, 'error'); await refresh(); render(); }
});
document.addEventListener('change', async (e) => {
  const el = e.target.closest('select[data-action], input[data-action]');
  if (!el) return;
  const fn = changes[el.dataset.action];
  if (fn) { try { await fn(el); } catch (err) { toast(err.message, 'error'); await refresh(); render(); } }
});
document.addEventListener('submit', async (e) => {
  const form = e.target.closest('form[data-form]');
  if (!form) return;
  e.preventDefault();
  const fn = forms[form.dataset.form];
  if (!fn) return;
  const btn = form.querySelector('button.primary'); if (btn) btn.disabled = true;
  try { await fn(form); } catch (err) { toast(err.message, 'error'); }
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
    unsubscribe = api.subscribe(async () => { await refresh(); render(); });
  } else {
    Object.assign(state, { me: null, profiles: [], projects: [], jobs: [], attachments: [], comments: [], assigneeId: null });
    closeModal();
  }
  render();
}

api.onAuthChange(onSession);
export { api, refresh };
