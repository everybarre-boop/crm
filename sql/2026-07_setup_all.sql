-- ============================================================================
-- 에블바레 CRM — 통합 셋업 SQL (한 번에 붙여넣기용)
-- ----------------------------------------------------------------------------
-- Supabase → SQL Editor 에 "이 파일 전체"를 붙여넣고 [Run] 한 번이면 끝난다.
-- 모두 idempotent(재실행 안전)라 여러 번 돌려도 문제 없다.
--
-- 포함:
--   A. branch_costs        (비용 입력 탭 + 대시보드 비용/비율)
--   B. apply_attendance RPC + daily_runs 로그  (일간 자동 갱신)
--   C. 점검 결과 요약       (맨 끝 SELECT 한 표로 상태 확인)
--
-- 실행 후: 맨 아래 결과표의 "결과" 열이 모두 '있음' 이고,
--          '3_dedup_key 공식과 어긋난 행수' 가 0 이면 정상.
--          (개별 파일: sql/2026-07_branch_costs.sql, sql/2026-07_apply_attendance.sql,
--           sql/2026-07_verify_dedup.sql — 내용은 아래와 동일)
-- ============================================================================


-- ┌────────────────────────────────────────────────────────────────────────┐
-- │ A. branch_costs — 지점별·월별 비용                                        │
-- └────────────────────────────────────────────────────────────────────────┘
create table if not exists public.branch_costs (
  id           bigint generated always as identity primary key,
  "지점"        text not null,               -- 청담·옥수·광교·반포·판교·송파
  "연월"        text not null,               -- 'YYYY-MM'
  "인건비"      integer not null default 0,
  "임대료"      integer not null default 0,
  "기타비용"    integer not null default 0,
  "메모"        text,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  unique ("지점", "연월")
);

create index if not exists branch_costs_ym_idx on public.branch_costs ("연월");

alter table public.branch_costs enable row level security;
drop policy if exists "admins_full_access" on public.branch_costs;
create policy "admins_full_access"
on public.branch_costs
for all
to authenticated
using      ( (auth.jwt() ->> 'email') = any (array['basegolf.official@gmail.com']) )
with check ( (auth.jwt() ->> 'email') = any (array['basegolf.official@gmail.com']) );


-- ┌────────────────────────────────────────────────────────────────────────┐
-- │ B. daily_runs 로그 + apply_attendance RPC — 일간 자동 갱신                │
-- └────────────────────────────────────────────────────────────────────────┘
create table if not exists public.daily_runs (
  id           bigint generated always as identity primary key,
  run_at       timestamptz default now(),
  "지점"        text,
  dry_run      boolean not null default true,
  "요청건수"    integer not null default 0,
  "반영건수"    integer not null default 0,
  "미매칭"      jsonb   not null default '[]'::jsonb,
  created_by   text
);

alter table public.daily_runs enable row level security;
drop policy if exists "admins_full_access" on public.daily_runs;
create policy "admins_full_access"
on public.daily_runs
for all
to authenticated
using      ( (auth.jwt() ->> 'email') = any (array['basegolf.official@gmail.com']) )
with check ( (auth.jwt() ->> 'email') = any (array['basegolf.official@gmail.com']) );

-- 매칭 기준: 이름 + 수강권명 + 연락처(숫자만). dedup_key 재계산은 makeKey 공식과 동일.
-- used_count 는 STORED 생성 컬럼이라 자동 재계산(직접 update 안 함).
-- SECURITY DEFINER 라 RLS 우회 → 함수 내부에서 관리자 이메일 재검증.
create or replace function public.apply_attendance(
  records jsonb,
  dry_run boolean default true,
  branch  text default null
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  caller    text := auth.jwt() ->> 'email';
  req       integer := coalesce(jsonb_array_length(records), 0);
  matched   integer := 0;
  unmatched jsonb := '[]'::jsonb;
begin
  if caller is null or caller <> 'basegolf.official@gmail.com' then
    raise exception 'apply_attendance: not authorized (%).', coalesce(caller, 'anon');
  end if;

  with src as (
    select
      (e->>'이름')                                             as nm,
      regexp_replace(coalesce(e->>'연락처',''),'[^0-9]','','g') as phone,
      (e->>'수강권명')                                          as ticket,
      (e->>'전체횟수')                                          as tot,
      (e->>'잔여횟수')                                          as rem
    from jsonb_array_elements(records) e
  ),
  j as (
    select s.*, mem.id as mid
    from src s
    left join public.members mem
      on  mem."이름"     = s.nm
      and mem."수강권명" = s.ticket
      and regexp_replace(coalesce(mem."연락처",''),'[^0-9]','','g') = s.phone
  )
  select
    count(*) filter (where mid is not null),
    coalesce(
      jsonb_agg(jsonb_build_object('이름', nm, '수강권명', ticket, '연락처', phone))
        filter (where mid is null),
      '[]'::jsonb
    )
  into matched, unmatched
  from j;

  if not dry_run then
    with src as (
      select
        (e->>'이름')                                             as nm,
        regexp_replace(coalesce(e->>'연락처',''),'[^0-9]','','g') as phone,
        (e->>'수강권명')                                          as ticket,
        (e->>'전체횟수')                                          as tot,
        (e->>'잔여횟수')                                          as rem
      from jsonb_array_elements(records) e
    )
    update public.members mem
    set "전체횟수" = s.tot,
        "잔여횟수" = s.rem,
        dedup_key =
             coalesce(mem."이름",     '') || chr(31)
          || coalesce(mem."연락처",   '') || chr(31)
          || coalesce(mem."수강권명", '') || chr(31)
          || coalesce(mem."등록일",   '') || chr(31)
          || coalesce(s.tot, '')
    from src s
    where mem."이름"     = s.nm
      and mem."수강권명" = s.ticket
      and regexp_replace(coalesce(mem."연락처",''),'[^0-9]','','g') = s.phone;
  end if;

  insert into public.daily_runs("지점", dry_run, "요청건수", "반영건수", "미매칭", created_by)
  values (branch, dry_run, req, matched, unmatched, caller);

  return jsonb_build_object(
    'requested', req,
    'matched',   matched,
    'unmatched_count', req - matched,
    'dry_run',   dry_run,
    'branch',    branch,
    'unmatched', unmatched
  );
end;
$$;

grant execute on function public.apply_attendance(jsonb, boolean, text) to authenticated;


-- ┌────────────────────────────────────────────────────────────────────────┐
-- │ C. 점검 결과 요약 — 이 표가 SQL Editor 에 마지막으로 표시된다.           │
-- │    "결과"가 모두 '있음' 이고 3번이 '0' 이면 정상.                         │
-- └────────────────────────────────────────────────────────────────────────┘
select '1_members.dedup_key 컬럼' as "점검",
  case when exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='members' and column_name='dedup_key'
  ) then '있음' else '없음(!)' end as "결과"
union all
select '2_members dedup_key 유니크 인덱스',
  case when exists (
    select 1 from pg_indexes
    where schemaname='public' and tablename='members'
      and indexdef ilike '%dedup_key%' and indexdef ilike '%unique%'
  ) then '있음' else '없음(!)' end
union all
select '3_dedup_key 공식과 어긋난 행수',
  (select count(*)::text from public.members m
   where m.dedup_key is distinct from (
          coalesce(m."이름",     '') || chr(31)
       || coalesce(m."연락처",   '') || chr(31)
       || coalesce(m."수강권명", '') || chr(31)
       || coalesce(m."등록일",   '') || chr(31)
       || coalesce(m."전체횟수", '')))
union all
select '4_branch_costs 테이블',
  case when exists (select 1 from information_schema.tables
    where table_schema='public' and table_name='branch_costs') then '있음' else '없음(!)' end
union all
select '5_daily_runs 테이블',
  case when exists (select 1 from information_schema.tables
    where table_schema='public' and table_name='daily_runs') then '있음' else '없음(!)' end
union all
select '6_apply_attendance 함수',
  case when exists (select 1 from pg_proc where proname='apply_attendance') then '있음' else '없음(!)' end
order by "점검";
