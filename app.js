import { createApi } from './src/api.js';
import { validateName, translateAuthError } from './src/lib.js';
import { renderAuth, renderShell, toast, setBanner, closeModal } from './src/ui.js';

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

export function renderMain() {            // replaced in Task 5
  return '<div class="empty">아직 화면이 없습니다</div>';
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
