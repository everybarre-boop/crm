-- ============================================================================
-- 회원 엑셀 재업로드 후 점검 — "정말 들어왔는가"를 확인한다
-- ----------------------------------------------------------------------------
-- 🔥 업로드는 upsert 라 **행수가 안 늘어도 정상일 수 있다**(전부 덮어쓰기).
--    반대로 아무것도 반영되지 않았을 때도 행수는 그대로다. 둘이 구분되지 않는다.
--    그래서 행수가 아니라 **최근 날짜 데이터가 있는가**로 판정한다.
--
-- 읽기 전용(SELECT 뿐)이라 언제 돌려도 안전하다.
--   npm run db:sql sql/2026-08_verify_upload.sql
--
-- ⚠️ 개인정보를 뽑지 않는다 — 전부 집계다. 이름·연락처를 여기에 넣지 말 것
--    (결과가 터미널·로그에 남는다).
-- ============================================================================

-- 1) 전체 규모 --------------------------------------------------------------
select '전체 규모' as "항목",
       (select count(*) from public.members)                    as "members 행",
       (select count(*) from public.sales)                      as "sales 행",
       (select count(distinct public.norm_person_name("이름")
                     || '|' || regexp_replace(coalesce("연락처",''), '[^0-9]', '', 'g'))
          from public.members)                                  as "고유 회원수",
       (select coalesce(sum(used_count), 0) from public.members) as "총 사용횟수";


-- 2) 🔑 최근 결제가 들어왔는가 — 업로드 반영 여부의 핵심 지표 -----------------
--    재업로드가 제대로 됐으면 **최근 며칠치 결제 건이 있어야 한다.**
--    최근 7일이 0건이면 업로드가 안 됐거나 오래된 파일을 올린 것이다.
select '최근 결제(members)' as "항목",
       count(*) filter (where public.ymd_num("결제일시") >= to_char(current_date - 1,  'YYYYMMDD')::bigint) as "어제 이후",
       count(*) filter (where public.ymd_num("결제일시") >= to_char(current_date - 7,  'YYYYMMDD')::bigint) as "7일 이내",
       count(*) filter (where public.ymd_num("결제일시") >= to_char(current_date - 14, 'YYYYMMDD')::bigint) as "14일 이내",
       count(*) filter (where public.ymd_num("결제일시") >= to_char(current_date - 30, 'YYYYMMDD')::bigint) as "30일 이내",
       max("결제일시")                                                                                      as "가장 최근 결제일시"
from public.members;

select '최근 결제(sales)' as "항목",
       count(*) filter (where public.ymd_num("결제일시") >= to_char(current_date - 7,  'YYYYMMDD')::bigint) as "7일 이내",
       count(*) filter (where public.ymd_num("결제일시") >= to_char(current_date - 30, 'YYYYMMDD')::bigint) as "30일 이내",
       max("결제일시")                                                                                      as "가장 최근 결제일시"
from public.sales;


-- 3) 수강권 시작일 기준 — 새 등록건이 들어왔는가 ------------------------------
select '수강권 시작일' as "항목",
       count(*) filter (where public.ymd_num("수강권시작일") >= to_char(current_date - 7,  'YYYYMMDD')::bigint) as "7일 이내 시작",
       count(*) filter (where public.ymd_num("수강권시작일") >= to_char(current_date - 30, 'YYYYMMDD')::bigint) as "30일 이내 시작",
       max("수강권시작일")                                                                                       as "가장 늦은 시작일"
from public.members;


-- 4) 지점별 분포 — 특정 지점 파일이 빠지지 않았는지 --------------------------
--    지점은 수강권명 안에 있다(CLAUDE.md "지점은 수강권명 안에 있다").
select coalesce(nullif(b.지점, ''), '(태그없음)') as "지점",
       count(*)                                    as "행수",
       count(*) filter (
         where public.ymd_num(b."수강권시작일") >= to_char(current_date - 30, 'YYYYMMDD')::bigint
       )                                           as "최근30일 시작"
from (
  select m.*,
         case
           when m."수강권명" like '%청담%' then '청담'
           when m."수강권명" like '%판교%' then '판교'
           when m."수강권명" like '%광교%' then '광교'
           when m."수강권명" like '%옥수%' then '옥수'
           when m."수강권명" like '%반포%' then '반포'
           when m."수강권명" like '%송파%' then '송파'
           else ''
         end as 지점
  from public.members m
) b
group by 1
order by 2 desc;


-- 5) 품질 — 키 컬럼이 비어 있으면 다음 업로드에서 중복이 생긴다 ---------------
--    ⚠️ `연락처`가 비면 dedup_key 가 달라져 **같은 사람이 새 행으로 쌓인다**
--       (2026-08 에 실제로 겪은 사고. CLAUDE.md "dedup_key 불변식" 참고).
select '키 컬럼 결손' as "항목",
       count(*) filter (where coalesce("이름", '')       = '') as "이름 빈값",
       count(*) filter (where coalesce("연락처", '')     = '') as "연락처 빈값",
       count(*) filter (where coalesce("수강권명", '')   = '') as "수강권명 빈값",
       count(*) filter (where coalesce("결제일시", '')   = '') as "결제일시 빈값",
       count(*) filter (where coalesce("전체횟수", '')   = '') as "전체횟수 빈값"
from public.members;
