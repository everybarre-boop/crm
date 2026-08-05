-- ============================================================================
-- ⛔️ 폐기됨 (2026-08) — 실행하지 말 것. 기록 보존용으로만 남긴다.
-- ----------------------------------------------------------------------------
-- 이 파일은 members 에 dedup_key 를 처음 도입했을 때(2026-07) 쓴 스크립트다.
-- 여기 적힌 키 공식(이름·연락처·수강권명·**등록일**·**전체횟수**)은 **옛 공식**이며,
-- 2026-08 에 KEY_COLS 가 9컬럼으로 개정되면서 코드와 어긋난 상태가 됐다.
--
-- 🔥 지금 이 파일을 실행하면 데이터가 파괴된다:
--    ① 전 행의 dedup_key 가 옛 공식으로 되돌아가고,
--    ② 이어지는 "중복 삭제"가 **같은 사람이 같은 수강권을 재등록한 행을 전부 지운다**.
--       (이가원 55행 → 23행, 전체 사용횟수 124,839 → 65,201 로 날아갔던 바로 그 사고가
--        이번엔 DB 행 삭제로 재현되어 복구가 불가능해진다.)
--
-- ✅ 재백필이 필요하면 → sql/2026-08_rekey_dedup_keys.sql 을 쓸 것.
-- ✅ 현재 공식 확인    → sql/2026-07_verify_dedup.sql
--
-- 아래 본문은 전부 주석 처리해 두었다. 되살리지 말 것.
-- ============================================================================

/*  ── 폐기된 본문 (실행 금지) ────────────────────────────────────────────────
-- 0) 연락처 컬럼 신설 (members · sales). 기존 행은 NULL(빈 값).
alter table public.members add column if not exists "연락처" text;
alter table public.sales   add column if not exists "연락처" text;

-- 1) dedup_key 컬럼 추가(members) + 백필.  ⚠️ 옛 공식 — 지금 돌리면 키가 깨진다.
alter table public.members add column if not exists dedup_key text;

update public.members set dedup_key =
       coalesce("이름",   '') || chr(31)
    || coalesce("연락처", '') || chr(31)
    || coalesce("수강권명", '') || chr(31)
    || coalesce("등록일", '') || chr(31)
    || coalesce("전체횟수", '');

-- 2) 중복 삭제 — ⚠️ 위 옛 공식과 짝이라 재등록 행을 통째로 지운다.
delete from public.members m
using public.members keep
where m.dedup_key = keep.dedup_key
  and m.id < keep.id;

-- 3) 유니크 인덱스 — 앞으로 upsert(onConflict:'dedup_key')가 "덮어쓰기"로 동작.
create unique index if not exists members_dedup_key_uidx on public.members (dedup_key);
    ──────────────────────────────────────────────────────────────────────── */

-- (참고) sales 는 이전 마이그레이션에서 dedup_key text unique 를 이미 두었고 현재 비어
--         있으므로 별도 정리가 필요 없다. 위 0)에서 연락처 컬럼만 추가했다.
