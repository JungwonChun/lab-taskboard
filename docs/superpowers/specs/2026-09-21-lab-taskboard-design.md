# Lab Taskboard 설계 (2026-09-21)

연구실 구성원이 서로에게 작업을 의뢰하고, 담당자별 큐·진행 상태·결과 파일을 공유하는 웹 보드.
서버 없이 Supabase(DB·인증·저장소·실시간) + 정적 페이지(GitHub Pages)로 구성한다.

## 1. 목표와 범위

- 누구나 이름+비밀번호로 가입·로그인한다.
- 누구나 누구에게든(자기 자신 포함) 의뢰를 만든다.
- 담당자마다 큐가 있고, 큐는 **들어온 순서**로만 정렬된다. 긴급도는 표시용이며 순서에 영향을 주지 않는다.
- 상태 변경(진행중·완료·반려·넘기기)은 담당자만 한다.
- 의뢰자는 대기 상태일 때만 수정·취소한다.
- 첨부는 파일당 20MB 이하만 업로드하고, 큰 파일은 seraph 경로 텍스트로 대신한다.
- 모두가 모든 큐·내용·첨부·댓글을 본다. 알림 기능은 없다.
- 관리자(천정원 1인)는 모든 의뢰·댓글·사용자를 삭제할 수 있다.

범위 밖(v1에서 하지 않음): 알림(Slack/메일), 우선순위 수동 재정렬, 여러 담당자, 여러 프로젝트 태그, 완료 승인 단계, 관리자 화면에서의 비밀번호 초기화(Supabase 대시보드에서 수동).

## 2. 화면

### 2.1 로그인 / 가입
- 입력: 이름, 비밀번호(6자 이상). 가입 탭과 로그인 탭.
- 이름은 공백 제거 후 1~20자, 고유. 중복이면 "이미 있는 이름입니다".
- 내부적으로 이름을 `u-<utf8 hex>@board.local` 형태의 가짜 이메일로 변환해 Supabase Auth에 넣는다. 이메일 확인은 프로젝트 설정에서 끈다.

### 2.2 메인 (한 사람의 큐)
- 상단 바: 로고, 사람 선택(기본 = 나), 프로젝트 필터(전체/각 키워드), `새 의뢰` 버튼, `보낸 의뢰` 탭, `키워드 관리`, 관리자면 `관리`, 내 이름 + 로그아웃.
- 목록: 선택된 사람이 담당자인 의뢰 중 상태가 대기·진행중인 것을 `queued_at` 오름차순으로.
  각 행: 순번, 긴급도 이모지, 제목, 프로젝트, 의뢰자, 마감(지났으면 빨간 배경), 상태 배지, 첨부 개수.
- 아래에 접힌 "지난 일": 완료·반려·취소 건, `finished_at` 내림차순.
- 실시간: jobs/comments 변경 구독으로 자동 갱신.

### 2.3 보낸 의뢰
- 내가 의뢰자인 건 전부, 진행 중인 것 먼저, 그다음 지난 것. 각 행에 담당자·현재 순번·상태.

### 2.4 의뢰 상세 (모달)
- 표시: 제목, 프로젝트, 의뢰자 → 담당자, 긴급도, 마감, 생성 시각, 내용, 의뢰 첨부, seraph 경로, 상태, 반려 사유, 완료 메모, 결과 첨부, 댓글 스레드(작성자·시각·내용, 아래 입력창).
- 담당자 버튼: `진행중`(대기→진행중), `완료`(진행중 또는 대기→완료; 완료 메모·결과 파일 선택 입력), `반려`(사유 필수), `넘기기`(사람 선택; 담당자 변경, 상태 대기, `queued_at` 갱신).
- 의뢰자 버튼(대기 상태만): `수정`(폼 재사용), `취소`.
- 관리자 버튼: `삭제`.
- 댓글 삭제: 본인 또는 관리자.

### 2.5 새 의뢰 / 수정 폼
- 담당자(필수, 사용자 목록), 프로젝트(필수, 기존 선택 또는 "새 키워드" 입력 즉시 생성; 기본 "미분류"), 제목(필수), 내용(선택), 긴급도 1~5(기본 3), 마감 날짜+시각(선택), 첨부(선택, 여러 개, 각 20MB 이하), seraph 경로(선택, 텍스트).
- 긴급도 이모지: 1 😌 · 2 🙂 · 3 😐 · 4 😟 · 5 🥵.

### 2.6 키워드 관리
- 목록 + 추가 / 이름 변경 / 삭제. "미분류"는 변경·삭제 불가.
- 삭제 시 해당 프로젝트의 의뢰는 DB가 "미분류"로 옮긴다.

### 2.7 관리자
- 사용자 목록(이름, 가입일, 받은/보낸 건수), 사용자 삭제(그 사람의 의뢰는 남고 이름은 "탈퇴자"로 표시).
- 비밀번호 초기화는 Supabase 대시보드 Auth 화면에서 수동. 화면에 안내 문구만 둔다.

## 3. 데이터 모델 (Postgres, `public` 스키마)

```
profiles      id uuid PK = auth.users.id, name text UNIQUE NOT NULL, is_admin bool DEFAULT false, created_at
projects      id uuid PK, name text UNIQUE NOT NULL, created_by uuid, created_at
              -- 고정 행: id = 00000000-0000-0000-0000-000000000000, name = '미분류'
jobs          id uuid PK,
              requester_id uuid -> profiles, assignee_id uuid -> profiles,
              project_id uuid -> projects ON DELETE SET DEFAULT (DEFAULT = 미분류 id),
              title text NOT NULL, body text DEFAULT '',
              urgency int CHECK 1..5 DEFAULT 3,
              deadline timestamptz NULL, seraph_path text DEFAULT '',
              status text CHECK IN ('waiting','in_progress','done','rejected','cancelled') DEFAULT 'waiting',
              reject_reason text DEFAULT '', result_note text DEFAULT '',
              created_at, queued_at (기본 now), started_at NULL, finished_at NULL
attachments   id uuid PK, job_id -> jobs ON DELETE CASCADE, uploader_id, kind text IN ('request','result'),
              storage_path text, filename text, size_bytes int, created_at
comments      id uuid PK, job_id -> jobs ON DELETE CASCADE, author_id, body text NOT NULL, created_at
```

- Storage 버킷 `attachments` (private, 파일당 20MB 제한). 경로: `<job_id>/<kind>/<uuid>-<filename>`. 표시 시 signed URL 발급.
- 순번 계산(클라이언트): 같은 assignee, status ∈ {waiting, in_progress}, `queued_at` < 자기 것인 개수 + 1.
- 가입 시 `auth.users` insert 트리거로 `profiles` 행 생성(이름은 `raw_user_meta_data.name`).
- 첫 관리자: SQL 설정 파일 끝에 `update profiles set is_admin = true where name = '천정원'` 한 줄. 가입 후 실행.
- 사용자 삭제: `profiles` 삭제 대신 `auth.users` 삭제 → profiles는 FK CASCADE로 삭제되고 jobs의 requester/assignee는 `ON DELETE SET NULL`. 화면에서 NULL은 "탈퇴자"로 표시. 담당자가 NULL인 대기 건은 관리자가 넘기기로 재배정할 수 있다(관리자는 상태 변경도 가능).

## 4. 권한 규칙 (RLS)

모든 테이블 RLS 활성. `auth.uid()` 기준.

| 테이블 | select | insert | update | delete |
|---|---|---|---|---|
| profiles | 로그인 사용자 전부 | 트리거만 | 본인(이름 변경 불가, 현재는 없음) | 관리자 |
| projects | 전부 | 로그인 사용자 | 로그인 사용자, 단 미분류 제외 | 로그인 사용자, 단 미분류 제외 |
| jobs | 전부 | `requester_id = auth.uid()` | 아래 함수로 검사 | 관리자만(의뢰자는 삭제 대신 취소) |
| attachments | 전부 | 의뢰자(kind=request, job이 waiting) 또는 담당자(kind=result) | 없음 | 업로더 또는 관리자 |
| comments | 전부 | `author_id = auth.uid()` | 없음 | 작성자 또는 관리자 |

jobs update 정책은 `can_update_job(old, new)` 함수 한 곳에서 판정한다.
- 관리자: 모두 허용.
- 의뢰자이고 old.status = waiting: title/body/urgency/deadline/seraph_path/project_id/assignee_id 수정 허용, status는 waiting→cancelled만 허용. assignee 변경 시 queued_at 갱신은 트리거.
- 담당자: 허용되는 전이만 — waiting→in_progress(started_at 세팅), waiting|in_progress→done(finished_at), waiting|in_progress→rejected(reject_reason 비어 있으면 거부, finished_at), waiting|in_progress→waiting with assignee 변경(넘기기; queued_at = now). 그 외 필드 변경 불가.
- 그 밖의 사용자: 거부.

Storage 정책: 버킷 읽기는 로그인 사용자 전부, 업로드는 attachments insert 조건과 동일, 삭제는 업로더/관리자.

## 5. 기술 구성

- 파일: `index.html`, `app.js`, `style.css`, `config.js`(SUPABASE_URL, SUPABASE_ANON_KEY), `supabase/schema.sql`(테이블·트리거·함수·정책·버킷·미분류 시드), `README.md`(설치 순서).
- 라이브러리: `@supabase/supabase-js` v2 UMD를 jsDelivr CDN에서 로드. 빌드 도구 없음.
- 배포: GitHub Pages(저장소 루트). anon key는 공개 전제 값이며 보안은 RLS가 담당.
- 실시간: `postgres_changes` 구독(jobs, comments, projects, profiles) → 로컬 상태 갱신 후 재렌더.
- 시간 표시: 브라우저 로컬 시간(KST), 마감은 `datetime-local` 입력.

## 6. 오류 처리

- 20MB 초과: 선택 즉시 클라이언트에서 거부 메시지, 버킷 한도로 이중 차단.
- 업로드 도중 실패: job은 만들어졌으므로 상세 화면에서 첨부 재시도 가능하게(의뢰자, waiting 상태).
- 프로젝트 일시정지/네트워크 실패: 상단에 빨간 배너 "서버에 연결할 수 없습니다. 관리자에게 Supabase 복구를 요청하세요".
- 권한 거부(RLS 에러): "권한이 없습니다" 토스트, 화면은 최신 데이터로 다시 로드.
- 이름 중복 가입: Auth의 중복 이메일 오류를 "이미 있는 이름"으로 번역.

## 7. 검증

- `tests/rls_test.mjs`: Node + supabase-js로 임시 사용자 A·B(·관리자)를 만들어
  - A가 B에게 의뢰 → B 큐에 순번 1로 보임
  - A(의뢰자)가 상태를 in_progress로 바꾸려 하면 거부
  - B가 in_progress → done 허용, 사유 없는 rejected 거부
  - A가 waiting 아닌 의뢰 수정 시 거부
  - B가 C에게 넘기면 queued_at 갱신·C 큐 맨 뒤
  - 키워드 삭제 시 job이 미분류로 이동
  - 마친 뒤 임시 사용자·데이터 정리.
  실행에는 테스트 전용 Supabase 프로젝트 또는 service role key가 필요하다(README에 명시).
- 화면 체크리스트(`docs/CHECKLIST.md`): 가입→의뢰→진행→완료(결과 파일)→반려→넘기기→취소→키워드 삭제→관리자 삭제→두 브라우저 실시간 반영.

## 8. 설치 순서 (README에 그대로)

1. supabase.com에서 프로젝트 생성(Seoul 리전).
2. Authentication → Providers → Email: "Confirm email" 끄기.
3. SQL Editor에 `supabase/schema.sql` 실행.
4. `config.js`에 URL·anon key 기입.
5. GitHub 저장소에 push, Settings → Pages → 루트 배포.
6. 페이지에서 "천정원" 가입 후 SQL Editor에서 관리자 승격 한 줄 실행.
