import { displayName } from './lib.js';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function renderAuth(mode = 'login', error = '') {
  const signup = mode === 'signup';
  return `
  <div class="auth">
    <h1>Lab Taskboard</h1>
    <div class="tabs">
      <button data-action="auth-mode" data-mode="login" class="${signup ? '' : 'active'}">로그인</button>
      <button data-action="auth-mode" data-mode="signup" class="${signup ? 'active' : ''}">가입</button>
    </div>
    <form data-form="auth" data-mode="${mode}">
      <label>이름</label>
      <input name="name" autocomplete="username" required maxlength="40" placeholder="예: 천정원">
      <label>비밀번호</label>
      <input name="password" type="password" autocomplete="${signup ? 'new-password' : 'current-password'}" required minlength="6">
      <div class="error">${esc(error)}</div>
      <button class="primary" style="width:100%;margin-top:8px">${signup ? '가입하기' : '로그인'}</button>
    </form>
  </div>`;
}

export function renderShell(state, mainHtml) {
  const { me, profiles, projects, view, assigneeId, projectFilter } = state;
  const people = profiles.map(p => `<option value="${p.id}" ${p.id === assigneeId ? 'selected' : ''}>${esc(p.name)}${p.id === me.id ? ' (나)' : ''}</option>`).join('');
  const projs = projects.map(p => `<option value="${p.id}" ${p.id === projectFilter ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  return `
  <header class="topbar">
    <span class="brand">Lab Taskboard</span>
    <button class="tab ${view === 'queue' ? 'active' : ''}" data-action="view" data-view="queue">큐</button>
    <button class="tab ${view === 'sent' ? 'active' : ''}" data-action="view" data-view="sent">보낸 의뢰</button>
    ${view === 'queue' ? `<select data-action="assignee">${people}</select>` : ''}
    <select data-action="project-filter"><option value="all" ${projectFilter === 'all' ? 'selected' : ''}>전체 프로젝트</option>${projs}</select>
    <button class="primary" data-action="new-job">+ 새 의뢰</button>
    <button data-action="manage-projects">키워드 관리</button>
    ${me.is_admin ? '<button data-action="admin">관리</button>' : ''}
    <span class="spacer"></span>
    <span class="me">${esc(displayName(me.id, profiles))}</span>
    <button data-action="logout">로그아웃</button>
  </header>
  <main>${mainHtml}</main>`;
}

export function toast(msg, kind = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  document.getElementById('toast-root').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

export function setBanner(msg) {
  const b = document.getElementById('banner');
  b.hidden = !msg;
  b.textContent = msg || '';
}

export function openModal(html) {
  const root = document.getElementById('modal-root');
  root.innerHTML = `<div class="modal">${html}</div>`;
  root.hidden = false;
}
export function closeModal() {
  const root = document.getElementById('modal-root');
  root.hidden = true;
  root.innerHTML = '';
}
