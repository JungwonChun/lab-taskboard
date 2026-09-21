#!/usr/bin/env bash
# schema.sql + 마무리 블록 = SETUP.sql (붙여넣기 한 번으로 끝내는 파일)
set -e
cd "$(dirname "$0")"
{
  cat <<'HDR'
-- ══════════════════════════════════════════════════════════════════════
--  Lab Taskboard — 최초 설정 SQL
--  이 파일 전체를 복사해서 Supabase SQL Editor 에 붙여넣고 Run 하세요.
--  여러 번 실행해도 안전합니다 (기존 데이터는 지워지지 않습니다).
--  자동 생성 파일입니다. 고치려면 supabase/schema.sql 또는
--  scripts_build_setup.sh 를 고치고 `npm run build:setup` 을 실행하세요.
-- ══════════════════════════════════════════════════════════════════════

HDR
  cat supabase/schema.sql
  cat <<'FTR'

-- ══════════════════════════════════════════════════════════════════════
--  마무리: 관리자 지정 + 점검용 계정 정리
-- ══════════════════════════════════════════════════════════════════════

-- 천정원을 관리자로 (아직 가입 전이면 아무 일도 일어나지 않습니다)
update public.profiles set is_admin = true where name = '천정원';

-- 동작 확인용으로 만들어진 계정과 그 의뢰를 정리합니다
delete from auth.users u
using public.profiles p
where p.id = u.id
  and (p.name like '점검%' or p.name like '진단%' or p.name like '검증%' or p.name = '테스트확인');

-- 결과 확인: 남아 있는 사람 목록
select name, is_admin as 관리자, created_at as 가입시각
from public.profiles order by created_at;
FTR
} > SETUP.sql
echo "SETUP.sql 생성 완료: $(wc -l < SETUP.sql) 줄"
