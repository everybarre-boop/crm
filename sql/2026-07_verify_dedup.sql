-- ============================================================================
-- Phase 0 점검 — members.dedup_key 실재 확인
-- ----------------------------------------------------------------------------
-- 목적: 일간 자동 갱신(apply_attendance RPC)과 업로드 upsert(onConflict:'dedup_key')가
--       members.dedup_key 컬럼 + 유니크 인덱스에 의존한다. 착수 전에 이 세 가지가
--       실제 운영 DB에 존재하는지 눈으로 확인한다.
--       (CLAUDE.md 는 sql/2026-07_dedup_members.sql 적용으로 해소됐다고 하나,
--        갱신 로직이 여기 의존하므로 직접 확인한다.)
--
-- 실행: Supabase → SQL Editor 에 붙여넣고 실행. 아래 3개 쿼리 결과를 확인.
-- ============================================================================

-- 1) dedup_key 컬럼이 members·sales 양쪽에 있는가? (2행이 나와야 정상)
select table_name, column_name, data_type
from information_schema.columns
where table_schema = 'public'
  and table_name in ('members', 'sales')
  and column_name = 'dedup_key'
order by table_name;

-- 2) dedup_key 유니크 인덱스가 있는가? (members_dedup_key_uidx 등 unique 인덱스가 보여야 함)
select tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in ('members', 'sales')
  and indexdef ilike '%dedup_key%'
order by tablename;

-- 3) dedup_key 가 실제 값과 어긋난 행이 있는가? (0 이어야 정상 — makeKey 공식과 일치 확인)
--    공식: 이름 ∣ 연락처 ∣ 수강권명 ∣ 등록일 ∣ 전체횟수  (chr(31) 구분, NULL→'')
select count(*) as "공식과_어긋난_행수"
from public.members m
where m.dedup_key is distinct from (
       coalesce(m."이름",     '') || chr(31)
    || coalesce(m."연락처",   '') || chr(31)
    || coalesce(m."수강권명", '') || chr(31)
    || coalesce(m."등록일",   '') || chr(31)
    || coalesce(m."전체횟수", '')
);
-- → 이 값이 0 이 아니면, apply_attendance 반영 전에 dedup_key 를 재백필해야 한다.
--   (재백필 공식은 sql/2026-07_dedup_members.sql 참고.)
