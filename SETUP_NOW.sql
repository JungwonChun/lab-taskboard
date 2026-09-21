-- ════════════════════════════════════════════════════════════════
--  Lab Taskboard — 이 파일 하나만 SQL Editor 에 붙여넣고 Run 하세요.
--  (1) 아래 schema.sql 전체를 먼저 붙여넣고,
--  (2) 그 아래에 이 파일의 마무리 블록을 이어서 붙여넣습니다.
--  여러 번 실행해도 안전합니다.
-- ════════════════════════════════════════════════════════════════

-- ── 마무리: 관리자 지정 + 점검용 계정 정리 ──────────────────────
-- 천정원을 관리자로
update public.profiles set is_admin = true where name = '천정원';

-- Claude 가 동작 확인용으로 만든 계정과 그 의뢰를 모두 삭제
-- (이름이 점검/진단/검증/테스트확인 으로 시작하는 계정)
delete from auth.users u
using public.profiles p
where p.id = u.id
  and (p.name like '점검%' or p.name like '진단%' or p.name like '검증%' or p.name = '테스트확인');

-- 확인용 출력
select name, is_admin from public.profiles order by name;
