export const MAX_FILE_BYTES = 20971520;
export const EMAIL_DOMAIN = 'board.local';
export const UNCATEGORIZED_ID = '00000000-0000-0000-0000-000000000000';
export const URGENCY_EMOJI = { 1: '😌', 2: '🙂', 3: '😐', 4: '😟', 5: '🥵' };
export const STATUS_LABELS = {
  waiting: '대기', in_progress: '진행중', done: '완료', rejected: '반려', cancelled: '취소',
};
export const OPEN_STATUSES = ['waiting', 'in_progress'];

export function validateName(raw) {
  const name = String(raw ?? '').replace(/\s+/g, '');
  if (name.length < 1) return { ok: false, error: '이름을 입력하세요' };
  if (name.length > 20) return { ok: false, error: '이름은 20자 이내여야 합니다' };
  return { ok: true, name };
}

export function nameToEmail(name) {
  const hex = Array.from(new TextEncoder().encode(name))
    .map(b => b.toString(16).padStart(2, '0')).join('');
  return `u-${hex}@${EMAIL_DOMAIN}`;
}

// 이름만으로 로그인한다. Supabase Auth 는 비밀번호를 요구하므로 이름에서 결정적으로 만들어 쓴다.
// 이 규칙은 공개된 스크립트에 있으므로 비밀이 아니다. 이름을 아는 사람은 누구나 그 계정으로 들어올 수 있다.
export function nameToPassword(name) {
  return `lab-taskboard:${nameToEmail(name)}`;
}

export function emailToName(email) {
  const m = /^u-([0-9a-f]+)@/.exec(email || '');
  if (!m) return '';
  const bytes = new Uint8Array(m[1].match(/../g).map(h => parseInt(h, 16)));
  return new TextDecoder().decode(bytes);
}

export function isOpen(job) {
  return OPEN_STATUSES.includes(job.status);
}

export function isOverdue(job, now = new Date()) {
  return Boolean(job.deadline) && isOpen(job) && new Date(job.deadline) < now;
}

function fifo(a, b) {
  return a.queued_at < b.queued_at ? -1 : a.queued_at > b.queued_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function sortQueue(jobs, assigneeId) {
  return jobs.filter(j => j.assignee_id === assigneeId && isOpen(j)).sort(fifo);
}

export function sortPast(jobs, assigneeId) {
  return jobs
    .filter(j => j.assignee_id === assigneeId && !isOpen(j))
    .sort((a, b) => String(b.finished_at || '').localeCompare(String(a.finished_at || '')));
}

export function queuePosition(job, jobs) {
  if (!isOpen(job)) return null;
  const q = sortQueue(jobs, job.assignee_id);
  const idx = q.findIndex(j => j.id === job.id);
  return idx < 0 ? null : idx + 1;
}

export function validateFiles(files) {
  const tooLarge = Array.from(files).filter(f => f.size > MAX_FILE_BYTES).map(f => f.name);
  return { ok: tooLarge.length === 0, tooLarge };
}

export function formatDateTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const AUTH_MESSAGES = [
  [/already registered|already exists|duplicate key/i, '이미 있는 이름입니다'],
  [/invalid login credentials/i, '이름 또는 비밀번호가 틀렸습니다'],
  [/at least 6 characters/i, '비밀번호는 6자 이상이어야 합니다'],
];
export function translateAuthError(message) {
  const hit = AUTH_MESSAGES.find(([re]) => re.test(message || ''));
  return hit ? hit[1] : (message || '알 수 없는 오류');
}

const DB_ERROR_MESSAGES = [
  [/42501/, /not allowed|may only|may not|invalid status transition|admin only/i, '권한이 없습니다'],
  [/23514/, /reject_reason/i, '반려 사유를 입력하세요'],
  [/23505/, /duplicate key/i, '이미 있는 이름입니다'],
  [/23503/, null, '참조된 항목이 있어 처리할 수 없습니다'],
];
export function translateDbError(message, code) {
  const c = String(code || '');
  const m = String(message || '');
  for (const [codeRe, msgRe, translated] of DB_ERROR_MESSAGES) {
    if (codeRe.test(c) || (msgRe && msgRe.test(m))) return translated;
  }
  return message;
}

export function displayName(profileId, profiles) {
  const p = profileId && profiles.find(x => x.id === profileId);
  return p ? p.name : '탈퇴자';
}

// 주어진 의뢰 묶음의 상태별 건수. 대시보드의 '내 태스크'와 '연구실 전체'가 같은 셈법을 쓴다.
export function statusCounts(jobs) {
  return {
    waiting: jobs.filter((j) => j.status === 'waiting').length,
    in_progress: jobs.filter((j) => j.status === 'in_progress').length,
    done: jobs.filter((j) => j.status === 'done').length,
  };
}

// ───────── 대시보드 집계 ─────────
// 큐에 쌓인 일(대기), 손에 잡은 일(진행중), 끝낸 일(완료) 세 가지가 핵심 숫자다.
export function dashboardStats(jobs, profiles) {
  const count = (f) => jobs.filter(f).length;
  const now = new Date();
  const perPerson = profiles.map((p) => ({
    id: p.id,
    name: p.name,
    waiting: count((j) => j.assignee_id === p.id && j.status === 'waiting'),
    in_progress: count((j) => j.assignee_id === p.id && j.status === 'in_progress'),
    done: count((j) => j.assignee_id === p.id && j.status === 'done'),
    overdue: count((j) => j.assignee_id === p.id && isOverdue(j, now)),
  }));
  // 일이 없는 사람도 표에 남긴다 — 새로 가입하면 바로 보여야 한다.
  perPerson.sort((a, b) => (b.waiting + b.in_progress) - (a.waiting + a.in_progress) || a.name.localeCompare(b.name));
  // 담당자가 지워진 의뢰는 어느 사람 줄에도 안 들어간다. 그대로 두면 표 합계가
  // 위 타일과 어긋나므로, 있을 때만 '미배정' 줄을 맨 뒤에 붙인다.
  const orphan = {
    id: null,
    name: '미배정',
    waiting: count((j) => j.assignee_id == null && j.status === 'waiting'),
    in_progress: count((j) => j.assignee_id == null && j.status === 'in_progress'),
    done: count((j) => j.assignee_id == null && j.status === 'done'),
    overdue: count((j) => j.assignee_id == null && isOverdue(j, now)),
  };
  if (orphan.waiting + orphan.in_progress + orphan.done > 0) perPerson.push(orphan);
  return {
    waiting: count((j) => j.status === 'waiting'),
    in_progress: count((j) => j.status === 'in_progress'),
    done: count((j) => j.status === 'done'),
    rejected: count((j) => j.status === 'rejected'),
    overdue: count((j) => isOverdue(j, now)),
    unassigned: count((j) => j.assignee_id == null && isOpen(j)),
    perPerson,
  };
}

// 큐 줄에 쓰는 짧은 날짜: "9/21 15:00"
export function formatShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
