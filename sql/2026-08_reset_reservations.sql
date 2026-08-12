-- ============================================================================
-- reservations 기간 초기화 — 스크래퍼 결함이 남긴 행을 지우고 다시 채우기 위한 것
-- ----------------------------------------------------------------------------
-- ⚠️ 실행 전 반드시:  npm run db:backup reservations
--
-- 왜 "지우고 다시"인가 —
--   reservations 는 100% 재수집 가능한 파생 데이터다(원본은 스튜디오메이트 화면).
--   2026-08-12 에 찾은 스크래퍼 결함 5개(docs/CRM-SLACK.md 1-8 절)가 남긴 행은
--   구조적으로는 멀쩡해 보여서 조건으로 골라내기 어렵다. 예를 들어
--     · 헤더가 안 그려진 채 읽혀 `수업명=''` · `수업시간`=스크랩 시각인 행 (실측 73건)
--     · 헤더는 A 수업인데 목록은 B 수업이라 사람×수업 짝이 어긋난 행 (실측 55건)
--   후자는 이름도 수업명도 실재해서 SQL 로 구분할 수 없다.
--   기간을 통째로 지우고 고친 스크래퍼로 다시 채우는 게 유일하게 확실한 방법이다.
--
-- ⛔️ members 는 건드리지 않는다. 백필도 apply_attendance 를 부르지 않으므로
--    사용횟수/잔여횟수는 이 작업과 무관하다.
--
-- 실행:
--   npm run db:backup reservations
--   npm run db:sql sql/2026-08_reset_reservations.sql
--   DRY_RUN=false BACKFILL_DAYS=14 npm run backfill
--   npm run db:sql sql/2026-08_verify_crm.sql        ← 관측일수·건수 확인
--
-- 기간을 바꾸려면 아래 :from / :to 를 고친다(둘 다 포함).
-- 기본값은 "오늘 포함 최근 15일" — 백필 기본 범위(어제부터 14일) + 오늘.
-- ============================================================================

begin;

/* 안전장치 ① — 관리자만. RLS 를 우회하는 경로를 만들지 않기 위해,
   이 파일은 DATABASE_URL(전권)로 도는 db:sql 전용이지만 지운 양을 반드시 남긴다. */

create temporary table _reset_scope as
select
  (current_date - interval '14 day')::date as "시작일",
  current_date                             as "종료일";

/* 안전장치 ② — 지우기 전 현황을 찍는다. 예상보다 많으면 여기서 멈추고 판단할 것. */
select
  s."시작일",
  s."종료일",
  count(*)                                                  as "지울 행수",
  count(*) filter (where r."수업명" = '')                    as "그중 수업명 빈 행",
  min(r."예약일자")                                          as "실제 최소일",
  max(r."예약일자")                                          as "실제 최대일"
from _reset_scope s
left join public.reservations r
  on r."예약일자" between s."시작일" and s."종료일"
group by s."시작일", s."종료일";

/* 안전장치 ③ — 범위 밖 행은 건드리지 않는다. 범위 밖에 행이 남아 있으면
   그건 이 정리의 대상이 아니므로 그대로 둔다(백필이 안 채우는 기간이다). */
delete from public.reservations r
using _reset_scope s
where r."예약일자" between s."시작일" and s."종료일";

commit;

-- 확인 — 여기서 0 이어야 한다(범위 안이 비었는지). 범위 밖 행수도 함께 본다.
select
  count(*) filter (
    where "예약일자" between (current_date - interval '14 day')::date and current_date
  ) as "범위 안 남은 행(0이어야 함)",
  count(*) as "테이블 전체 행수",
  min("예약일자") as "최소일",
  max("예약일자") as "최대일"
from public.reservations;
