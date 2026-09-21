-- ══════════════════════════════════════════════════════════════════════
--  Lab Taskboard — 점검용 찌꺼기 정리
--  Claude 가 동작 확인용으로 만든 계정이 지워지면서, 그 계정이 내고 맡던
--  의뢰만 주인 없이 남았습니다. 대시보드 숫자가 어긋나 보이던 원인입니다.
--  이 SQL 을 SQL Editor 에 붙여넣고 Run 하세요. 실제 의뢰는 건드리지 않습니다.
-- ══════════════════════════════════════════════════════════════════════

-- 지우기 전에 무엇이 지워질지 확인
select id, title, status, created_at
from public.jobs
where requester_id is null and assignee_id is null;

-- 의뢰자도 담당자도 없는 의뢰 = 지워진 계정의 찌꺼기
delete from public.jobs
where requester_id is null and assignee_id is null;

-- 남은 점검용 계정이 있으면 함께 정리
delete from auth.users u
using public.profiles p
where p.id = u.id
  and (p.name like '점검%' or p.name like '진단%' or p.name like '검증%'
       or p.name like '집계%' or p.name = '테스트확인');

-- 결과 확인
select name, is_admin as 관리자 from public.profiles order by created_at;
select status, count(*) as 건수 from public.jobs group by status order by status;
