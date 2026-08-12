-- ============================================================================
-- 이름의 임시 표식('미수금') 정규화 — 출석 매칭이 결제 전후로 갈리지 않게
-- ----------------------------------------------------------------------------
-- 🔥 배경 (운영 확인 2026-08-12)
--    '미수금'은 **결제 전에 수강권을 미리 발급했을 때 이름 뒤에 붙는 표식**이고,
--    결제되면 지워진다. 즉 **같은 사람의 이름이 시점에 따라 달라진다.**
--    실제 표기: "손정미 미수금" · "이지은 미수금P" · "조윤서미수금p" · "… 전액미수금"
--
--    _match_attendance 는 `mem."이름" = s.nm` **정확 일치**로 붙는다. 그래서
--      · 엑셀 업로드 시점엔 "손정미 미수금"인데 스크랩 시점엔 "손정미" (또는 반대)
--    이면 매칭이 실패한다 → 출석이 반영되지 않고 미매칭으로 쌓인다.
--    실측 dry-run 에서 미매칭 35건 중 이 유형이 섞여 있었다.
--
-- ⚠️ JS 쪽 짝은 shared/crm-core.mjs 의 normPersonName() 이다. **공식이 같아야 한다.**
--    한쪽만 고치면 "코드가 만드는 값 ↔ DB 가 만드는 값"이 어긋난다
--    — 이 저장소가 dedup_key 로 두 번 겪은 사고와 같은 구조다(CLAUDE.md).
--
-- ⛔️ dedup_key 는 건드리지 않는다. 이름은 KEY_COLS 에 들어 있어서, 여기서 정규화한
--    이름으로 키를 다시 만들면 **전량 재키잉**이 필요해진다. 이 파일은 **매칭**만 고친다.
--    (결제 전후로 members 에 행이 둘 생기는 문제는 남는다 — 사람 단위 집계는
--     makePersonResolver 가 normPersonName 으로 합쳐 주므로 화면·CRM 은 정상이다.)
--
-- 실행:  npm run db:backup members   →   npm run db:sql sql/2026-08_name_normalize.sql
-- idempotent(재실행 안전). 선행: sql/2026-08_apply_attendance_v2.sql
-- ============================================================================


-- 1) norm_person_name — 이름에서 임시 표식을 뗀다 ------------------------------
--    떼고 나서 비면 원본을 그대로 둔다(과잉 정규화로 사람을 잃지 않기 위함).
create or replace function public.norm_person_name(s text)
returns text
language sql
immutable
as $$
  select coalesce(
           nullif(
             btrim(
               regexp_replace(
                 regexp_replace(coalesce(s, ''), '\s*(전액)?\s*미수금\s*[Pp]?', ' ', 'g'),
                 '\s+', ' ', 'g'
               )
             ),
             ''
           ),
           btrim(coalesce(s, ''))
         );
$$;

comment on function public.norm_person_name(text) is
  '이름의 임시 표식(미수금/전액미수금/미수금P) 제거. shared/crm-core.mjs 의 normPersonName() 과 같은 공식이어야 한다.';


-- 2) _match_attendance — 이름 비교만 정규화 이름으로 바꾼다 ---------------------
--    ⚠️ 나머지는 v2 원본과 **한 글자도 다르지 않다**. 매칭 공식이 존재하는 유일한 자리라
--       여기가 갈라지면 apply_attendance 의 집계용/갱신용 호출이 서로 다른 답을 낸다.
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
      -- 빈 문자열은 null 로. "값이 없다"와 "0" 을 구분해야 아래 coalesce 가 동작한다.
      nullif(t.e ->> '전체횟수', '')                                 as tot,
      nullif(t.e ->> '잔여횟수', '')                                 as rem,
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
      -- 🔥 여기만 바뀌었다 — 결제 전후로 이름이 달라져도 같은 사람으로 붙는다
      on  public.norm_person_name(mem."이름") = public.norm_person_name(s.nm)
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


-- 3) crm_last_attendance — 사람 묶음도 정규화 이름으로 --------------------------
--    이 뷰는 이름+숫자연락처로 그룹을 만든다. 표식이 붙은 채면 결제 전후가 다른 그룹이 되어
--    마지막 출석일이 쪼개지고 휴면(14일 미방문) 판정이 어긋난다.
--    ⚠️ 컬럼 구성·순서는 2026-08_crm.sql 원본과 **똑같이** 유지한다.
--       create or replace view 는 컬럼을 지우거나 순서를 바꾸면 실패한다
--       ("cannot drop columns from view"). `연락처` 는 automation/db.mjs 가 select 한다.
create or replace view public.crm_last_attendance
with (security_invoker = on) as
select
  public.norm_person_name("이름")                              as "이름",
  regexp_replace("연락처", '[^0-9]', '', 'g')                   as phone_digits,
  max("연락처") filter (where "연락처" <> '')                    as "연락처",
  max("예약일자")                                               as "마지막출석일",
  count(*)                                                     as "출석횟수",
  (array_agg("지점" order by "예약일자" desc, id desc))[1]       as "마지막지점"
from public.reservations
where "예약상태" = '출석'
   or ("예약상태" = '예약' and "예약일자" < current_date)
group by public.norm_person_name("이름"), regexp_replace("연락처", '[^0-9]', '', 'g');

comment on view public.crm_last_attendance is
  '사람별 마지막 출석일. 지난 날짜의 ''예약''도 출석으로 본다(강사 출석체크 누락 대응). 이름은 norm_person_name 으로 정규화.';


-- 점검 -------------------------------------------------------------------------
select '표식 제거 동작' as "항목",
       public.norm_person_name('손정미 미수금')      as "손정미 미수금",
       public.norm_person_name('이지은 미수금P')     as "이지은 미수금P",
       public.norm_person_name('조윤서미수금p')      as "조윤서미수금p",
       public.norm_person_name('홍길동')             as "표식 없음(그대로)",
       public.norm_person_name('미수금')             as "이름이 표식뿐(원본 유지)";

select '이름에 표식이 붙은 행' as "항목",
       count(*) filter (where "이름" ~ '미수금')                    as "members",
       (select count(*) from public.reservations where "이름" ~ '미수금') as "reservations"
from public.members;
