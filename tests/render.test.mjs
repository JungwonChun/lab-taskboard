// 화면 함수를 실제로 호출해 본다. import 누락이나 오타는 여기서 바로 잡힌다
// (실제 브라우저를 띄우는 tests/ui.smoke.mjs 와 달리 몇 밀리초면 끝난다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderAuth, renderShell, renderDashboard, renderQueue, renderSent,
  renderJobDetail, renderJobForm, renderProjectsModal, renderAdminModal, inlineForm,
} from '../src/ui.js';
import { UNCATEGORIZED_ID } from '../src/lib.js';

const ME = { id: 'u1', name: '천정원', is_admin: true, created_at: '2026-09-21T00:00:00Z' };
const OTHER = { id: 'u2', name: '김철수', is_admin: false, created_at: '2026-09-21T00:00:00Z' };
const JOB = {
  id: 'j1', requester_id: 'u2', assignee_id: 'u1', project_id: UNCATEGORIZED_ID,
  title: '테스트 <b>제목</b>', body: '내용', urgency: 5,
  deadline: '2026-09-25T09:00:00Z', eta: '2026-09-24T09:30:00Z', seraph_path: '/nas/x',
  status: 'in_progress', reject_reason: '', result_note: '',
  created_at: '2026-09-21T00:00:00Z', queued_at: '2026-09-21T00:00:00Z',
  started_at: '2026-09-21T01:00:00Z', finished_at: null,
};
const state = {
  me: ME, profiles: [ME, OTHER], projects: [{ id: UNCATEGORIZED_ID, name: '미분류', owner_id: null }],
  jobs: [JOB], attachments: [], comments: [{ id: 'c1', job_id: 'j1', author_id: 'u1', body: '댓글', created_at: '2026-09-21T02:00:00Z' }],
  view: 'dashboard', assigneeId: 'u1', projectFilter: 'all',
};

const ok = (name, html) => {
  assert.equal(typeof html, 'string', `${name} must return a string`);
  assert.ok(html.length > 0, `${name} must not be empty`);
  assert.ok(!html.includes('undefined'), `${name} rendered the literal "undefined"`);
};

test('모든 화면 함수가 오류 없이 렌더된다', () => {
  ok('renderAuth', renderAuth('login', ''));
  ok('renderAuth signup', renderAuth('signup', '오류'));
  ok('renderDashboard', renderDashboard(state));
  ok('renderQueue', renderQueue(state));
  ok('renderSent', renderSent(state));
  ok('renderShell', renderShell(state, '<div></div>'));
  ok('renderJobDetail', renderJobDetail(state, JOB, {}));
  ok('renderJobForm new', renderJobForm(state));
  ok('renderJobForm edit', renderJobForm(state, JOB));
  ok('renderProjectsModal', renderProjectsModal(state));
  ok('renderAdminModal', renderAdminModal(state));
  for (const k of ['done', 'reject', 'handoff', 'eta']) ok(`inlineForm ${k}`, inlineForm(k, state, JOB));
});

test('모든 상태와 역할 조합에서도 렌더된다', () => {
  for (const status of ['waiting', 'in_progress', 'done', 'rejected', 'cancelled']) {
    for (const me of [ME, OTHER, { ...OTHER, id: 'u3', name: '제삼자' }]) {
      const s = { ...state, me, profiles: [ME, OTHER] };
      ok(`detail ${status}/${me.name}`, renderJobDetail(s, { ...JOB, status }, {}));
    }
  }
  ok('미배정 큐', renderQueue({ ...state, assigneeId: null, jobs: [{ ...JOB, assignee_id: null, status: 'waiting' }] }));
  ok('빈 대시보드', renderDashboard({ ...state, jobs: [] }));
  ok('사용자 삭제됨', renderQueue({ ...state, jobs: [{ ...JOB, requester_id: null, status: 'waiting' }] }));
});

test('사용자 입력은 HTML 로 새어나가지 않는다', () => {
  const nasty = '<img src=x onerror=alert(1)>';
  const html = renderJobDetail(state, { ...JOB, title: nasty, body: nasty, seraph_path: nasty }, {});
  assert.ok(!html.includes('<img src=x'), 'title/body/seraph_path must be escaped');
  assert.ok(html.includes('&lt;img'), 'expected escaped markup');
});
