-- ============================================================================
-- 사람 단위 출석 수가 다지점 회원에게서 크게 틀리던 것을 고친다 (2026-11-04)
-- ----------------------------------------------------------------------------
-- 🔥 실사고: 신예나(청담·판교·반포·광교·옥수 수강권) — 회원별 집계 출석 164회.
--    실제는 청담 사이트 460 + 반포 69 + 광교 71 = 600회 이상. 원인이 셋 겹쳤다.
--
--    ① 이름의 금액 표식이 사람을 갈랐다.
--       청담 사이트 이름이 "신예나 1184000 미수금" → 정규화가 '미수금'만 떼서
--       person_key 가 '신예나 1184000⋮…' 로 따로 생겼다. members 의 '신예나' 와 안 붙어
--       출석 460회가 화면에서 통째로 빠졌다. (금액 표식 고유 이름 18개)
--       → norm_person_name 에 금액·강아지 표식 추가 + 저장된 person_key 재키잉.
--
--    ② 기준일 이후 가산이 사이트를 구분하지 않았다.
--       광교 행은 9/18 에 읽은 값(71)이라 그 뒤 출석을 reservations 에서 더하는데,
--       **다른 사이트(청담·반포)의 출석까지** 더했다 — 그 사이트들은 11/3~4 에 이미 읽어
--       기준선에 들어 있으므로 이중 계수다. JS 쪽 makeAttendanceCounter 는 처음부터
--       사이트별로 나눴는데 이 뷰만 빠져 있었다.
--
--    ③ reservations.person_key(생성 컬럼)는 이름을 정규화하지 않는다.
--       "신예나 미수금" 으로 잡힌 예약은 '신예나⋮…' 와 조인되지 않아 가산에서 빠졌다.
--       → 뷰가 reservations 를 norm_person_name(이름) + 숫자연락처로 직접 조인한다.
--       (생성 컬럼 자체는 res_key 와 무관하지만 인덱스·다른 뷰가 있어 건드리지 않는다)
--
-- ⚠️ JS 짝: shared/crm-core.mjs 의 normPersonName · makeAttendanceCounter(rekeyPerson).
--    **공식이 같아야 한다.** 한쪽만 고치면 코드 ↔ DB 가 어긋난다.
-- ⚠️ 지점 → 사이트 매핑은 automation/config.mjs 의 SITES 기본값과 같다.
--    SM_SLUG_* 로 slug 를 바꿨다면 아래 CASE 도 같이 바꿀 것.
--
-- 실행:  npm run db:backup crm_attendance crm_messages crm_dormant
--        npm run db:sql sql/2026-11_attendance_person_fix.sql
-- idempotent(재실행 안전). 한 트랜잭션.
-- ============================================================================


-- 1) norm_person_name — 금액·강아지 표식 추가 ---------------------------------
create or replace function public.norm_person_name(s text)
returns text
language sql
immutable
as $$
  select coalesce(
           nullif(
             btrim(
               regexp_replace(
                 -- 금액 표식: 1184000 · 80000원 · 344,000 · 78000 미수 (4자리 이상 또는 천 단위 쉼표)
                 regexp_replace(
                   -- 강아지X / 강아지 O
                   regexp_replace(
                     -- 촬영X / 촬영x / 촬영 X
                     regexp_replace(
                       -- 15기 / M1 13기 / M2 2기 — 숫자를 요구해 이름의 '기'를 건드리지 않는다
                       regexp_replace(
                         -- 미수금 / 전액미수금 / 미수금P
                         regexp_replace(coalesce(s, ''), '\s*(전액)?\s*미수금\s*[Pp]?', ' ', 'g'),
                         '\s*(M\s*\d+\s*)?\d+\s*기(?=\s|$)', ' ', 'g'
                       ),
                       '\s*촬영\s*[XxOo]?(?=\s|$)', ' ', 'g'
                     ),
                     '\s*강아지\s*[XxOo](?=\s|$)', ' ', 'g'
                   ),
                   '\s*(?:\d{1,3}(?:,\d{3})+|\d{4,})\s*원?\s*(?:미수)?(?=\s|$)', ' ', 'g'
                 ),
                 '\s+', ' ', 'g'
               )
             ),
             ''
           ),
           btrim(coalesce(s, ''))
         );
$$;

comment on function public.norm_person_name(text) is
  '이름의 임시 표식(미수금, N기, 촬영X, 강아지X, 금액) 제거. shared/crm-core.mjs 의 normPersonName() 과 같은 공식이어야 한다.';


-- 2) 저장된 person_key 재키잉 ---------------------------------------------------
--    키 = 이름부 ⋮ 나머지. 이름부만 새 규칙으로 다시 정규화하고 나머지(연락처, '?⋮dedup')는 둔다.
--    crm_attendance 는 person_key 에 유니크가 없다(유니크는 site+회원id).
update public.crm_attendance
set person_key = public.norm_person_name(split_part(person_key, chr(31), 1))
                 || substr(person_key, strpos(person_key, chr(31)))
where strpos(person_key, chr(31)) > 0
  and public.norm_person_name(split_part(person_key, chr(31), 1)) <> split_part(person_key, chr(31), 1);

--    발송 이력도 같이 옮긴다 — 안 옮기면 마일스톤 "평생 1회" 억제가 그 회원에게서 풀린다.
--    유니크 충돌이 나는 행은 건드리지 않는다(이미 새 키로 같은 이력이 있다는 뜻).
update public.crm_messages m
set person_key = public.norm_person_name(split_part(m.person_key, chr(31), 1))
                 || substr(m.person_key, strpos(m.person_key, chr(31)))
where strpos(m.person_key, chr(31)) > 0
  and public.norm_person_name(split_part(m.person_key, chr(31), 1)) <> split_part(m.person_key, chr(31), 1)
  and not exists (
    select 1 from public.crm_messages x
    where x."대상일자" = m."대상일자" and x."지점" = m."지점"
      and x.rule_id = m.rule_id and x."규칙키" is not distinct from m."규칙키"
      and x.person_key = public.norm_person_name(split_part(m.person_key, chr(31), 1))
                         || substr(m.person_key, strpos(m.person_key, chr(31)))
  );

update public.crm_dormant d
set person_key = public.norm_person_name(split_part(d.person_key, chr(31), 1))
                 || substr(d.person_key, strpos(d.person_key, chr(31)))
where strpos(d.person_key, chr(31)) > 0
  and public.norm_person_name(split_part(d.person_key, chr(31), 1)) <> split_part(d.person_key, chr(31), 1)
  and not exists (
    select 1 from public.crm_dormant x
    where x.person_key = public.norm_person_name(split_part(d.person_key, chr(31), 1))
                         || substr(d.person_key, strpos(d.person_key, chr(31)))
  );


-- 3) crm_attendance_person — 사이트별 가산 + 정규화 조인 ------------------------
--    ⚠️ 컬럼 구성·순서·타입은 2026-08_attendance_truth.sql 원본과 같게 유지한다
--       (create or replace view 는 컬럼을 바꾸면 실패한다).
create or replace view public.crm_attendance_person
with (security_invoker = on) as
with att as (
  select
    a.*,
    public.norm_person_name(split_part(a.person_key, chr(31), 1))  as nm,
    split_part(a.person_key, chr(31), 2)                           as ph
  from public.crm_attendance a
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
  -- 그 사이트의 기준일 이후 출석만. 사이트를 모르는 예약은 더하지 않는다(지어내지 않는다).
  select att.id, count(*) as n
  from att
  join res
    on  res.nm = att.nm
    and res.ph = att.ph
    and res.site = att.site
    and res.d > att."기준일"
  group by att.id
)
select
  att.nm || chr(31) || att.ph                       as person_key,
  max(att.nm)                                       as "이름",
  count(*)                                          as "사이트수",
  min(att."기준일")                                  as "가장오래된기준일",
  sum(att."출석수")                                  as "기준선합",
  sum(att."출석수" + coalesce(r.n, 0))               as "출석수",
  sum(coalesce(r.n, 0))                             as "이후출석합",
  sum(att."결석수")                                  as "결석수"
from att
left join after_base r on r.id = att.id
group by att.nm, att.ph;

comment on view public.crm_attendance_person is
  '사람 단위 출석 수(전 사이트 합). 사이트별로 기준일 이후의 reservations 출석을 더한다. 이름은 norm_person_name 으로 정규화.';


-- 점검 -------------------------------------------------------------------------
select '표식 제거' as "항목",
       public.norm_person_name('신예나 1184000 미수금') as "금액+미수금",
       public.norm_person_name('황가라 80000원')         as "원",
       public.norm_person_name('진가름24기 344,000미수금p') as "쉼표",
       public.norm_person_name('윤가연 강아지X')          as "강아지",
       public.norm_person_name('체험1')                  as "자리계정(그대로)",
       public.norm_person_name('김미수')                 as "이름의 미수(그대로)";

select count(*) as "아직 옛 키인 crm_attendance 행(0 이어야 함)"
from public.crm_attendance
where strpos(person_key, chr(31)) > 0
  and public.norm_person_name(split_part(person_key, chr(31), 1)) <> split_part(person_key, chr(31), 1);

select count(*) as "같은 연락처가 둘 이상 키로 갈린 사람(crm_attendance)"
from (
  select split_part(person_key, chr(31), 2) ph
  from public.crm_attendance
  where split_part(person_key, chr(31), 2) <> ''
  group by 1
  having count(distinct person_key) > 1
) s;

select count(*) as "뷰 행수" from public.crm_attendance_person;
