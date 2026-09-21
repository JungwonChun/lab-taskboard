import { displayName, URGENCY_EMOJI, STATUS_LABELS, sortQueue, sortPast, queuePosition, isOverdue, formatDateTime, UNCATEGORIZED_ID } from './lib.js';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function renderAuth(_mode = 'login', error = '') {
  return `
  <div class="auth">
    <h1>Lab Taskboard</h1>
    <p class="hint">이름만 치면 들어갑니다. 처음 보는 이름이면 그 자리에서 계정이 만들어집니다.</p>
    <form data-form="auth">
      <label>이름</label>
      <input name="name" autocomplete="username" required maxlength="40" placeholder="예: 천정원" autofocus>
      <div class="error">${esc(error)}</div>
      <button class="primary" style="width:100%;margin-top:8px">들어가기</button>
    </form>
    <p class="hint" style="margin-top:14px">이 보드는 주소를 아는 사람이면 누구나 열 수 있습니다. 민감한 내용은 올리지 마세요.</p>
  </div>`;
}

export function renderShell(state, mainHtml) {
  const { me, profiles, projects, jobs, view, assigneeId, projectFilter } = state;
  const showUnassigned = me.is_admin || jobs.some(j => j.assignee_id === null);
  const people = profiles.map(p => `<option value="${p.id}" ${p.id === assigneeId ? 'selected' : ''}>${esc(p.name)}${p.id === me.id ? ' (나)' : ''}</option>`).join('')
    + (showUnassigned ? `<option value="__unassigned__" ${assigneeId === null ? 'selected' : ''}>미배정</option>` : '');
  const projs = projectsFor(projects, view === 'sent' ? me.id : assigneeId)
    .map(p => `<option value="${p.id}" ${p.id === projectFilter ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
  return `
  <header class="topbar">
    <span class="brand">Lab Taskboard</span>
    <button class="tab ${view === 'dashboard' ? 'active' : ''}" data-action="view" data-view="dashboard">대시보드</button>
    <button class="tab ${view === 'queue' ? 'active' : ''}" data-action="view" data-view="queue">큐</button>
    <button class="tab ${view === 'sent' ? 'active' : ''}" data-action="view" data-view="sent">보낸 의뢰</button>
    ${view === 'queue' ? `<select data-action="assignee">${people}</select>` : ''}
    ${view === 'dashboard' ? '' : `<select data-action="project-filter"><option value="all" ${projectFilter === 'all' ? 'selected' : ''}>전체 프로젝트</option>${projs}</select>`}
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

// 키워드는 담당자 소유. ownerId 의 키워드 + 공용(미분류)만 고른다.
export function projectsFor(projects, ownerId) {
  return projects.filter(p => p.id === UNCATEGORIZED_ID || (ownerId != null && p.owner_id === ownerId));
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
      ${job.deadline ? `<span class="deadline ${over ? 'over' : ''}">⏰ 마감 ${formatShort(job.deadline)}</span>` : ''}
      ${job.eta && isOpen(job) ? `<span class="eta">🏁 예상 ${formatShort(job.eta)}</span>` : ''}
    </div>
  </div>`;
}

function applyProjectFilter(jobs, state) {
  return state.projectFilter === 'all' ? jobs : jobs.filter(j => j.project_id === state.projectFilter);
}

// 대시보드: 개수를 읽는 화면이라 차트가 아니라 숫자 타일 + 표가 맞는 형태다.
export function renderDashboard(state) {
  const st = dashboardStats(state.jobs, state.profiles);
  const tile = (label, value, note, kind) => `
    <div class="tile ${kind || ''}">
      <div class="tile-value">${value}</div>
      <div class="tile-label">${esc(label)}</div>
      ${note ? `<div class="tile-note">${esc(note)}</div>` : ''}
    </div>`;
  const rows = st.perPerson.map((r) => `
    <tr>
      <td>${esc(r.name)}</td>
      <td class="num">${r.waiting}</td>
      <td class="num">${r.in_progress}</td>
      <td class="num">${r.done}</td>
      <td class="num ${r.overdue ? 'over' : ''}">${r.overdue || '·'}</td>
      <td><button data-action="goto-queue" data-id="${r.id}">큐 보기</button></td>
    </tr>`).join('');
  return `
  <div class="head-row"><h2>대시보드</h2><button class="primary" data-action="new-job">+ 새 의뢰</button></div>
  <div class="tiles">
    ${tile('쌓여있는 일', st.waiting, '아직 손대지 않은 대기 건')}
    ${tile('진행중', st.in_progress, '지금 누군가 붙잡고 있는 일')}
    ${tile('총 처리량', st.done, '지금까지 완료된 누적 건수')}
  </div>
  <div class="tiles small">
    ${tile('마감 지남', st.overdue, '열려 있는데 마감이 지난 건', st.overdue ? 'warn' : '')}
    ${tile('반려', st.rejected, '')}
    ${tile('미배정', st.unassigned, '담당자가 없는 열린 건', st.unassigned ? 'warn' : '')}
  </div>
  <h2>사람별 현황</h2>
  ${rows ? `<div class="table-wrap"><table class="stats">
    <thead><tr><th>이름</th><th class="num">대기</th><th class="num">진행중</th><th class="num">완료</th><th class="num">마감 지남</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>` : '<div class="empty">아직 의뢰가 없습니다</div>'}`;
}

export function renderQueue(state) {
  const unassigned = state.assigneeId === null;
  const heading = unassigned ? '미배정 큐' : `${esc(displayName(state.assigneeId, state.profiles))}의 큐`;
  const open = applyProjectFilter(sortQueue(state.jobs, state.assigneeId), state);
  const past = applyProjectFilter(sortPast(state.jobs, state.assigneeId), state);
  return `
  <div class="head-row"><h2>${heading} <span class="hint">(${open.length}건 · 들어온 순서)</span></h2><button class="primary" data-action="new-job">+ 새 의뢰</button></div>
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
  <div class="head-row"><h2>내가 보낸 의뢰 <span class="hint">(진행 중 ${open.length}건)</span></h2><button class="primary" data-action="new-job">+ 새 의뢰</button></div>
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

export function renderJobDetail(state, job, urls = {}) {
  const { me, profiles, projects, attachments, comments, jobs } = state;
  const isAdmin = !!me.is_admin;
  const isReq = job.requester_id === me.id;
  const isAsg = job.assignee_id === me.id;
  const open = ['waiting', 'in_progress'].includes(job.status);
  const pos = queuePosition(job, jobs);
  const atts = (kind) => attachments.filter(a => a.job_id === job.id && a.kind === kind);
  const fileList = (kind) => {
    const list = atts(kind);
    if (!list.length) return '<div class="hint">없음</div>';
    return `<ul class="files">${list.map(a => `<li>
      ${urls[a.id] ? `<a href="${urls[a.id]}" target="_blank" rel="noopener">${esc(a.filename)}</a>` : esc(a.filename)}
      <span class="hint">(${(a.size_bytes / 1048576).toFixed(1)} MB)</span>
      ${(a.uploader_id === me.id || isAdmin) ? `<button class="danger" style="padding:2px 8px;margin-left:6px" data-action="att-delete" data-id="${a.id}">삭제</button>` : ''}
    </li>`).join('')}</ul>`;
  };
  const canUploadReq = (isReq && job.status === 'waiting') || isAdmin;
  const canUploadRes = (isAsg && job.status !== 'rejected' && job.status !== 'cancelled') || isAdmin;
  const cs = comments.filter(c => c.job_id === job.id);

  // 진행상황: 담당자(또는 관리자)는 현재 상태와 관계없이 언제든 네 가지 중 하나를 고를 수 있다.
  const STATUS_BUTTONS = [
    ['waiting', 'job-wait', '대기'],
    ['in_progress', 'job-start', '진행중'],
    ['done', 'job-done', '완료'],
    ['rejected', 'job-reject', '반려'],
  ];
  const canStatus = isAsg || isAdmin;
  const statusButtons = STATUS_BUTTONS.map(([st, action, label]) => {
    const cur = job.status === st;
    return `<button class="${cur ? 'primary' : ''}" data-action="${action}"${cur ? ' aria-current="true"' : ''}>${label}</button>`;
  }).join('');

  const manage = [];
  if ((isReq || isAdmin) && job.status === 'waiting') manage.push('<button data-action="job-edit">내용 수정</button>', '<button class="danger" data-action="job-cancel">의뢰 취소</button>');
  if (canStatus) manage.push('<button data-action="job-eta">예상 마무리 시간</button>', '<button data-action="job-handoff">담당자 넘기기</button>');
  if (isAdmin) manage.push('<button class="danger" data-action="job-delete">삭제</button>');

  return `
  <button class="close" data-action="close-modal">✕</button>
  <h3>${URGENCY_EMOJI[job.urgency]} ${esc(job.title)}</h3>
  <span class="badge ${job.status}">${STATUS_LABELS[job.status]}</span>
  ${pos ? `<span class="hint"> · ${esc(displayName(job.assignee_id, profiles))} 큐 ${pos}번째</span>` : ''}
  <dl class="kv">
    <dt>프로젝트</dt><dd>#${esc(projectName(job.project_id, projects))}</dd>
    <dt>의뢰 → 담당</dt><dd>${esc(displayName(job.requester_id, profiles))} → ${esc(displayName(job.assignee_id, profiles))}</dd>
    <dt>마감</dt><dd class="${isOverdue(job) ? 'deadline over' : ''}">${job.deadline ? formatDateTime(job.deadline) : '없음'}</dd>
    <dt>예상 마무리</dt><dd>${job.eta ? formatDateTime(job.eta) : '미정'}</dd>
    <dt>생성</dt><dd>${formatDateTime(job.created_at)}</dd>
    ${job.started_at ? `<dt>시작</dt><dd>${formatDateTime(job.started_at)}</dd>` : ''}
    ${job.finished_at ? `<dt>종료</dt><dd>${formatDateTime(job.finished_at)}</dd>` : ''}
    ${job.seraph_path ? `<dt>seraph</dt><dd><code>${esc(job.seraph_path)}</code></dd>` : ''}
  </dl>
  ${job.body ? `<div class="body-text">${esc(job.body)}</div>` : ''}
  ${job.status === 'rejected' ? `<div class="body-text" style="background:#fee2e2"><b>반려 사유:</b> ${esc(job.reject_reason)}</div>` : ''}
  ${job.status === 'done' && job.result_note ? `<div class="body-text" style="background:#dcfce7"><b>완료 메모:</b> ${esc(job.result_note)}</div>` : ''}

  <h4>의뢰 첨부</h4>${fileList('request')}
  ${canUploadReq ? '<input type="file" multiple data-action="att-upload" data-kind="request">' : ''}
  <h4>결과 첨부</h4>${fileList('result')}
  ${canUploadRes ? '<input type="file" multiple data-action="att-upload" data-kind="result">' : ''}

  ${canStatus ? `<h4>진행상황</h4><div class="actions status-actions">${statusButtons}</div>` : ''}
  ${manage.length ? `<h4>의뢰 관리</h4><div class="actions">${manage.join('')}</div>` : ''}
  <div id="inline-form"></div>

  <h4>댓글 ${cs.length}</h4>
  <ul class="comments">${cs.map(c => `<li>
    <span class="who">${esc(displayName(c.author_id, profiles))}</span><span class="when">${formatDateTime(c.created_at)}</span>
    ${(c.author_id === me.id || isAdmin) ? `<button style="padding:0 6px;margin-left:6px;font-size:11px" data-action="comment-delete" data-id="${c.id}">삭제</button>` : ''}
    <div class="text">${esc(c.body)}</div></li>`).join('')}</ul>
  <form data-form="comment" class="inline"><textarea name="body" required placeholder="댓글"></textarea><button class="primary">등록</button></form>`;
}

export function inlineForm(kind, state, job) {
  if (kind === 'done') return `<form data-form="done"><label>완료 메모 (선택)</label><textarea name="result_note"></textarea><div class="actions"><button class="primary">완료 처리</button></div></form>`;
  if (kind === 'reject') return `<form data-form="reject"><label>반려 사유 *</label><textarea name="reject_reason" required></textarea><div class="actions"><button class="danger">반려</button></div></form>`;
  if (kind === 'eta') {
    const cur = job.eta ? toLocalInput(job.eta) : '';
    return `<form data-form="eta"><label>예상 마무리 (담당자가 적습니다)</label><input type="datetime-local" name="eta" value="${cur}"><div class="actions"><button class="primary">저장</button><button type="button" data-action="job-eta-clear">지우기</button></div></form>`;
  }
  if (kind === 'handoff') {
    const people = state.profiles.filter(p => p.id !== job.assignee_id).map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    return `<form data-form="handoff"><label>넘길 사람</label><select name="assignee_id">${people}</select><div class="actions"><button class="primary">넘기기 (그 사람 큐 맨 뒤로)</button></div></form>`;
  }
  return '';
}

export function renderProjectsModal(state) {
  const ownerId = state.assigneeId;
  const owner = ownerId == null ? null : state.profiles.find(p => p.id === ownerId);
  const items = projectsFor(state.projects, ownerId).map(p => {
    const n = state.jobs.filter(j => j.project_id === p.id).length;
    const locked = p.id === UNCATEGORIZED_ID;
    const mine = p.owner_id === state.me.id || state.me.is_admin;
    return `<li><span class="name">#${esc(p.name)} <span class="hint">(${n}건)</span></span>
      ${locked ? '<span class="hint">고정</span>'
        : mine ? `<button data-action="project-rename" data-id="${p.id}" data-name="${esc(p.name)}">이름 변경</button><button class="danger" data-action="project-delete" data-id="${p.id}" data-name="${esc(p.name)}">삭제</button>`
        : '<span class="hint">주인만 수정할 수 있습니다</span>'}</li>`;
  }).join('');
  return `
  <button class="close" data-action="close-modal">✕</button>
  <h3>${owner ? esc(owner.name) + '의 프로젝트 키워드' : '프로젝트 키워드'}</h3>
  <p class="hint">키워드는 담당자에게 속합니다. 여기 목록은 상단에서 선택한 사람의 것입니다. 이름 변경·삭제는 주인과 관리자만 할 수 있고, 삭제하면 그 키워드의 의뢰는 #미분류로 옮겨집니다.</p>
  <ul class="list-manage">${items}</ul>
  ${owner ? `<form data-form="project-add" class="inline" style="margin-top:12px"><input name="name" required maxlength="40" placeholder="${esc(owner.name)}의 새 키워드"><button class="primary">추가</button></form>` : '<div class="hint">미배정에는 키워드를 추가할 수 없습니다.</div>'}`;
}

export function renderAdminModal(state) {
  const rows = state.profiles.map(p => {
    const recv = state.jobs.filter(j => j.assignee_id === p.id).length;
    const sent = state.jobs.filter(j => j.requester_id === p.id).length;
    const self = p.id === state.me.id;
    return `<li><span class="name">${esc(p.name)}${p.is_admin ? ' 👑' : ''} <span class="hint">가입 ${formatDateTime(p.created_at)} · 받은 ${recv} · 보낸 ${sent}</span></span>
      ${self ? '<span class="hint">나</span>' : `<button class="danger" data-action="user-delete" data-id="${p.id}" data-name="${esc(p.name)}">삭제</button>`}</li>`;
  }).join('');
  return `
  <button class="close" data-action="close-modal">✕</button>
  <h3>관리</h3>
  <p class="hint">사용자를 삭제해도 의뢰·댓글은 남고 이름만 "탈퇴자"로 표시됩니다. 비밀번호 초기화는 Supabase 대시보드 → Authentication → Users에서 합니다.</p>
  <ul class="list-manage">${rows}</ul>`;
}

export function projectOptions(projects, ownerId, selectedId) {
  return projectsFor(projects, ownerId)
    .map(p => `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>${esc(p.name)}</option>`).join('');
}

export function renderJobForm(state, job = null) {
  const { profiles, projects, me } = state;
  const v = job || { assignee_id: me.id, project_id: UNCATEGORIZED_ID, title: '', body: '', urgency: 3, deadline: null, seraph_path: '' };
  const people = profiles.map(p => `<option value="${p.id}" ${p.id === v.assignee_id ? 'selected' : ''}>${esc(p.name)}${p.id === me.id ? ' (나)' : ''}</option>`).join('');
  const projs = projectOptions(projects, v.assignee_id, v.project_id);
  const urg = [1, 2, 3, 4, 5].map(n => `<label style="display:inline-flex;align-items:center;gap:4px;margin:0 10px 0 0;font-size:18px"><input type="radio" name="urgency" value="${n}" ${n === v.urgency ? 'checked' : ''} style="width:auto">${URGENCY_EMOJI[n]}</label>`).join('');
  return `
  <button class="close" data-action="close-modal">✕</button>
  <h3>${job ? '의뢰 수정' : '새 의뢰'}</h3>
  <form data-form="job" data-id="${job ? job.id : ''}">
    <label>담당자</label><select name="assignee_id" data-action="job-form-assignee">${people}</select>
    <label>프로젝트</label>
    <div class="inline"><select name="project_id" id="job-project-select">${projs}</select><input name="new_project" placeholder="새 키워드 (입력 시 우선)" maxlength="40"></div>
    <div class="hint">키워드는 담당자에게 속합니다. 담당자를 바꾸면 목록도 바뀝니다.</div>
    <label>제목 *</label><input name="title" required maxlength="200" value="${esc(v.title)}">
    <label>내용</label><textarea name="body">${esc(v.body)}</textarea>
    <label>긴급도</label><div>${urg}</div>
    <label>마감 (선택)</label><input type="datetime-local" name="deadline" value="${toLocalInput(v.deadline)}">
    <label>seraph 경로 (대용량은 여기)</label><input name="seraph_path" value="${esc(v.seraph_path)}" placeholder="/nas/…">
    <label>첨부 (각 20MB 이하)</label><input type="file" name="files" multiple>
    <div class="actions"><button class="primary">${job ? '저장' : '의뢰 제출'}</button><button type="button" data-action="close-modal">닫기</button></div>
  </form>`;
}
