-- ============================================================================
-- 마일스톤 오발송 정리 — "아직 오지 않은 회차"로 나간 메시지를 지운다
-- ----------------------------------------------------------------------------
-- 🔥 배경 (2026-08-14 반포 · 실사고)
--    "구태희님, 오늘로 10번째 수업이에요!" 가 슬랙으로 나갔는데 **실제 출석은 4회**였다.
--    원인: 누적 사용횟수를 members 의 **행 단위 합**으로 냈다. members 한 행은 사람도
--    수강권도 아니고 (수강권 등록건 × 결제건 × 그때의 이름)이라, 같은 수강권 한 장이
--      · 이름 표식('구태희' / '구태희 미수금')이 붙었다 떼어지는 사이의 재업로드
--      · 미수금 완납·추가 결제로 갈라진 결제 행
--    때문에 여러 행으로 남고, 그 행들이 **같은 잔여횟수를 각자 들고 있다.**
--    구태희: 5행(1+1+1+3+3) = 9 → "내일이 10회차". 등록건으로 접으면 1+3 = 4 가 맞다.
--    실측: 전 회원 7,690명 중 583명의 누적이 부풀어 있었다(최대 615회).
--
--    코드 쪽 수정은 shared/crm-core.mjs 의 usageAudit/dedupeTicketRows 다(등록건별로 접는다).
--    이 파일은 **이미 발송된 잘못된 메시지**만 정리한다.
--
-- 왜 지워야 하나 — 마일스톤은 재발송억제 '평생 1회'다. 잘못 나간 "10회차" 기록이 남아
--    있으면 그 회원이 **진짜 10회차**에 도달했을 때 축하가 영영 억제된다.
--
-- 판정 기준(보수적): 발송 회차 > 현재 누적 + 1  →  잘못된 발송으로 본다.
--    출석은 되돌아가지 않으므로, 지금도 도달하지 못한 회차라면 발송 시점엔 더 확실히 틀렸다.
--    (경계에 있는 정상 발송은 건드리지 않는다 — 실측 5건 중 2건은 그대로 남는다)
--
-- ⚠️ 지우면 그 행의 강사 피드백(실행여부/반응/메모)도 같이 사라진다.
--    먼저:  npm run db:backup crm_messages
--    실행:  npm run db:sql sql/2026-08_fix_milestone_overcount.sql
--    한 파일 = 한 트랜잭션이라 중간에 실패하면 통째로 롤백된다. 재실행 안전(idempotent).
-- ============================================================================

-- 1) 사람별 누적 — shared/crm-core.mjs 의 usageAudit 과 **같은 공식**
--    (수강권명, 수강권시작일)별 대표 1건 = max(used_count) → 사람 단위로 합산
create temporary table _mile_now on commit drop as
with rows_ as (
  select public.norm_person_name("이름") || chr(31)
         || regexp_replace(coalesce("연락처", ''), '[^0-9]', '', 'g') as pk,
         coalesce("수강권명", '')      as ticket,
         coalesce("수강권시작일", '')  as started,
         coalesce(used_count, 0)      as used
  from public.members
), per_ticket as (
  select pk, ticket, started, max(used) as used_max
  from rows_ group by 1, 2, 3
)
select pk, sum(greatest(used_max, 0))::int as 누적
from per_ticket group by pk;

-- 2) 지울 대상 — 발송 회차가 "현재 누적 + 1" 보다 큰 마일스톤 메시지
create temporary table _mile_bad on commit drop as
select c.id, c."대상일자", c."지점", c."이름", c."규칙키" as 발송회차,
       coalesce(n.누적, 0) as 현재누적
from public.crm_messages c
left join _mile_now n on n.pk = c.person_key
where c.rule_id = 'milestone'
  and c."규칙키" ~ '^[0-9]+$'
  and n.pk is not null                              -- 사람을 못 붙인 건 건드리지 않는다
  and c."규칙키"::int > coalesce(n.누적, 0) + 1;

-- 3) 안전장치 — 대량 삭제면 공식이 틀린 것으로 보고 중단
--    ⚠️ 비율만 보면 안 된다. 도입 초기엔 마일스톤 메시지 자체가 몇 건뿐이라
--       "5건 중 3건이 잘못"이 **정상적인 실제 상태**다(2026-08-14 실측이 정확히 그랬다).
--       그래서 표본이 20건 이상일 때만 비율을 보고, 절대 건수 상한도 함께 둔다.
do $$
declare
  total int;
  bad   int;
begin
  select count(*) into total from public.crm_messages where rule_id = 'milestone';
  select count(*) into bad   from _mile_bad;
  if bad > 100 or (total >= 20 and bad::numeric / total > 0.5) then
    raise exception
      '중단: 마일스톤 % 건 중 % 건을 지우려 합니다. 누적 공식이 members 실제 값과 어긋난 것으로 보입니다.',
      total, bad;
  end if;
  raise notice '마일스톤 % 건 중 % 건 정리', total, bad;
end $$;

-- 4) 삭제
delete from public.crm_messages c using _mile_bad b where c.id = b.id;

-- 5) 점검 — 무엇을 지웠나 / 남은 마일스톤은 회차가 말이 되나
select "대상일자", "지점", "이름", 발송회차, 현재누적, '삭제됨' as 결과
from _mile_bad order by "대상일자", "지점";

select c."대상일자", c."지점", c."이름", c."규칙키" as 발송회차,
       coalesce(n.누적, 0) as 현재누적, '유지' as 결과
from public.crm_messages c
left join _mile_now n on n.pk = c.person_key
where c.rule_id = 'milestone'
order by c."대상일자" desc, c."지점";
