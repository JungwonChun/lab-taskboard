import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { newUser, cleanup, uniq, admin, promote } from './helpers.mjs';
import { UNCATEGORIZED_ID } from '../src/lib.js';
import { createApi } from '../src/api.js';

const created = [];
after(async () => { await cleanup(created); });

test('signup creates a profile row with the given name', async () => {
  const name = uniq('스모크');
  const { client, user } = await newUser(name);
  created.push(user.id);
  const { data, error } = await client.from('profiles').select('*').eq('id', user.id).single();
  assert.equal(error, null);
  assert.equal(data.name, name);
  assert.equal(data.is_admin, false);
});

test('미분류 project is seeded and protected', async () => {
  const { client, user } = await newUser(uniq('시드'));
  created.push(user.id);
  const { data } = await client.from('projects').select('*').eq('id', UNCATEGORIZED_ID).single();
  assert.equal(data.name, '미분류');
  const del = await client.from('projects').delete().eq('id', UNCATEGORIZED_ID).select();
  assert.deepEqual(del.data, []); // RLS: nothing deleted
  const { data: still } = await admin().from('projects').select('id').eq('id', UNCATEGORIZED_ID);
  assert.equal(still.length, 1);
});

test('attachments bucket exists with 20MB limit', async () => {
  const { data } = await admin().storage.getBucket('attachments');
  assert.equal(data.public, false);
  assert.equal(Number(data.file_size_limit), 20971520);
});

async function pair() {
  const A = await newUser(uniq('의뢰'));
  const B = await newUser(uniq('담당'));
  created.push(A.user.id, B.user.id);
  return { A, B, apiA: createApi(A.client), apiB: createApi(B.client) };
}

test('requester creates job → assignee queue position 1; requester cannot start it', async () => {
  const { A, B, apiA, apiB } = await pair();
  const job = await apiA.createJob({ assignee_id: B.user.id, title: '첫 일', urgency: 4 });
  assert.equal(job.status, 'waiting');
  assert.equal(job.requester_id, A.user.id);
  await assert.rejects(apiA.startJob(job.id), /not allowed|invalid status|42501/i);
  const started = await apiB.startJob(job.id);
  assert.equal(started.status, 'in_progress');
  assert.ok(started.started_at);
});

test('assignee: done allowed; rejected without reason refused; reason required', async () => {
  const { B, apiA, apiB } = await pair();
  const j1 = await apiA.createJob({ assignee_id: B.user.id, title: '완료될 일' });
  const done = await apiB.finishJob(j1.id, '결과 메모');
  assert.equal(done.status, 'done');
  assert.equal(done.result_note, '결과 메모');
  assert.ok(done.finished_at);
  const j2 = await apiA.createJob({ assignee_id: B.user.id, title: '반려될 일' });
  await assert.rejects(apiB.rejectJob(j2.id, '   '), /reject_reason|23514/i);
  const rej = await apiB.rejectJob(j2.id, '범위 밖');
  assert.equal(rej.status, 'rejected');
  assert.equal(rej.reject_reason, '범위 밖');
});

test('requester may edit/cancel only while waiting; assignee may not edit content', async () => {
  const { B, apiA, apiB } = await pair();
  const job = await apiA.createJob({ assignee_id: B.user.id, title: '수정 전' });
  const edited = await apiA.updateJob(job.id, { title: '수정 후', urgency: 5 });
  assert.equal(edited.title, '수정 후');
  await assert.rejects(apiB.updateJob(job.id, { title: '담당자 수정' }), /assignee may only|42501/i);
  await apiB.startJob(job.id);
  await assert.rejects(apiA.updateJob(job.id, { title: '진행중 수정' }), /not allowed|42501/i);
  await assert.rejects(apiA.cancelJob(job.id), /not allowed|42501/i);
  const j2 = await apiA.createJob({ assignee_id: B.user.id, title: '취소될 일' });
  const cancelled = await apiA.cancelJob(j2.id);
  assert.equal(cancelled.status, 'cancelled');
});

test('handoff moves job to end of new assignee queue and resets queued_at', async () => {
  const { A, B, apiA, apiB } = await pair();
  const C = await newUser(uniq('제삼'));
  created.push(C.user.id);
  const first = await apiA.createJob({ assignee_id: C.user.id, title: 'C의 기존 일' });
  const job = await apiA.createJob({ assignee_id: B.user.id, title: '넘길 일' });
  await apiB.startJob(job.id);
  const moved = await apiB.handoffJob(job.id, C.user.id);
  assert.equal(moved.assignee_id, C.user.id);
  assert.equal(moved.status, 'waiting');
  assert.equal(moved.started_at, null);
  assert.ok(new Date(moved.queued_at) > new Date(first.queued_at));
  await assert.rejects(apiB.startJob(job.id), /not allowed|42501/i); // B no longer assignee
});

test('non-party user cannot touch the job; admin can delete', async () => {
  const { B, apiA } = await pair();
  const X = await newUser(uniq('무관'));
  created.push(X.user.id);
  const apiX = createApi(X.client);
  const job = await apiA.createJob({ assignee_id: B.user.id, title: '남의 일' });
  // RLS using() hides the row from update → 0 rows → our wrapper throws
  await assert.rejects(apiX.startJob(job.id));
  await assert.rejects(apiX.deleteJob(job.id));
  await promote(X.user.id);
  await apiX.deleteJob(job.id);
  const { data } = await admin().from('jobs').select('id').eq('id', job.id);
  assert.equal(data.length, 0);
});

test('deleting a project moves its jobs to 미분류; 미분류 cannot be renamed', async () => {
  const { B, apiA } = await pair();
  const proj = await apiA.addProject(uniq('프로젝트'));
  const job = await apiA.createJob({ assignee_id: B.user.id, title: '프로젝트 일', project_id: proj.id });
  assert.equal(job.project_id, proj.id);
  await apiA.deleteProject(proj.id);
  const { data } = await admin().from('jobs').select('project_id').eq('id', job.id).single();
  assert.equal(data.project_id, UNCATEGORIZED_ID);
  await assert.rejects(apiA.renameProject(UNCATEGORIZED_ID, '다른이름'));
});

test('comments: anyone adds, only author/admin deletes', async () => {
  const { B, apiA } = await pair();
  const X = await newUser(uniq('댓글'));
  created.push(X.user.id);
  const apiX = createApi(X.client);
  const job = await apiA.createJob({ assignee_id: B.user.id, title: '댓글 일' });
  const c = await apiX.addComment(job.id, '지나가다 한마디');
  await assert.rejects(apiA.deleteComment(c.id));
  await apiX.deleteComment(c.id);
  const { data } = await admin().from('comments').select('id').eq('id', c.id);
  assert.equal(data.length, 0);
});

test('attachments: requester uploads request file while waiting; assignee uploads result; others refused', async () => {
  const { B, apiA, apiB } = await pair();
  const X = await newUser(uniq('업로드'));
  created.push(X.user.id);
  const apiX = createApi(X.client);
  const job = await apiA.createJob({ assignee_id: B.user.id, title: '첨부 일' });
  const file = new File([new Uint8Array([1, 2, 3])], '데이터.bin', { type: 'application/octet-stream' });
  const att = await apiA.uploadAttachment(job.id, 'request', file);
  assert.equal(att.filename, '데이터.bin');
  assert.equal(att.kind, 'request');
  assert.match(att.storage_path, new RegExp(`^${job.id}/request/[0-9a-f-]+\\.bin$`));
  await assert.rejects(apiX.uploadAttachment(job.id, 'request', file));
  await assert.rejects(apiB.uploadAttachment(job.id, 'request', file));
  const res = await apiB.uploadAttachment(job.id, 'result', file);
  assert.equal(res.kind, 'result');
  const url = await apiA.attachmentUrl(res.storage_path);
  assert.match(url, /attachments/);
  await apiB.deleteAttachment(res);
  const { data: left } = await admin().storage.from('attachments').list(`${job.id}/result`);
  assert.equal((left || []).length, 0, 'storage object must be removed too');
});

test('admin_delete_user removes auth user; non-admin refused', async () => {
  const { A, B, apiA } = await pair();
  await assert.rejects(apiA.adminDeleteUser(B.user.id), /admin only|42501/i);
  await promote(A.user.id);
  await apiA.adminDeleteUser(B.user.id);
  const { data } = await admin().from('profiles').select('id').eq('id', B.user.id);
  assert.equal(data.length, 0);
});
