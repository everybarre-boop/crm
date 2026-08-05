-- ============================================================================
-- 에블바레 — apply_attendance v2  (다중행 덮어쓰기 버그 수정)
-- ----------------------------------------------------------------------------
-- 🔥 왜 고치는가
--    v1(sql/2026-07_apply_attendance.sql)의 UPDATE 는
--      이름 AND 수강권명 AND 연락처(숫자만)
--    3열 등가조인이었다. 그런데 2026-08 KEY_COLS 개정 이후로는
--    **같은 사람이 같은 수강권명을 재등록한 건이 각각 별개 행으로 남는다**
--    (CLAUDE.md 실측: 이가원 `언리미티드(판교) 30회` 19행).
--    이 3열 조인은 그 19행을 **전부 같은 전체/잔여로 덮어썼다.**
--      · used_count(= 전체−잔여) 합 = 1인 누적 사용횟수가 왜곡 → CRM 마일스톤 판정이 틀린다
--      · matched 가 "조인 결과 행 수"라 matched > requested 가 되고 unmatched_count 가 음수
--    주 1회 엑셀 재업로드가 교정해 주지만 매일 밤 자동화가 다시 망가뜨린다.
--
-- ✅ v2 가 바꾸는 것 — "입력 1건 → 회원 1행" 을 보장한다.
--    1) 입력 record 마다 후보 members 행 중 **딱 하나**만 고른다(_match_attendance).
--       고르는 순서: ① 수강권시작일이 정확히 일치하는 행  ② 시작일이 가장 최근인 행  ③ id 큰 행
--       (스크래퍼가 수강권 모달에서 `수강권시작일`을 함께 읽어 오면 ①로 정확히 꽂힌다.
--        없으면 ②로 "현재 쓰고 있는 최신 등록건"을 고른다.)
--    2) matched 를 **입력 건수 기준**으로 센다 → 항상 matched ≤ requested.
--    3) UPDATE 대상도 members.id 기준으로 중복 제거(같은 회원행을 두 입력이 가리켜도 1회만).
--
-- ⛔️ v1 과 동일하게 유지하는 것 (건드리면 안 되는 것)
--    · `전체횟수`/`잔여횟수` **만** update 한다. 이 두 컬럼은 KEY_COLS 에 없으므로
--      dedup_key 는 절대 건드리지 않는다. (옛 공식으로 재계산하면 키가 깨진다)
--    · used_count 는 STORED 생성 컬럼이라 자동 재계산 — 직접 update 하지 않는다.
--    · SECURITY DEFINER 라 RLS 를 우회하므로 함수 내부에서 호출자 이메일을 재검증한다.
--
-- Supabase → SQL Editor 에 붙여 1회 실행. idempotent(재실행 안전).
-- ⚠️ 실행 전 `npm run db:backup members` 로 덤프를 뜰 것.
-- ============================================================================


-- 1) daily_runs 확장 -----------------------------------------------------------
--    이제 하루에 여러 단계(출석반영/예약저장/CRM생성/슬랙발송)가 같은 테이블에 로그를 남긴다.
--    기존 행은 기본값 'attendance' 로 분류되므로 하위 호환이 깨지지 않는다.
alter table public.daily_runs add column if not exists "단계"     text not null default 'attendance';
alter table public.daily_runs add column if not exists "대상일자" date;

comment on column public.daily_runs."단계"     is 'attendance | reservations | crm | slack';
comment on column public.daily_runs."대상일자" is '그 단계가 다룬 수업 날짜 (D-1 또는 D+1)';

create index if not exists daily_runs_recent_idx on public.daily_runs (run_at desc);


-- 2) ymd_num — 텍스트 날짜 → 비교용 정수 yyyymmdd --------------------------------
--    lib/members.ts 의 ymdNum() 과 **같은 규칙**이다(정규식도 동일).
--      "2026-07-16" · "2026. 7. 16.(목)" · "2026/7/16 14:30" → 20260716
--    일(day)까지 못 뽑으면 null.
--    ⚠️ 이 공식을 바꿀 때는 lib/members.ts 의 ymdNum() 도 함께 바꿀 것.
create or replace function public.ymd_num(s text)
returns integer
language sql
immutable
as $$
  select case
           when m is null then null
           else m[1]::int * 10000 + m[2]::int * 100 + m[3]::int
         end
  from (select regexp_match(coalesce(s, ''), '(\d{4})\D+(\d{1,2})\D+(\d{1,2})')) t(m);
$$;

comment on function public.ymd_num(text) is
  '텍스트 날짜 → yyyymmdd 정수. lib/members.ts 의 ymdNum() 과 같은 공식(함께 유지할 것).';


-- 3) _match_attendance — 입력 record 1건당 members 행 1개를 고른다 -----------------
--    ⚠️ 매칭 공식이 존재하는 **유일한 자리**다. apply_attendance 가 이 함수를 두 번
--       (집계용 / 갱신용) 호출하므로 공식이 두 곳으로 갈라지지 않는다.
--    left join 이라 매칭 실패한 입력도 mid = null 로 한 행씩 남는다(미매칭 집계용).
create or replace function public._match_attendance(records jsonb)
returns table (
  ord    bigint,
  nm     text,
  phone  text,
  ticket text,
  tot    text,
  rem    text,
  mid    bigint
)
language sql
stable
set search_path = public
as $$
  with src as (
    select
      t.ord                                                       as ord,
      (t.e ->> '이름')                                             as nm,
      regexp_replace(coalesce(t.e ->> '연락처', ''), '[^0-9]', '', 'g') as phone,
      (t.e ->> '수강권명')                                          as ticket,
      (t.e ->> '전체횟수')                                          as tot,
      (t.e ->> '잔여횟수')                                          as rem,
      public.ymd_num(t.e ->> '수강권시작일')                         as startd
    from jsonb_array_elements(coalesce(records, '[]'::jsonb)) with ordinality as t(e, ord)
  ),
  cand as (
    select
      s.ord, s.nm, s.phone, s.ticket, s.tot, s.rem,
      mem.id                                    as mid,
      public.ymd_num(mem."수강권시작일")          as m_start,
      -- 스크랩이 수강권시작일을 함께 줬고 그 값이 정확히 맞는 행이면 최우선
      (s.startd is not null and public.ymd_num(mem."수강권시작일") = s.startd) as exact
    from src s
    left join public.members mem
      on  mem."이름"     = s.nm
      and mem."수강권명" = s.ticket
      and regexp_replace(coalesce(mem."연락처", ''), '[^0-9]', '', 'g') = s.phone
  )
  select distinct on (c.ord)
         c.ord, c.nm, c.phone, c.ticket, c.tot, c.rem, c.mid
  from cand c
  order by c.ord,
           c.exact   desc nulls last,   -- ① 시작일 정확 일치
           c.m_start desc nulls last,   -- ② 가장 최근 등록건
           c.mid     desc;              -- ③ 그래도 동률이면 최신 행
$$;

revoke all on function public._match_attendance(jsonb) from public;
grant execute on function public._match_attendance(jsonb) to authenticated;

comment on function public._match_attendance(jsonb) is
  '스크랩 record 1건 → members 행 1개 매칭(입력 1건당 정확히 1행 반환, 미매칭은 mid=null). apply_attendance 전용.';


-- 4) apply_attendance v2 ---------------------------------------------------------
--    ⚠️ v1(3인자)은 반드시 **삭제**한다. 오버로드로 남겨 두면
--       apply_attendance(jsonb, boolean, text) 호출이 3인자판·4인자판 양쪽에 매칭돼
--       "function is not unique" 에러가 난다(4인자판의 target_date 가 default 라서).
--       PostgREST 는 이름 있는 인자로 호출하므로, 4인자판만 남아도
--       .rpc('apply_attendance', { records, dry_run, branch }) 는 그대로 동작한다.
drop function if exists public.apply_attendance(jsonb, boolean, text);

create or replace function public.apply_attendance(
  records jsonb,
  dry_run boolean default true,
  branch  text default null,
  target_date date default null      -- v2 신규(선택). daily_runs 에만 기록된다.
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  caller    text    := auth.jwt() ->> 'email';
  req       integer := coalesce(jsonb_array_length(records), 0);
  matched   integer := 0;
  applied   integer := 0;
  unmatched jsonb   := '[]'::jsonb;
begin
  -- 관리자만 (SECURITY DEFINER 우회 방지)
  if caller is null or caller <> 'basegolf.official@gmail.com' then
    raise exception 'apply_attendance: not authorized (%).', coalesce(caller, 'anon');
  end if;

  -- 매칭 집계 — 입력 1건당 1행이므로 matched 는 절대 requested 를 넘지 않는다.
  select
    count(*) filter (where m.mid is not null),
    coalesce(
      jsonb_agg(jsonb_build_object('이름', m.nm, '수강권명', m.ticket, '연락처', m.phone)
                order by m.ord)
        filter (where m.mid is null),
      '[]'::jsonb
    )
  into matched, unmatched
  from public._match_attendance(records) m;

  -- 실제 반영
  if not dry_run then
    with tgt as (
      -- 같은 members 행을 두 입력이 가리키면 1회만 갱신(비결정적 덮어쓰기 방지)
      select distinct on (m.mid) m.mid, m.tot, m.rem
      from public._match_attendance(records) m
      where m.mid is not null
      order by m.mid, m.ord
    )
    update public.members mem
       -- 전체/잔여횟수만 갱신한다. 둘 다 KEY_COLS 에 없으므로 dedup_key 는 그대로 둔다.
       set "전체횟수" = tgt.tot,
           "잔여횟수" = tgt.rem
      from tgt
     where mem.id = tgt.mid;

    get diagnostics applied = row_count;
  end if;

  -- 감사 로그
  insert into public.daily_runs("단계", "대상일자", 지점, dry_run, 요청건수, 반영건수, 미매칭, created_by)
  values ('attendance', target_date, branch, dry_run, req, matched, unmatched, caller);

  return jsonb_build_object(
    'requested',       req,
    'matched',         matched,
    'updated',         applied,          -- v2 신규: 실제로 갱신된 members 행 수
    'unmatched_count', req - matched,
    'dry_run',         dry_run,
    'branch',          branch,
    'target_date',     target_date,
    'unmatched',       unmatched
  );
end;
$$;

grant execute on function public.apply_attendance(jsonb, boolean, text, date) to authenticated;


-- ============================================================================
-- 점검 (실행 후 아래를 돌려 확인)
-- ============================================================================

-- ① 재등록 다중행이 실제로 존재하는지 — v1 버그의 사정거리
--    (같은 이름+연락처+수강권명이 2행 이상인 케이스)
-- select "이름", "수강권명", count(*) as 행수
-- from public.members
-- group by "이름", regexp_replace(coalesce("연락처",''),'[^0-9]','','g'), "수강권명"
-- having count(*) > 1
-- order by 행수 desc
-- limit 20;

-- ② dry-run 매칭 확인 — matched 가 requested 를 절대 넘지 않아야 한다
-- select public.apply_attendance(
--   '[{"이름":"홍길동","연락처":"010-0000-0001","수강권명":"바레 그룹 20회 (광교)","전체횟수":"20","잔여횟수":"18"}]'::jsonb,
--   true, '광교', current_date - 1
-- );

-- ③ ymd_num 동작
-- select public.ymd_num('2026-07-16'), public.ymd_num('2026. 7. 16.(목)'),
--        public.ymd_num('2026/7/16 14:30'), public.ymd_num('2026-07'), public.ymd_num(null);
--   → 20260716 / 20260716 / 20260716 / null / null

-- ④ 총 사용횟수 (반영 전후 대조용 — 급변하면 매칭이 틀린 것)
-- select count(*) as 행수, sum(used_count) as 총사용횟수 from public.members;
