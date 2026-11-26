-- ============================================================================
-- 연도별 출석 수 (2026-11-26)
-- ----------------------------------------------------------------------------
-- 왜: 회원별 집계에서 "손소영님이 2026년에 몇 번 출석했나"를 보고 싶다.
--     지금 DB 에 날짜가 붙은 출석은 reservations(2026-07-29~)뿐이고, crm_attendance 는
--     사이트별 **누적 합계**만 들고 있어 연도로 쪼갤 수 없다.
--
-- 근거: 스튜디오메이트 회원 페이지 → 이용내역 → 출석 탭의 **엑셀 다운로드**(앱 자체 기능).
--      수업일이 붙은 출석 행 전부가 한 파일로 온다. 행 수 = 화면의 `출석(N)` 이 아니면
--      스크래퍼가 실패로 버린다(automation/studiomate/scrape.mjs 의 readYearlyAttendance).
--
-- 저장: crm_attendance 같은 행(site, 회원id)에 연도별 합계 jsonb + 그걸 읽은 날짜.
--   ⚠️ 연도기준일은 기준일과 **따로** 둔다. 야간 attcount 는 출석 합계만 다시 읽고
--      (기준일이 오늘로 바뀜) 연도별은 안 읽을 수 있다 — 같은 기준일을 쓰면 옛 연도값에
--      새 기준일 이후 출석만 더해져 그 사이 출석이 빠진다.
--
-- 사람·연도 합계(crm_attendance_person_yearly):
--   사이트별로 [연도별출석(≤ 연도기준일)] + [그 사이트 reservations 출석(> 연도기준일)]을
--   연도로 나눠 더한 뒤, 사람(정규화 이름 + 숫자연락처)으로 묶는다.
--   = crm_attendance_person 과 **같은 공식**(사이트별 가산 · norm_person_name 조인)이다.
--   연도별이 아직 없는 사이트 행이 하나라도 있으면 그 사람은 "연도별완전 = false" —
--   화면은 연도별 숫자를 믿을 수 없다고 표시해야 한다(빈 걸 0회로 보이지 않는다).
--
-- 실행:  npm run db:backup crm_attendance
--        npm run db:sql sql/2026-11_attendance_yearly.sql
-- idempotent(재실행 안전). 한 트랜잭션.
-- ============================================================================

alter table public.crm_attendance add column if not exists "연도별출석" jsonb;
alter table public.crm_attendance add column if not exists "연도기준일" date;

comment on column public.crm_attendance."연도별출석" is
  '{"2025": 120, "2026": 98} — 이용내역 출석 엑셀을 수업일 연도로 센 값(연도기준일 시점). NULL = 아직 안 읽음.';
comment on column public.crm_attendance."연도기준일" is
  '연도별출석을 읽은 날짜(KST). 이 날짜 이후의 출석은 reservations 에서 더한다. 기준일과 다를 수 있다.';


create or replace view public.crm_attendance_person_yearly
with (security_invoker = on) as
with att as (
  select
    a.id,
    a.site,
    a."연도별출석",
    a."연도기준일",
    public.norm_person_name(split_part(a.person_key, chr(31), 1))  as nm,
    split_part(a.person_key, chr(31), 2)                           as ph
  from public.crm_attendance a
),
base as (
  -- 연도기준일까지: 엑셀에서 센 연도별 값
  select att.nm, att.ph, (y.key)::int as yr, (y.value)::int as n
  from att
  cross join lateral jsonb_each_text(att."연도별출석") y
  where att."연도별출석" is not null
),
res as (
  select
    public.norm_person_name(v."이름")                              as nm,
    regexp_replace(coalesce(v."연락처", ''), '[^0-9]', '', 'g')     as ph,
    case v."지점"
      when '청담' then 'everybarre'
      when '판교' then 'everybarre'
      when '광교' then 'everybarre-gwanggyo'
      when '옥수' then 'everybarre-oksu'
      when '반포' then 'everybarre-banpo'
      when '송파' then 'everybarre-songpa'
    end                                                            as site,
    v."예약일자"                                                    as d
  from public.reservations v
  where v."예약상태" = '출석'
),
after_base as (
  -- 그 사이트의 연도기준일 이후 출석만(사이트를 나누지 않으면 이중 계수 — 2026-11_attendance_person_fix 와 같은 이유)
  select att.nm, att.ph, extract(year from res.d)::int as yr, count(*)::int as n
  from att
  join res
    on  res.nm = att.nm
    and res.ph = att.ph
    and res.site = att.site
    and res.d > att."연도기준일"
  where att."연도별출석" is not null
  group by 1, 2, 3
),
coverage as (
  select nm, ph,
         bool_and("연도별출석" is not null) as complete,
         count(*)                          as sites
  from att
  group by 1, 2
)
select
  s.nm || chr(31) || s.ph     as person_key,
  max(s.nm)                   as "이름",
  s.yr                        as "연도",
  sum(s.n)::int               as "출석수",
  bool_and(c.complete)        as "연도별완전"
from (
  select * from base
  union all
  select * from after_base
) s
join coverage c on c.nm = s.nm and c.ph = s.ph
group by s.nm, s.ph, s.yr;

comment on view public.crm_attendance_person_yearly is
  '사람 × 연도 출석 수(전 사이트 합). 사이트별 연도별출석 + 연도기준일 이후 reservations 출석. '
  '연도별완전=false 면 그 사람의 사이트 중 연도별을 아직 안 읽은 곳이 있다.';


-- 점검 -------------------------------------------------------------------------
select count(*)                                          as "crm_attendance 행",
       count(*) filter (where "연도별출석" is not null)  as "연도별 있음"
from public.crm_attendance;

-- 연도별 합 ≠ 출석수(같은 날 읽은 행끼리) — 0 이어야 한다
select count(*) as "연도별 합이 출석수와 다른 행(0 이어야 함)"
from public.crm_attendance a
where a."연도별출석" is not null
  and a."연도기준일" = a."기준일"
  and (select coalesce(sum(value::int), 0) from jsonb_each_text(a."연도별출석")) <> a."출석수";
