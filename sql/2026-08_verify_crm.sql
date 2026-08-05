-- ============================================================================
-- 에블바레 CRM — 점검 전용 (읽기만 한다. DDL/DML 없음)
-- ----------------------------------------------------------------------------
-- sql/2026-08_apply_attendance_v2.sql → sql/2026-08_crm.sql 을 실행한 뒤 이걸 돌려
-- "전부 정상"인지 확인한다. 하나라도 ✗ 면 그 SQL 을 다시 실행할 것.
-- Supabase → SQL Editor 에 통째로 붙여넣기.
-- ============================================================================

-- ① 구조 점검 -----------------------------------------------------------------
select 항목, 기대, 실제,
       case when 기대 = 실제 then '✓' else '✗' end as 판정
from (
  select 'ymd_num 함수'                as 항목, 'true' as 기대,
         (to_regprocedure('public.ymd_num(text)') is not null)::text as 실제
  union all select 'ymd_date 함수', 'true',
         (to_regprocedure('public.ymd_date(text)') is not null)::text
  union all select '_match_attendance 함수', 'true',
         (to_regprocedure('public._match_attendance(jsonb)') is not null)::text
  union all select 'apply_attendance v2 (4인자)', 'true',
         (to_regprocedure('public.apply_attendance(jsonb,boolean,text,date)') is not null)::text
  union all select 'apply_attendance v1 (3인자) 제거됨', 'true',
         (to_regprocedure('public.apply_attendance(jsonb,boolean,text)') is null)::text
  union all select '_norm_reservations 함수', 'true',
         (to_regprocedure('public._norm_reservations(jsonb)') is not null)::text
  union all select 'save_reservations 함수', 'true',
         (to_regprocedure('public.save_reservations(jsonb,text,date,boolean)') is not null)::text

  union all select 'reservations 테이블', 'true',
         (to_regclass('public.reservations') is not null)::text
  union all select 'crm_rules 테이블', 'true',
         (to_regclass('public.crm_rules') is not null)::text
  union all select 'crm_messages 테이블', 'true',
         (to_regclass('public.crm_messages') is not null)::text
  union all select 'crm_dormant 테이블', 'true',
         (to_regclass('public.crm_dormant') is not null)::text
  union all select 'crm_slack_posts 테이블', 'true',
         (to_regclass('public.crm_slack_posts') is not null)::text

  union all select 'daily_runs.단계 컬럼', 'true',
         (exists(select 1 from information_schema.columns
                  where table_schema='public' and table_name='daily_runs'
                    and column_name='단계'))::text
  union all select 'daily_runs.대상일자 컬럼', 'true',
         (exists(select 1 from information_schema.columns
                  where table_schema='public' and table_name='daily_runs'
                    and column_name='대상일자'))::text

  union all select 'reservations res_key UNIQUE 인덱스', '1',
         (select count(*)::text from pg_indexes
           where schemaname='public' and indexname='reservations_res_key_uidx')
  union all select 'crm_messages 자연키 UNIQUE 인덱스', '1',
         (select count(*)::text from pg_indexes
           where schemaname='public' and indexname='crm_messages_key_uidx')

  -- 🔐 뷰가 security_invoker 가 아니면 소유자 권한으로 돌아 RLS 를 우회한다(PII 유출 경로)
  union all select '뷰 security_invoker=on (2개)', '2',
         (select count(*)::text from pg_class
           where relname in ('crm_last_attendance','crm_history_depth')
             and reloptions::text like '%security_invoker=on%')

  union all select 'RLS 켜진 CRM 테이블', '5',
         (select count(*)::text from pg_tables
           where schemaname='public' and rowsecurity
             and tablename in ('reservations','crm_rules','crm_messages',
                               'crm_dormant','crm_slack_posts'))
  union all select 'CRM 테이블 admins_full_access 정책', '5',
         (select count(*)::text from pg_policies
           where schemaname='public' and policyname='admins_full_access'
             and tablename in ('reservations','crm_rules','crm_messages',
                               'crm_dormant','crm_slack_posts'))
  union all select 'crm_rules seed 행수', '5',
         (select count(*)::text from public.crm_rules)
) t;


-- ② ymd_num 공식 확인 (lib/members.ts 의 ymdNum 과 같아야 한다) -------------------
select public.ymd_num('2026-07-16')        as "ISO",         -- 20260716
       public.ymd_num('2026. 7. 16.(목)')  as "한국식",       -- 20260716
       public.ymd_num('2026/7/16 14:30')   as "슬래시+시각",  -- 20260716
       public.ymd_num('2026-07')           as "일없음",       -- null
       public.ymd_num(null)                as "null";         -- null


-- ③ apply_attendance v2 — 다중행 덮어쓰기가 실제로 막혔는지 ----------------------
--    v1 버그의 사정거리: 같은 이름+연락처+수강권명이 2행 이상인 케이스
select count(*) as "재등록 다중행 그룹수",
       coalesce(max(cnt), 0) as "최대 행수"
from (
  select count(*) as cnt
  from public.members
  group by "이름", regexp_replace(coalesce("연락처",''),'[^0-9]','','g'), "수강권명"
  having count(*) > 1
) g;

--    ↑ 위 그룹이 존재해도, 아래 dry-run 의 matched 는 requested(=1)를 절대 넘지 않아야 한다.
--    (실제 회원 1명을 골라 이름/연락처/수강권명을 바꿔 넣고 확인)
-- select public.apply_attendance(
--   '[{"이름":"홍길동","연락처":"010-0000-0001","수강권명":"바레 그룹 20회 (광교)",
--      "전체횟수":"20","잔여횟수":"18"}]'::jsonb,
--   true, '광교', current_date - 1
-- );


-- ④ 예약 스냅샷 상태 -------------------------------------------------------------
select * from public.crm_history_depth;
--   관측일수 < 14 이면 "14일 미방문" 규칙은 아직 신뢰할 수 없다(화면이 배너로 알린다).

select "예약일자", "지점", count(*) as 건수
from public.reservations
where "예약일자" >= current_date - 7
group by 1, 2
order by 1 desc, 2;
--   지점 하나가 통째로 비어 있으면 그 지점 스크랩이 조용히 실패하고 있는 것이다.


-- ⑤ 최근 자동화 실행 로그 ---------------------------------------------------------
select run_at, "단계", "대상일자", 지점, dry_run, 요청건수, 반영건수,
       jsonb_array_length(미매칭) as 미매칭건수, created_by
from public.daily_runs
order by run_at desc
limit 30;


-- ⑥ 총 사용횟수 (자동화 반영 전후 대조용 — 급변하면 매칭이 틀린 것) -----------------
select count(*) as 회원행수, sum(used_count) as 총사용횟수 from public.members;
