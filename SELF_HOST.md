# 다른 곳에서 직접 띄우기 (NAS·사내 서버·PC)

이 보드는 **빌드 과정이 없는 정적 웹페이지**입니다. HTML·CSS·JS 파일 몇 개가 전부라,
파일을 그냥 내려주기만 하는 웹서버면 어디서든 돕니다. 데이터베이스와 로그인, 파일 저장은
Supabase 가 맡습니다.

```
[사용자 브라우저] ──▶ [NAS 의 웹서버]   파일만 내려줌 (HTML/CSS/JS)
        └──────────▶ [Supabase]        데이터·로그인·첨부파일
```

셋 중 하나를 고르세요.

| | 무엇이 필요한가 | 걸리는 시간 | 이럴 때 |
|---|---|---|---|
| **A. NAS 에 올리고 Supabase 는 새로 만들기** | NAS 웹서버 + 무료 Supabase 계정 | 15분 | 우리와 **별개의 보드**를 쓰고 싶을 때 (권장) |
| **B. NAS 에 올리고 기존 Supabase 를 함께 쓰기** | NAS 웹서버 | 5분 | **같은 데이터**를 보되 접속 주소만 우리 NAS 로 두고 싶을 때 |
| **C. 전부 우리 서버 안에서 (Supabase 도 직접 운영)** | Docker 되는 NAS, 메모리 4GB 이상 | 1시간 | 데이터가 **외부로 나가면 안 될 때** |

---

## A. NAS 에 올리고 Supabase 는 새로 만들기 (권장)

### 1) 소스 받기

```bash
git clone https://github.com/JungwonChun/lab-taskboard.git
cd lab-taskboard
```

git 이 없으면 GitHub 페이지 오른쪽 위 **Code → Download ZIP** 으로 받아 풀어도 됩니다.

### 2) Supabase 프로젝트 만들기

1. https://supabase.com 가입 후 **New project**. 지역은 가까운 곳(예: Northeast Asia Seoul).
   DB 비밀번호는 따로 보관하세요.
2. 왼쪽 **Authentication → Sign In / Providers → Email**:
   `Enable Email provider` 는 켠 채로, **`Confirm email` 만 끄고** Save.
   이걸 안 하면 가입 버튼을 눌러도 아무 일이 일어나지 않습니다.
3. 왼쪽 **SQL Editor → New query**: 이 저장소의 **`SETUP.sql` 전체**를 붙여넣고 **Run**.
   여러 번 실행해도 안전합니다.
   `SETUP.sql` 끝부분에 `천정원` 을 관리자로 만드는 줄이 있으니,
   **그 이름을 여러분 조직의 관리자 이름으로 바꾸고** 실행하세요.
4. 왼쪽 아래 톱니바퀴 **Project Settings → API**: `Project URL` 과 `anon public` 키를 복사합니다.
   **`service_role` 키는 절대 쓰지 마세요.** 그건 모든 권한을 가진 열쇠입니다.

### 3) 설정 파일 만들기

`config.example.js` 를 복사해 `config.js` 로 만들고 두 값을 채웁니다.

```js
window.TASKBOARD_CONFIG = {
  SUPABASE_URL: 'https://여러분프로젝트.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGci...',
};
```

`anon` 키는 공개돼도 되는 값입니다. 보안은 데이터베이스의 접근 규칙(RLS)이 담당합니다.

### 4) NAS 웹서버에 올리기

아래 **파일들만** 웹 폴더에 두면 됩니다. `tests/`, `supabase/`, `docs/` 는 올릴 필요 없습니다.

```
index.html   style.css   app.js   config.js   src/
```

**Synology (DSM)** — 패키지 센터에서 `Web Station` 설치, `웹 서비스` 에 포털 추가,
문서 루트를 `/web/taskboard` 같은 폴더로 지정한 뒤 위 파일들을 복사합니다.
접속 주소는 `http://NAS주소/taskboard/` 입니다.

**QNAP** — `App Center → Web Server` 를 켜고, `Web` 공유폴더 아래 `taskboard` 폴더를 만들어 복사합니다.

**Docker 가 되는 아무 장비**

```bash
docker run -d --name taskboard -p 8080:80 \
  -v /경로/lab-taskboard:/usr/share/nginx/html:ro nginx:alpine
```

**빠르게 시험만** (그 PC 에서만 접속)

```bash
python3 -m http.server 8099
# http://localhost:8099
```

### 5) 첫 관리자 만들기

배포된 주소에서 **가입** 탭으로 관리자가 될 이름을 가입합니다.
그 이름을 `SETUP.sql` 에 적어두었다면 이미 관리자입니다. 아니라면 SQL Editor 에서 한 줄이면 됩니다.

```sql
update public.profiles set is_admin = true where name = '관리자이름';
```

---

## B. 기존 Supabase 를 함께 쓰기

3단계의 `config.js` 에 **기존 보드의 URL 과 anon 키**를 그대로 넣고, 4단계처럼 NAS 에 올리면 끝입니다.
2단계는 건너뜁니다. 같은 데이터를 보게 되므로 접속 주소만 여러 개가 되는 셈입니다.

---

## C. 전부 우리 서버 안에서 (Supabase 도 직접 운영)

데이터가 외부로 나가면 안 될 때만 고르세요. Docker 와 메모리 4GB 이상이 필요합니다.

```bash
git clone --depth 1 https://github.com/supabase/supabase
cd supabase/docker
cp .env.example .env
# .env 에서 POSTGRES_PASSWORD, JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY,
# DASHBOARD_PASSWORD 를 모두 새 값으로 바꿉니다. 예시값을 그대로 쓰면 안 됩니다.
docker compose up -d
```

올라오면 `http://NAS주소:8000` 이 Supabase 대시보드입니다. 거기서 A-2, A-3 과 똑같이
`Confirm email` 끄기와 `SETUP.sql` 실행을 하고, `config.js` 의 URL 을 `http://NAS주소:8000` 으로,
키를 `.env` 의 `ANON_KEY` 로 적으면 됩니다.

주의할 점이 둘 있습니다. **백업을 직접** 해야 하고(`docker compose exec db pg_dump ...`),
사내망 밖에서 쓸 계획이면 리버스 프록시와 인증서로 **HTTPS 를 직접** 붙여야 합니다.

---

## 자주 막히는 곳

| 증상 | 원인과 해결 |
|---|---|
| 화면이 하얗고 아무것도 안 나옴 | `config.js` 가 없거나 값이 비었습니다. 브라우저 개발자도구(F12) 콘솔을 보세요. |
| 가입 버튼을 눌러도 아무 일이 없음 | Supabase 의 `Confirm email` 이 켜져 있습니다. A-2 의 2번을 확인하세요. |
| "서버에 연결할 수 없습니다" 빨간 띠 | URL·키 오타이거나, 무료 프로젝트가 7일 무활동으로 일시정지된 상태입니다. 대시보드에서 Restore 하세요. |
| 로그인은 되는데 목록이 비어 있음 | `SETUP.sql` 을 실행하지 않았습니다. |
| 파일 첨부가 안 됨 | `SETUP.sql` 이 만드는 `attachments` 저장소 버킷이 없습니다. 다시 실행하세요. |
| 고쳤는데 화면이 그대로 | 브라우저 캐시입니다. Ctrl+Shift+R 로 강제 새로고침하세요. |

## 한도와 비용

무료 Supabase 기준으로 데이터베이스 500MB, 첨부파일 1GB, 파일당 20MB 입니다.
연구실 규모(수십 명, 수천 건)에는 충분합니다. 첨부가 1GB 에 가까워지면 큰 파일은
서버 경로만 적는 방식으로 돌리거나 완료된 의뢰의 첨부를 정리하세요.
**무료 프로젝트는 7일 동안 아무도 쓰지 않으면 일시정지**되며, 대시보드에서 클릭 한 번으로 복구됩니다.

## 손대고 싶을 때

빌드 도구가 없어서 파일을 고치고 새로고침하면 끝입니다.

| 파일 | 하는 일 |
|---|---|
| `index.html` | 페이지 뼈대 |
| `style.css` | 모든 디자인 |
| `src/lib.js` | 순수 계산 (순번·집계·날짜 형식) |
| `src/api.js` | Supabase 호출 |
| `src/ui.js` | 화면 그리기 |
| `app.js` | 상태 관리와 버튼 연결 |
| `supabase/schema.sql` | 테이블과 권한 규칙 (정본) |

검사는 `npm install` 뒤에 `npm test` (빠름), 그리고 `npm run test:rls` 와 `npm run test:ui`
(로컬 Supabase 와 Chrome 필요)입니다. 자세한 것은 `README.md` 를 보세요.
