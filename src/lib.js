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
