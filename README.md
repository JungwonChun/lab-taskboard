# Lab Taskboard

연구실 구성원끼리 일을 의뢰하고 담당자별 큐로 진행 상황·결과 파일을 공유하는 보드.
서버 없음: Supabase(무료) + GitHub Pages(무료).

## 1. Supabase 프로젝트 만들기 (5분)
1. https://supabase.com → New project (리전 Northeast Asia (Seoul)). DB 비밀번호는 보관.
2. **Authentication → Providers → Email**: `Enable email provider`는 켜진 채로 두고, `Confirm email`만 **끄기** → Save.
3. **Authentication → Rate Limits**: 기본값 그대로 두면 된다. 변경 불필요.
4. **SQL Editor → New query**: `supabase/schema.sql` 전체를 붙여넣고 Run. 오류 없이 끝나야 함.
5. **Project Settings → API**: `Project URL`과 `anon public` 키를 복사.

## 2. 설정 파일
```bash
cp config.example.js config.js   # URL과 anon key 기입
```
`config.js`는 git에 올라가지 않는다. GitHub Pages로 배포할 때는 아래 3단계처럼 Actions가 만들어 넣는다.

## 3. GitHub Pages 배포
1. 이 저장소를 GitHub에 push.
2. 저장소 **Settings → Secrets and variables → Actions → Variables**에 `SUPABASE_URL`, `SUPABASE_ANON_KEY` 추가 (anon key는 공개돼도 되는 값이므로 Variable로 충분).
3. **Settings → Pages → Source: GitHub Actions**.
4. `.github/workflows/pages.yml`이 push마다 `config.js`를 생성해 배포한다. 주소: `https://<user>.github.io/<repo>/`.

## 4. 첫 관리자
1. 배포된 페이지에서 `천정원`으로 가입.
2. SQL Editor에서 실행: `update public.profiles set is_admin = true where name = '천정원';`
3. 확인: 관리 화면에서 테스트용 사용자를 하나 가입시킨 뒤 삭제해 본다. 권한 오류로 실패하면 `admin_delete_user` 함수 소유자가 `auth.users`에 대한 delete 권한이 없는 것이 원인이므로, 대신 Supabase → Authentication → Users에서 직접 삭제한다.

## 5. 사용 규칙

- **첫 화면은 대시보드**입니다. 쌓여있는 일(대기), 진행중, 총 처리량(완료 누적)과 사람별 현황을 보여줍니다. 표에서 `큐 보기`를 누르면 그 사람 큐로 갑니다.
- **예상 마무리 시간**은 일을 받은 사람이 적습니다. 의뢰 상세의 `예상 마무리 시간` 버튼으로 날짜와 시각을 저장하면 큐 줄에 🏁 로 표시됩니다. 의뢰자는 이 값을 바꿀 수 없습니다.

- **로그인은 이름만** 칩니다. 처음 보는 이름이면 그 자리에서 계정이 만들어집니다. 비밀번호는 없습니다.
- ⚠️ **주소와 이름을 아는 사람은 누구나 그 사람으로 들어올 수 있습니다.** 편의를 위해 의도적으로 택한 방식입니다. 민감한 내용은 올리지 마세요. 나중에 공용 암호나 개인 비밀번호로 바꿀 수 있습니다.

- **진행상황**은 담당자가 언제든 바꿉니다. 대기·진행중·완료·반려 네 개가 항상 떠 있어, 완료한 일을 다시 진행중으로 되돌릴 수도 있습니다. 취소는 의뢰자만 하고 대기 상태에서만 됩니다.
- **프로젝트 키워드는 담당자 소유**입니다. 김철수에게 의뢰할 때는 김철수의 키워드만 목록에 뜨고, 새로 입력한 키워드도 김철수 것이 됩니다. 이름 변경·삭제는 주인과 관리자만 합니다. 의뢰 목록에는 키워드 이름이 모두에게 그대로 보입니다.

## 6. 운영 메모
- 무료 플랜은 7일간 활동이 없으면 일시정지된다. 대시보드에서 Restore 한 번이면 복구. 페이지 상단에 빨간 배너가 뜨면 이 경우다(연결 끊김 시에도 같은 배너가 뜨며 30초마다 재시도한다).
- 파일 저장소는 총 1GB. 20MB 이상 또는 오래 보관할 파일은 seraph 경로로 적는다. 완료된 의뢰의 첨부는 정리한다.
- 비밀번호가 없으므로 초기화도 없습니다. 이름을 잘못 만들었으면 관리자가 관리 화면에서 그 계정을 지우면 됩니다.
- 이메일 = `u-` + 이름의 UTF-8 hex + `@board.local`; 예: `ab` → `u-6162@board.local`.
- 사용자 삭제(관리자 화면)는 SQL 함수 `admin_delete_user`를 호출한다. 삭제된 사용자는 기존 의뢰에 "탈퇴자"로 남는다.
- 실시간: 다른 브라우저에서의 변경이 즉시 반영된다. 로그인 상태에서 새로고침해도 세션이 유지된다.

## 7. 개발·테스트
```bash
npm install
```

세 가지 테스트 스크립트가 있다:

| 스크립트 | 무엇을 검사하는가 | 필요한 것 |
|---|---|---|
| `npm test` | `src/lib.js`의 순수 로직 단위 테스트 (`tests/lib.test.mjs`) | 없음 |
| `npm run test:rls` | Supabase RLS 정책·트리거 통합 테스트 (`tests/rls.test.mjs`) | 로컬 Supabase 스택(Docker) |
| `npm run test:ui` | 헤드리스 Chrome으로 화면 흐름을 구동하는 UI 테스트, 약 25개 (`tests/ui.smoke.mjs`) | 로컬 Supabase 스택 + `npm run serve` 실행 중 + Chrome이 `/usr/bin/google-chrome`에 있어야 함 |

`test:rls`와 `test:ui`는 로컬 스택이 필요하다:
```bash
npx supabase start       # 로컬 스택 기동 (Docker)
docker exec -i supabase_db_lab_taskboard psql -U postgres -d postgres < supabase/schema.sql
npm run test:rls         # 권한 규칙 통합 테스트
# test:ui를 돌리려면 별도 터미널에서 npm run serve 를 켜 둔 채로 실행
npm run serve            # http://localhost:5500 (config.js는 로컬 URL/키로)
```
`tests/helpers.mjs`가 `npx supabase status -o env`로 로컬 키를 읽으므로 `config.js`를 따로 채울 필요는 없다(테스트 자체는 키를 직접 읽어온다).

다 쓴 뒤에는 로컬 스택을 반드시 내린다:
```bash
npx supabase stop
```

## 7. 화면에 쓰인 한국어 문구 (참고)
큐 / 보낸 의뢰 / + 새 의뢰 / 키워드 관리 / 관리 / 진행중으로 / 완료 / 반려 / 넘기기 / 수정 / 취소
