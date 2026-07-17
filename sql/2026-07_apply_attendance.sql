-- ============================================================================
-- 에블바레 — apply_attendance RPC + daily_runs 로그
-- ----------------------------------------------------------------------------
-- 일간 자동 갱신의 DB 측. 스튜디오메이트에서 스크랩한 "당일 예약자 + 전체/잔여"를
-- 받아 members 를 갱신한다. sql/2026-07-16_update_gwanggyo_counts.sql(수동 선례)의
-- 매칭·갱신·dedup_key 재계산 로직을 파라미터화한 것이다.
--
-- 매칭 기준: 이름 + 수강권명 + 연락처(숫자만).  (gwanggyo SQL 과 동일)
-- dedup_key 공식: 이름∣연락처∣수강권명∣등록일∣전체횟수 (chr(31), NULL→'')  — makeKey 와 동일.
-- used_count 는 STORED 생성 컬럼이라 자동 재계산(직접 update 안 함).
--
-- ⚠️ 보안: SECURITY DEFINER 라 RLS 를 우회하므로, 함수 내부에서 호출자 이메일을
--    관리자 화이트리스트로 검증한다. GitHub Actions 잡이 관리자 계정으로 로그인해
--    호출한다(service_role 키 미사용).
--
-- Supabase → SQL Editor 에 붙여 1회 실행. (idempotent — 재실행 안전)
-- ============================================================================

-- 1) 실행 로그 테이블 ------------------------------------------------------------
create table if not exists public.daily_runs (
  id           bigint generated always as identity primary key,
  run_at       timestamptz default now(),
  지점          text,
  dry_run      boolean not null default true,
  요청건수      integer not null default 0,
  반영건수      integer not null default 0,
  미매칭        jsonb   not null default '[]'::jsonb,   -- 매칭 실패한 예약자 명단
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


-- 2) RPC : apply_attendance ------------------------------------------------------
--    records: [{ "이름":.., "연락처":.., "수강권명":.., "전체횟수":n, "잔여횟수":n }, ...]
--    dry_run=true 면 매칭만 확인하고 members 는 건드리지 않는다(반영 전 검증용).
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
  -- 관리자만 (SECURITY DEFINER 우회 방지)
  if caller is null or caller <> 'basegolf.official@gmail.com' then
    raise exception 'apply_attendance: not authorized (%).', coalesce(caller, 'anon');
  end if;

  -- 입력 정규화 → 매칭 판정
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

  -- 실제 반영
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
        -- 전체횟수가 바뀌므로 dedup_key 재계산 (makeKey 공식과 동일)
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

  -- 감사 로그
  insert into public.daily_runs(지점, dry_run, 요청건수, 반영건수, 미매칭, created_by)
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

-- 사용 예 (SQL Editor 에서 dry-run 테스트):
--   select public.apply_attendance(
--     '[{"이름":"김보미","연락처":"010-4234-2380","수강권명":"바레 그룹 20회 (광교)","전체횟수":"20","잔여횟수":"18"}]'::jsonb,
--     true,               -- dry_run
--     '광교'
--   );
