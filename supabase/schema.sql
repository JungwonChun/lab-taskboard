-- Lab Taskboard schema. Idempotent enough to re-run on a fresh project.
create extension if not exists pgcrypto;

-- ───────── tables ─────────
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  name text not null unique check (length(name) between 1 and 20),
  is_admin boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.projects (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (length(name) between 1 and 40),
  created_by uuid references public.profiles(id) on delete set null,
  -- owner_id = 이 키워드가 속한 사람(담당자). null 이면 공용(미분류).
  owner_id uuid references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.projects add column if not exists owner_id uuid references public.profiles(id) on delete cascade;
insert into public.projects (id, name)
values ('00000000-0000-0000-0000-000000000000', '미분류')
on conflict (id) do nothing;

create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid references public.profiles(id) on delete set null,
  assignee_id uuid references public.profiles(id) on delete set null,
  project_id uuid not null default '00000000-0000-0000-0000-000000000000'
    references public.projects(id) on delete set default,
  title text not null check (length(title) between 1 and 200),
  body text not null default '',
  urgency int not null default 3 check (urgency between 1 and 5),
  deadline timestamptz,
  -- eta = 담당자가 적는 예상 마무리 시각. 의뢰자는 못 건드린다.
  eta timestamptz,
  seraph_path text not null default '',
  status text not null default 'waiting'
    check (status in ('waiting','in_progress','done','rejected','cancelled')),
  reject_reason text not null default '',
  result_note text not null default '',
  created_at timestamptz not null default now(),
  queued_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
alter table public.jobs add column if not exists eta timestamptz;
create index if not exists jobs_queue_idx on public.jobs (assignee_id, status, queued_at);

create table if not exists public.attachments (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  uploader_id uuid references public.profiles(id) on delete set null,
  kind text not null check (kind in ('request','result')),
  storage_path text not null,
  filename text not null,
  size_bytes bigint not null check (size_bytes >= 0 and size_bytes <= 20971520),
  created_at timestamptz not null default now()
);

create table if not exists public.comments (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  body text not null check (length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);

-- ───────── helper functions ─────────
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select is_admin from public.profiles where id = auth.uid()), false)
$$;

create or replace function public.can_upload_to_job(p_job uuid, p_kind text) returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_admin() or exists (
    select 1 from public.jobs j
    where j.id = p_job and (
      (p_kind = 'request' and j.requester_id = auth.uid() and j.status = 'waiting') or
      (p_kind = 'result'  and j.assignee_id  = auth.uid() and j.status in ('waiting','in_progress','done'))
    )
  )
$$;

create or replace function public.admin_delete_user(target uuid) returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.is_admin() then
    raise exception 'admin only' using errcode = '42501';
  end if;
  if target = auth.uid() then
    raise exception 'cannot delete yourself' using errcode = '42501';
  end if;
  delete from auth.users where id = target;
end $$;
revoke all on function public.admin_delete_user(uuid) from public;
grant execute on function public.admin_delete_user(uuid) to authenticated;

-- ───────── triggers ─────────
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, name)
  values (new.id, coalesce(nullif(new.raw_user_meta_data->>'name', ''), 'user-' || left(new.id::text, 8)));
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users for each row execute function public.handle_new_user();

create or replace function public.jobs_before_insert() returns trigger
language plpgsql as $$
begin
  new.status := 'waiting';
  new.created_at := now();
  new.queued_at := now();
  new.started_at := null;
  new.finished_at := null;
  new.reject_reason := '';
  new.result_note := '';
  new.eta := null;
  return new;
end $$;
drop trigger if exists jobs_before_insert on public.jobs;
create trigger jobs_before_insert before insert on public.jobs
  for each row execute function public.jobs_before_insert();

create or replace function public.jobs_before_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  uid   uuid    := auth.uid();
  adm   boolean := public.is_admin();
  is_req boolean := uid is not null and uid = old.requester_id;
  is_asg boolean := uid is not null and uid = old.assignee_id;
  closed boolean := old.status in ('done','rejected','cancelled');
  content_changed boolean :=
       new.title <> old.title or new.body <> old.body or new.urgency <> old.urgency
    or new.deadline is distinct from old.deadline or new.seraph_path <> old.seraph_path
    or new.project_id <> old.project_id;
begin
  -- auth.uid() 가 없다 = 사용자의 웹 요청이 아니다.
  -- SQL 편집기, service_role, 그리고 계정 삭제 시 ON DELETE SET NULL 연쇄가 여기 해당한다.
  -- (웹에서 온 요청은 RLS 가 이미 로그인 사용자로 한정하므로 여기까지 오지 못한다.)
  -- 이런 시스템 경로는 권한 검사를 건너뛴다. 아래 타임스탬프 정리는 그대로 탄다.
  if uid is null then
    null;
  -- 한 사람이 의뢰자이면서 담당자일 수 있다(자기 자신에게 맡긴 일). 그래서
  -- 둘 중 하나를 고르지 않고, 각 필드마다 "그 필드를 만질 수 있는 역할"을 따진다.
  elsif adm then
    null;
  elsif is_req or is_asg then
    if new.requester_id is distinct from old.requester_id then
      raise exception 'requester may not change that field' using errcode = '42501';
    end if;

    -- 내용은 의뢰자만, 그것도 대기 상태에서만.
    if content_changed and not (is_req and old.status = 'waiting') then
      raise exception 'assignee may only change status' using errcode = '42501';
    end if;

    -- 예상 마무리·반려 사유·완료 메모는 담당자만.
    if (new.eta is distinct from old.eta
        or new.reject_reason <> old.reject_reason
        or new.result_note <> old.result_note) and not is_asg then
      raise exception 'requester may not change that field' using errcode = '42501';
    end if;

    -- 담당자 바꾸기: 의뢰자는 대기 상태에서만, 담당자는 넘기기로 언제든.
    if new.assignee_id is distinct from old.assignee_id
       and not (is_asg or (is_req and old.status = 'waiting')) then
      raise exception 'not allowed' using errcode = '42501';
    end if;

    -- 상태: 취소는 의뢰자만(대기에서), 나머지 네 가지는 담당자가 언제든.
    if new.status <> old.status then
      if new.status = 'cancelled' then
        if not (is_req and old.status = 'waiting') then
          raise exception 'invalid status transition' using errcode = '42501';
        end if;
      elsif not is_asg then
        raise exception 'invalid status transition' using errcode = '42501';
      end if;
    end if;
  else
    raise exception 'not allowed' using errcode = '42501';
  end if;

  if uid is not null and new.status = 'rejected' and length(trim(new.reject_reason)) = 0 then
    raise exception 'reject_reason required' using errcode = '23514';
  end if;

  new.created_at := old.created_at;
  if new.assignee_id is distinct from old.assignee_id then new.queued_at := now(); else new.queued_at := old.queued_at; end if;
  if new.status = 'in_progress' and old.status <> 'in_progress' then new.started_at := now(); new.finished_at := null; end if;
  if new.status in ('done','rejected','cancelled') and (not closed or new.status <> old.status) then new.finished_at := now(); end if;
  if new.status = 'waiting' and old.status <> 'waiting' then new.started_at := null; new.finished_at := null; end if;
  return new;
end $$;
drop trigger if exists jobs_before_update on public.jobs;
create trigger jobs_before_update before update on public.jobs
  for each row execute function public.jobs_before_update();

-- ───────── row level security ─────────
alter table public.profiles    enable row level security;
alter table public.projects    enable row level security;
alter table public.jobs        enable row level security;
alter table public.attachments enable row level security;
alter table public.comments    enable row level security;

-- 의도적으로 update/delete 정책 없음 — is_admin 승격 방지; 삭제는 admin_delete_user의 cascade로만
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (true);

drop policy if exists projects_select on public.projects;
drop policy if exists projects_insert on public.projects;
drop policy if exists projects_update on public.projects;
drop policy if exists projects_delete on public.projects;
create policy projects_select on public.projects for select to authenticated using (true);
create policy projects_insert on public.projects for insert to authenticated with check (true);
-- 이름 변경·삭제는 키워드 주인(owner_id)과 관리자만. 미분류는 고정.
create policy projects_update on public.projects for update to authenticated
  using (id <> '00000000-0000-0000-0000-000000000000' and (owner_id = auth.uid() or public.is_admin()))
  with check (id <> '00000000-0000-0000-0000-000000000000' and (owner_id = auth.uid() or public.is_admin()));
create policy projects_delete on public.projects for delete to authenticated
  using (id <> '00000000-0000-0000-0000-000000000000' and (owner_id = auth.uid() or public.is_admin()));

drop policy if exists jobs_select on public.jobs;
drop policy if exists jobs_insert on public.jobs;
drop policy if exists jobs_update on public.jobs;
drop policy if exists jobs_delete on public.jobs;
create policy jobs_select on public.jobs for select to authenticated using (true);
create policy jobs_insert on public.jobs for insert to authenticated with check (requester_id = auth.uid());
create policy jobs_update on public.jobs for update to authenticated
  using (public.is_admin() or auth.uid() in (requester_id, assignee_id))
  with check (true); -- field/transition rules live in jobs_before_update()
-- 삭제는 의뢰한 사람, 맡은 사람, 관리자.
create policy jobs_delete on public.jobs for delete to authenticated
  using (public.is_admin() or auth.uid() in (requester_id, assignee_id));

drop policy if exists attachments_select on public.attachments;
drop policy if exists attachments_insert on public.attachments;
drop policy if exists attachments_delete on public.attachments;
create policy attachments_select on public.attachments for select to authenticated using (true);
create policy attachments_insert on public.attachments for insert to authenticated
  with check (uploader_id = auth.uid() and public.can_upload_to_job(job_id, kind));
create policy attachments_delete on public.attachments for delete to authenticated
  using (uploader_id = auth.uid() or public.is_admin());

drop policy if exists comments_select on public.comments;
drop policy if exists comments_insert on public.comments;
drop policy if exists comments_delete on public.comments;
create policy comments_select on public.comments for select to authenticated using (true);
create policy comments_insert on public.comments for insert to authenticated with check (author_id = auth.uid());
create policy comments_delete on public.comments for delete to authenticated
  using (author_id = auth.uid() or public.is_admin());

-- ───────── storage ─────────
insert into storage.buckets (id, name, public, file_size_limit)
values ('attachments', 'attachments', false, 20971520)
on conflict (id) do update set public = false, file_size_limit = 20971520;

drop policy if exists attachments_obj_select on storage.objects;
drop policy if exists attachments_obj_insert on storage.objects;
drop policy if exists attachments_obj_delete on storage.objects;
create policy attachments_obj_select on storage.objects for select to authenticated
  using (bucket_id = 'attachments');
create policy attachments_obj_insert on storage.objects for insert to authenticated
  with check (
    bucket_id = 'attachments'
    and array_length(storage.foldername(name), 1) = 2
    and public.can_upload_to_job((storage.foldername(name))[1]::uuid, (storage.foldername(name))[2])
  );
-- storage.objects has both `owner` (uuid, deprecated) and `owner_id` (text); check either so this works across Supabase versions
create policy attachments_obj_delete on storage.objects for delete to authenticated
  using (bucket_id = 'attachments' and (owner = auth.uid() or owner_id = auth.uid()::text or public.is_admin()));

-- ───────── realtime ─────────
-- A hosted Supabase project may not have supabase_realtime pre-created the
-- way the local CLI stack does.
do $$ begin
  if not exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
do $$ begin
  alter publication supabase_realtime add table public.jobs;
exception when duplicate_object or undefined_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.comments;
exception when duplicate_object or undefined_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.projects;
exception when duplicate_object or undefined_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.profiles;
exception when duplicate_object or undefined_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.attachments;
exception when duplicate_object or undefined_object then null; end $$;

-- ───────── first admin (run AFTER 천정원 signs up in the app) ─────────
-- update public.profiles set is_admin = true where name = '천정원';
