import { displayName, URGENCY_EMOJI, STATUS_LABELS, sortQueue, sortPast, queuePosition, isOverdue, formatDateTime, UNCATEGORIZED_ID } from './lib.js';

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

function projectName(id, projects) {
  return projects.find(p => p.id === id)?.name ?? '미분류';
}

export function jobRow(job, state, { showPos = true, showAssignee = false } = {}) {
  const { profiles, projects, jobs, attachments } = state;
  const pos = showPos ? queuePosition(job, jobs) : null;
  const over = isOverdue(job);
  const nAtt = attachments.filter(a => a.job_id === job.id).length;
  return `
  <div class="row ${over ? 'overdue' : ''}" data-action="open-job" data-id="${job.id}">
    <div class="pos">${pos ?? '·'}</div>
    <div class="emoji" title="긴급도 ${job.urgency}">${URGENCY_EMOJI[job.urgency]}</div>
    <div>
      <div class="title">${esc(job.title)}</div>
      <div class="meta">
        <span>#${esc(projectName(job.project_id, projects))}</span>
        <span>${showAssignee ? '담당 ' + esc(displayName(job.assignee_id, profiles)) : '의뢰 ' + esc(displayName(job.requester_id, profiles))}</span>
        ${nAtt ? `<span>📎 ${nAtt}</span>` : ''}
        ${job.seraph_path ? '<span>🖥 seraph</span>' : ''}
      </div>
    </div>
    <div class="right">
      <span class="badge ${job.status}">${STATUS_LABELS[job.status]}</span>
      ${job.deadline ? `<span class="deadline ${over ? 'over' : ''}">⏰ ${formatDateTime(job.deadline)}</span>` : ''}
    </div>
  </div>`;
}

function applyProjectFilter(jobs, state) {
  return state.projectFilter === 'all' ? jobs : jobs.filter(j => j.project_id === state.projectFilter);
}

export function renderQueue(state) {
  const who = displayName(state.assigneeId, state.profiles);
  const open = applyProjectFilter(sortQueue(state.jobs, state.assigneeId), state);
  const past = applyProjectFilter(sortPast(state.jobs, state.assigneeId), state);
  return `
  <h2>${esc(who)}의 큐 <span class="hint">(${open.length}건 · 들어온 순서)</span></h2>
  <div class="rows">${open.length ? open.map(j => jobRow(j, state)).join('') : '<div class="empty">대기 중인 일이 없습니다</div>'}</div>
  <details class="past"><summary>지난 일 ${past.length}건</summary>
    <div class="rows">${past.map(j => jobRow(j, state, { showPos: false })).join('')}</div>
  </details>`;
}

export function renderSent(state) {
  const mine = applyProjectFilter(state.jobs.filter(j => j.requester_id === state.me.id), state);
  const open = mine.filter(j => ['waiting', 'in_progress'].includes(j.status)).sort((a, b) => a.created_at < b.created_at ? 1 : -1);
  const past = mine.filter(j => !['waiting', 'in_progress'].includes(j.status)).sort((a, b) => String(b.finished_at).localeCompare(String(a.finished_at)));
  return `
  <h2>내가 보낸 의뢰 <span class="hint">(진행 중 ${open.length}건)</span></h2>
  <div class="rows">${open.length ? open.map(j => jobRow(j, state, { showAssignee: true })).join('') : '<div class="empty">보낸 의뢰가 없습니다</div>'}</div>
  <details class="past"><summary>지난 의뢰 ${past.length}건</summary>
    <div class="rows">${past.map(j => jobRow(j, state, { showPos: false, showAssignee: true })).join('')}</div>
  </details>`;
}

function toLocalInput(iso) {
  if (!iso) return '';
  const d = new Date(iso); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function renderJobForm(state, job = null) {
  const { profiles, projects, me } = state;
  const v = job || { assignee_id: me.id, project_id: UNCATEGORIZED_ID, title: '', body: '', urgency: 3, deadline: null, seraph_path: '' };
  const people = profiles.map(p => `<option value="${p.id}" ${p.id === v.assignee_id ? 'selected' : ''}>${esc(p.name)}${p.id === me.id ? ' (나)' : ''}</option>`).join('');
  const projs = projects.map(p => `<option value="${p.id}" ${p.id === v.project_id ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  const urg = [1, 2, 3, 4, 5].map(n => `<label style="display:inline-flex;align-items:center;gap:4px;margin:0 10px 0 0;font-size:18px"><input type="radio" name="urgency" value="${n}" ${n === v.urgency ? 'checked' : ''} style="width:auto">${URGENCY_EMOJI[n]}</label>`).join('');
  return `
  <button class="close" data-action="close-modal">✕</button>
  <h3>${job ? '의뢰 수정' : '새 의뢰'}</h3>
  <form data-form="job" data-id="${job ? job.id : ''}">
    <label>담당자</label><select name="assignee_id">${people}</select>
    <label>프로젝트</label>
    <div class="inline"><select name="project_id">${projs}</select><input name="new_project" placeholder="새 키워드 (입력 시 우선)" maxlength="40"></div>
    <label>제목 *</label><input name="title" required maxlength="200" value="${esc(v.title)}">
    <label>내용</label><textarea name="body">${esc(v.body)}</textarea>
    <label>긴급도</label><div>${urg}</div>
    <label>마감 (선택)</label><input type="datetime-local" name="deadline" value="${toLocalInput(v.deadline)}">
    <label>seraph 경로 (대용량은 여기)</label><input name="seraph_path" value="${esc(v.seraph_path)}" placeholder="/nas/…">
    <label>첨부 (각 20MB 이하)</label><input type="file" name="files" multiple>
    <div class="actions"><button class="primary">${job ? '저장' : '의뢰 제출'}</button><button type="button" data-action="close-modal">닫기</button></div>
  </form>`;
}
