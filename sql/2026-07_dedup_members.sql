-- ============================================================================
-- members 중복 정리 + 연락처 컬럼 + dedup_key 유니크 (재업로드 덮어쓰기 활성화)
-- ----------------------------------------------------------------------------
-- 중복 기준: 이름 · 연락처 · 수강권명 · 등록일 · 전체횟수 가 모두 같으면 중복.
--            → 그중 가장 최신(id 최대) 1건만 남기고 나머지는 삭제한다.
-- ⚠️ 삭제가 포함된 되돌리기 어려운 작업이다. 실행 전 백업을 권장한다.
--    (Supabase → Database → Backups, 또는 members 테이블 CSV 내보내기)
-- Supabase → SQL Editor 에 전체를 붙여 1회 실행. (idempotent)
-- 코드의 KEY_COLS([lib/members.ts])와 아래 dedup_key 공식은 반드시 일치해야 한다.
-- ============================================================================

-- 0) 연락처 컬럼 신설 (members · sales). 기존 행은 NULL(빈 값).
alter table public.members add column if not exists "연락처" text;
alter table public.sales   add column if not exists "연락처" text;

-- 1) dedup_key 컬럼 추가(members) + 백필.
--    앱의 makeKey 와 동일 규칙: KEY_COLS 를 chr(31)(Unit Separator)로 잇고 NULL→''.
alter table public.members add column if not exists dedup_key text;

update public.members set dedup_key =
       coalesce("이름",   '') || chr(31)
    || coalesce("연락처", '') || chr(31)
    || coalesce("수강권명", '') || chr(31)
    || coalesce("등록일", '') || chr(31)
    || coalesce("전체횟수", '');

-- 2) 중복 삭제 — 같은 dedup_key 중 id 가 가장 큰(최신) 1건만 남긴다.
delete from public.members m
using public.members keep
where m.dedup_key = keep.dedup_key
  and m.id < keep.id;

-- 3) 유니크 인덱스 — 앞으로 upsert(onConflict:'dedup_key')가 "덮어쓰기"로 동작.
create unique index if not exists members_dedup_key_uidx on public.members (dedup_key);

-- (참고) sales 는 이전 마이그레이션에서 dedup_key text unique 를 이미 두었고 현재 비어
--         있으므로 별도 정리가 필요 없다. 위 0)에서 연락처 컬럼만 추가했다.
