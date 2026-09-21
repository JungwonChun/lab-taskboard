import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  nameToPassword,
  MAX_FILE_BYTES, UNCATEGORIZED_ID, URGENCY_EMOJI, STATUS_LABELS,
  validateName, nameToEmail, emailToName, isOpen, isOverdue,
  sortQueue, sortPast, queuePosition, validateFiles, formatDateTime,
  translateAuthError, translateDbError, displayName,
} from '../src/lib.js';

test('constants', () => {
  assert.equal(MAX_FILE_BYTES, 20971520);
  assert.equal(UNCATEGORIZED_ID, '00000000-0000-0000-0000-000000000000');
  assert.deepEqual(URGENCY_EMOJI, { 1: '😌', 2: '🙂', 3: '😐', 4: '😟', 5: '🥵' });
  assert.equal(STATUS_LABELS.in_progress, '진행중');
});

test('validateName strips whitespace and bounds length', () => {
  assert.deepEqual(validateName(' 천 정원 '), { ok: true, name: '천정원' });
  assert.equal(validateName('   ').ok, false);
  assert.equal(validateName('a'.repeat(21)).ok, false);
  assert.deepEqual(validateName('a'.repeat(20)), { ok: true, name: 'a'.repeat(20) });
});

test('nameToEmail round-trips Korean names', () => {
  const email = nameToEmail('천정원');
  assert.match(email, /^u-[0-9a-f]+@board\.local$/);
  assert.equal(emailToName(email), '천정원');
  assert.equal(nameToEmail('ab'), 'u-6162@board.local');
});

const P = { a: 'aaaaaaaa-0000-0000-0000-000000000001', b: 'aaaaaaaa-0000-0000-0000-000000000002' };
const mk = (over) => ({
  id: over.id, assignee_id: P.a, requester_id: P.b, status: 'waiting',
  queued_at: '2026-09-21T00:00:00Z', finished_at: null, deadline: null, ...over,
});

test('isOpen / isOverdue', () => {
  assert.equal(isOpen(mk({ id: '1' })), true);
  assert.equal(isOpen(mk({ id: '1', status: 'done' })), false);
  const now = new Date('2026-09-21T12:00:00Z');
  assert.equal(isOverdue(mk({ id: '1', deadline: '2026-09-21T11:00:00Z' }), now), true);
  assert.equal(isOverdue(mk({ id: '1', deadline: '2026-09-21T13:00:00Z' }), now), false);
  assert.equal(isOverdue(mk({ id: '1', deadline: '2026-09-21T11:00:00Z', status: 'done' }), now), false);
  assert.equal(isOverdue(mk({ id: '1' }), now), false);
});

test('sortQueue orders open jobs FIFO by queued_at then id, for one assignee', () => {
  const jobs = [
    mk({ id: '3', queued_at: '2026-09-21T02:00:00Z' }),
    mk({ id: '1', queued_at: '2026-09-21T01:00:00Z', status: 'in_progress' }),
    mk({ id: '9', queued_at: '2026-09-21T01:00:00Z', status: 'done' }),
    mk({ id: '2', queued_at: '2026-09-21T01:00:00Z' }),
    mk({ id: '4', queued_at: '2026-09-21T00:00:00Z', assignee_id: P.b }),
  ];
  assert.deepEqual(sortQueue(jobs, P.a).map(j => j.id), ['1', '2', '3']);
  assert.deepEqual(sortQueue(jobs, P.b).map(j => j.id), ['4']);
});

test('sortQueue(jobs, null) returns only null-assignee open jobs', () => {
  const jobs = [
    mk({ id: '1', assignee_id: null, queued_at: '2026-09-21T01:00:00Z' }),
    mk({ id: '2', assignee_id: null, queued_at: '2026-09-21T02:00:00Z', status: 'done' }),
    mk({ id: '3', queued_at: '2026-09-21T00:00:00Z' }),
    mk({ id: '4', assignee_id: null, queued_at: '2026-09-21T00:30:00Z' }),
  ];
  assert.deepEqual(sortQueue(jobs, null).map(j => j.id), ['4', '1']);
});

test('sortPast returns closed jobs newest finished first', () => {
  const jobs = [
    mk({ id: '1', status: 'done', finished_at: '2026-09-20T00:00:00Z' }),
    mk({ id: '2', status: 'rejected', finished_at: '2026-09-21T00:00:00Z' }),
    mk({ id: '3' }),
  ];
  assert.deepEqual(sortPast(jobs, P.a).map(j => j.id), ['2', '1']);
});

test('queuePosition is 1-based among open jobs of same assignee; null when closed', () => {
  const jobs = [
    mk({ id: '1', queued_at: '2026-09-21T01:00:00Z' }),
    mk({ id: '2', queued_at: '2026-09-21T02:00:00Z', status: 'in_progress' }),
    mk({ id: '3', queued_at: '2026-09-21T03:00:00Z' }),
    mk({ id: '4', queued_at: '2026-09-21T00:00:00Z', status: 'done' }),
  ];
  assert.equal(queuePosition(jobs[2], jobs), 3);
  assert.equal(queuePosition(jobs[0], jobs), 1);
  assert.equal(queuePosition(jobs[3], jobs), null);
});

test('validateFiles flags > 20MB', () => {
  const r = validateFiles([{ name: 'ok.zip', size: MAX_FILE_BYTES }, { name: 'big.mp4', size: MAX_FILE_BYTES + 1 }]);
  assert.deepEqual(r, { ok: false, tooLarge: ['big.mp4'] });
  assert.deepEqual(validateFiles([]), { ok: true, tooLarge: [] });
});

test('formatDateTime', () => {
  assert.equal(formatDateTime(null), '');
  assert.match(formatDateTime('2026-09-21T03:04:00Z'), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('nameToPassword is deterministic, name-specific and long enough', () => {
  const a = nameToPassword('천정원');
  assert.equal(a, nameToPassword('천정원'));
  assert.notEqual(a, nameToPassword('김철수'));
  assert.ok(a.length >= 6);
});

test('translateAuthError', () => {
  assert.equal(translateAuthError('User already registered'), '이미 있는 이름입니다');
  assert.equal(translateAuthError('Invalid login credentials'), '이름 또는 비밀번호가 틀렸습니다');
  assert.equal(translateAuthError('Password should be at least 6 characters'), '비밀번호는 6자 이상이어야 합니다');
  assert.equal(translateAuthError('weird'), 'weird');
});

test('translateDbError', () => {
  assert.equal(translateDbError('not allowed', null), '권한이 없습니다');
  assert.equal(translateDbError('invalid status transition', null), '권한이 없습니다');
  assert.equal(translateDbError('assignee may only change status', null), '권한이 없습니다');
  assert.equal(translateDbError('anything', '42501'), '권한이 없습니다');
  assert.equal(translateDbError('reject_reason required', null), '반려 사유를 입력하세요');
  assert.equal(translateDbError('anything', '23514'), '반려 사유를 입력하세요');
  assert.equal(translateDbError('duplicate key value violates unique constraint', null), '이미 있는 이름입니다');
  assert.equal(translateDbError('anything', '23505'), '이미 있는 이름입니다');
  assert.equal(translateDbError('anything', '23503'), '참조된 항목이 있어 처리할 수 없습니다');
  assert.equal(translateDbError('some other message', null), 'some other message');
});

test('displayName falls back to 탈퇴자', () => {
  const profiles = [{ id: P.a, name: '천정원' }];
  assert.equal(displayName(P.a, profiles), '천정원');
  assert.equal(displayName(P.b, profiles), '탈퇴자');
  assert.equal(displayName(null, profiles), '탈퇴자');
});
