-- ============================================================================
-- 점검(읽기 전용) — 누적 사용횟수가 부풀어 있나 / 두 기록이 어긋나나
-- ----------------------------------------------------------------------------
-- 회차·횟수를 말하는 멘트가 나가기 전에 확인하는 자리다.
-- 코드 짝: shared/crm-core.mjs 의 usageAudit / dedupeTicketRows,
--         shared/crm-rules.mjs 의 verifyMilestone. **공식이 같아야 한다.**
--   · 누적 = (수강권명, 수강권시작일)별 max(used_count) 를 사람 단위로 합산
--     (같은 수강권 한 장이 이름 표식·결제 분할로 여러 행이고, 그 행들이 같은 잔여를 든다)
--
-- 실행:  npm run db:sql sql/2026-08_verify_used_count.sql
-- 데이터를 바꾸지 않는다. 언제 돌려도 안전하다.
-- ============================================================================

-- ① 부풀림 규모 — 행 합(옛 공식) vs 등록건 합(현재 공식)
with rows_ as (
  select public.norm_person_name("이름") || chr(31)
         || regexp_replace(coalesce("연락처", ''), '[^0-9]', '', 'g') as pk,
         coalesce("수강권명", '') as ticket, coalesce("수강권시작일", '') as started,
         coalesce(used_count, 0) as used
  from public.members
), per_ticket as (
  select pk, ticket, started, max(used) as used_max, sum(used) as used_sum
  from rows_ group by 1, 2, 3
), per_person as (
  select pk, sum(used_sum) as 행합, sum(greatest(used_max, 0)) as 등록건합
  from per_ticket group by pk
)
select count(*)                                   as 인원,
       count(*) filter (where 행합 <> 등록건합)     as 부풀려진_인원,
       sum(행합)                                   as 합계_행합,
       sum(등록건합)                                as 합계_등록건합,
       max(행합 - 등록건합)                          as 최대_부풀림
from per_person;

-- ② 마일스톤 경계에 있는 사람 — 두 기록이 어긋나면 발송이 보류된다(verifyMilestone)
with rows_ as (
  select public.norm_person_name("이름") || chr(31)
         || regexp_replace(coalesce("연락처", ''), '[^0-9]', '', 'g') as pk,
         public.norm_person_name("이름") as 이름,
         coalesce("수강권명", '') as ticket, coalesce("수강권시작일", '') as started,
         coalesce(used_count, 0) as used,
         (coalesce("전체횟수", '') = '') as 전체결손,
         public.ymd_date("수강권시작일") as 시작d
  from public.members
), per_ticket as (
  select pk, 이름, ticket, started, max(used) as used_max, bool_or(전체결손) as 결손,
         min(시작d) as 시작d
  from rows_ group by 1, 2, 3, 4
), per_person as (
  select pk, max(이름) as 이름, sum(greatest(used_max, 0)) as 누적,
         bool_or(결손) as 결손, min(시작d) as 최초시작
  from per_ticket group by pk
), res as (
  select "이름" || chr(31) || regexp_replace("연락처", '[^0-9]', '', 'g') as pk,
         count(*) filter (where "예약상태" = '출석') as 출석
  from public.reservations group by 1
), depth as (select min("예약일자") as 관측시작 from public.reservations)
select p.이름, p.누적, coalesce(r.출석, 0) as 관측출석, p.최초시작, d.관측시작,
       case
         when p.결손                                       then '보류: 전체횟수 결손'
         when coalesce(r.출석, 0) > p.누적                  then '보류: 출석기록 > 누적'
         when p.최초시작 >= d.관측시작
              and coalesce(r.출석, 0) <> p.누적             then '보류: 전 이력 관측인데 불일치'
         else '발송 가능'
       end as 판정
from per_person p left join res r using (pk) cross join depth d
where (p.누적 + 1) = any (array[10, 30, 50, 100, 150, 200, 300, 500])
order by 판정, p.누적 desc
limit 40;

-- ③ 발송된 마일스톤이 지금도 말이 되나 (발송회차 ≤ 현재누적+1 이어야 한다)
with rows_ as (
  select public.norm_person_name("이름") || chr(31)
         || regexp_replace(coalesce("연락처", ''), '[^0-9]', '', 'g') as pk,
         coalesce("수강권명", '') as ticket, coalesce("수강권시작일", '') as started,
         coalesce(used_count, 0) as used
  from public.members
), per_ticket as (
  select pk, ticket, started, max(used) as used_max from rows_ group by 1, 2, 3
), per_person as (
  select pk, sum(greatest(used_max, 0)) as 누적 from per_ticket group by pk
)
select c."대상일자", c."지점", c."이름", c."규칙키" as 발송회차,
       coalesce(n.누적, 0) as 현재누적,
       case when c."규칙키" ~ '^[0-9]+$' and c."규칙키"::int > coalesce(n.누적, 0) + 1
            then '⚠️ 아직 도달하지 않은 회차' else 'OK' end as 판정
from public.crm_messages c
left join per_person n on n.pk = c.person_key
where c.rule_id = 'milestone'
order by c."대상일자" desc, c."지점";
