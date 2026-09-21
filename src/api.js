import { nameToEmail, MAX_FILE_BYTES, translateDbError } from './lib.js';

function must({ data, error }, what) {
  if (error) {
    const e = new Error(`${what}: ${translateDbError(error.message, error.code)}`);
    e.code = error.code;
    throw e;
  }
  return data;
}
function mustRow(res, what) {
  const data = must(res, what);
  if (!data) throw new Error(`${what}: 권한이 없거나 대상이 없습니다`);
  return data;
}
function ext(name) {
  const m = /\.([A-Za-z0-9]{1,10})$/.exec(name || '');
  return m ? m[1].toLowerCase() : 'bin';
}

export function createApi(client) {
  const uid = async () => (await client.auth.getSession()).data.session?.user?.id ?? null;

  async function updateJob(id, patch) {
    const res = await client.from('jobs').update(patch).eq('id', id).select().maybeSingle();
    return mustRow(res, '의뢰 갱신');
  }

  return {
    // ── auth ──
    async signUp(name, password) {
      return must(await client.auth.signUp({
        email: nameToEmail(name), password, options: { data: { name } },
      }), '가입');
    },
    async signIn(name, password) {
      return must(await client.auth.signInWithPassword({ email: nameToEmail(name), password }), '로그인');
    },
    async signOut() { await client.auth.signOut(); },
    // 예전(비밀번호 방식) 계정을 이름만 방식으로 옮길 때 쓴다.
    async updatePassword(password) {
      return must(await client.auth.updateUser({ password }), '비밀번호 변경');
    },
    async getSession() { return (await client.auth.getSession()).data.session; },
    // Deferred with setTimeout(0), not queueMicrotask: this callback fires
    // while supabase-js still holds its internal auth lock during session
    // recovery (e.g. on a fresh page load with a persisted session). If cb
    // runs synchronously (or even on a microtask) it can end up making
    // REST calls that need that same lock, which then deadlocks forever —
    // reproduced as loadAll() never issuing a single request on reload.
    // Pushing to a real macrotask lets supabase-js release the lock first.
    onAuthChange(cb) { return client.auth.onAuthStateChange((_e, s) => { setTimeout(() => cb(s), 0); }); },

    // ── read ──
    async loadAll() {
      const [profiles, projects, jobs, attachments, comments] = await Promise.all([
        client.from('profiles').select('*').order('name'),
        client.from('projects').select('*').order('name'),
        client.from('jobs').select('*'),
        client.from('attachments').select('*').order('created_at'),
        client.from('comments').select('*').order('created_at'),
      ]);
      return {
        profiles: must(profiles, 'profiles'), projects: must(projects, 'projects'),
        jobs: must(jobs, 'jobs'), attachments: must(attachments, 'attachments'),
        comments: must(comments, 'comments'),
      };
    },

    // ── jobs ──
    async createJob(fields) {
      const row = { requester_id: await uid(), urgency: 3, body: '', seraph_path: '', ...fields };
      if (!row.deadline) row.deadline = null;
      return mustRow(await client.from('jobs').insert(row).select().single(), '의뢰 생성');
    },
    updateJob,
    startJob: (id) => updateJob(id, { status: 'in_progress' }),
    finishJob: (id, result_note = '') => updateJob(id, { status: 'done', result_note }),
    rejectJob: (id, reject_reason) => updateJob(id, { status: 'rejected', reject_reason }),
    handoffJob: (id, assignee_id) => updateJob(id, { status: 'waiting', assignee_id }),
    cancelJob: (id) => updateJob(id, { status: 'cancelled' }),
    setEta: (id, eta) => updateJob(id, { eta: eta || null }),
    async deleteJob(id) {
      const data = must(await client.from('jobs').delete().eq('id', id).select('id'), '의뢰 삭제');
      if (!data.length) throw new Error('의뢰 삭제: 권한이 없습니다');
    },

    // ── projects ──
    async addProject(name, owner_id = null) {
      const me = await uid();
      return mustRow(await client.from('projects').insert({ name, created_by: me, owner_id: owner_id ?? me }).select().single(), '키워드 추가');
    },
    async renameProject(id, name) {
      return mustRow(await client.from('projects').update({ name }).eq('id', id).select().maybeSingle(), '키워드 수정');
    },
    async deleteProject(id) {
      const data = must(await client.from('projects').delete().eq('id', id).select('id'), '키워드 삭제');
      if (!data.length) throw new Error('키워드 삭제: 권한이 없습니다');
    },

    // ── comments ──
    async addComment(job_id, body) {
      return mustRow(await client.from('comments').insert({ job_id, body, author_id: await uid() }).select().single(), '댓글');
    },
    async deleteComment(id) {
      const data = must(await client.from('comments').delete().eq('id', id).select('id'), '댓글 삭제');
      if (!data.length) throw new Error('댓글 삭제: 권한이 없습니다');
    },

    // ── attachments ──
    async uploadAttachment(job_id, kind, file) {
      if (file.size > MAX_FILE_BYTES) throw new Error(`${file.name}: 20MB를 초과합니다`);
      const storage_path = `${job_id}/${kind}/${crypto.randomUUID()}.${ext(file.name)}`;
      must(await client.storage.from('attachments').upload(storage_path, file, { upsert: false }), '업로드');
      const res = await client.from('attachments').insert({
        job_id, kind, storage_path, filename: file.name, size_bytes: file.size, uploader_id: await uid(),
      }).select().single();
      if (res.error) {
        const rm = await client.storage.from('attachments').remove([storage_path]);
        if (rm.error || !rm.data?.length) {
          throw new Error(`첨부 기록: ${res.error.message} (업로드된 파일 정리 실패: ${rm.error?.message || '권한 없음'})`);
        }
        throw new Error(`첨부 기록: ${res.error.message}`);
      }
      return res.data;
    },
    async attachmentUrl(storage_path) {
      return must(await client.storage.from('attachments').createSignedUrl(storage_path, 3600), '다운로드 링크').signedUrl;
    },
    async deleteAttachment(att) {
      const data = must(await client.from('attachments').delete().eq('id', att.id).select('id'), '첨부 삭제');
      if (!data.length) throw new Error('첨부 삭제: 권한이 없습니다');
      const rm = await client.storage.from('attachments').remove([att.storage_path]);
      if (rm.error || !rm.data?.length) throw new Error('첨부 기록은 지웠지만 파일 삭제에 실패했습니다: ' + (rm.error?.message || '권한 없음'));
    },

    // ── admin ──
    async adminDeleteUser(target) {
      must(await client.rpc('admin_delete_user', { target }), '사용자 삭제');
    },

    // ── realtime ──
    subscribe(onChange, onStatus) {
      const ch = client.channel('taskboard');
      for (const table of ['jobs', 'comments', 'projects', 'profiles', 'attachments']) {
        ch.on('postgres_changes', { event: '*', schema: 'public', table }, () => onChange(table));
      }
      ch.subscribe((status) => {
        if (!onStatus) return;
        if (status === 'SUBSCRIBED') onStatus('up');
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') onStatus('down');
      });
      return () => client.removeChannel(ch);
    },
  };
}
