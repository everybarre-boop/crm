-- ============================================================================
-- 에블바레 회원 데이터 — sales 테이블 + members.used_count 필터 컬럼
-- ----------------------------------------------------------------------------
-- Supabase → SQL Editor 에 그대로 붙여 1회 실행하세요. (idempotent — 재실행 안전)
-- 적용 대상: (1) 회원/대시보드의 "사용횟수 범위" 필터  (2) 매출 분리 업로드
-- 이 파일은 lib/db/schema.ts 와 짝을 이룹니다(같은 정의). DATABASE_URL 이 있으면
-- `npm run db:generate && npm run db:migrate` 로도 반영할 수 있지만, 서버 없는
-- 정적 앱이라 Supabase SQL Editor 로 직접 실행하는 편이 간단합니다.
-- ============================================================================

-- 1) members.used_count : 사용횟수(전체−잔여) 계산 컬럼 --------------------------
--    "3", "3회" 처럼 텍스트로 저장된 값에서 숫자만 뽑아 계산한다(비숫자→0).
--    STORED 생성 컬럼이라 업로드 upsert 에는 넣지 않는다(자동 계산).
alter table public.members
  add column if not exists used_count integer
  generated always as (
    COALESCE(NULLIF(regexp_replace(COALESCE("전체횟수", ''), '[^0-9-]', '', 'g'), '')::int, 0)
    - COALESCE(NULLIF(regexp_replace(COALESCE("잔여횟수", ''), '[^0-9-]', '', 'g'), '')::int, 0)
  ) stored;

-- 범위(.gte/.lte) 조회 가속용 인덱스
create index if not exists members_used_count_idx on public.members (used_count);


-- 2) sales : 매출(결제) 전용 테이블 ------------------------------------------------
create table if not exists public.sales (
  id           bigint generated always as identity primary key,
  "이름"        text,
  "생년월일"     text,
  "수강권명"     text,
  "수강권종류"   text,
  "등록일"      text,
  "결제구분"     text,
  "결제금액"     text,
  "결제일시"     text,
  "결제방법"     text,
  "할부개월수"   text,
  dedup_key    text unique,          -- 재업로드 중복 방지(upsert onConflict 대상)
  raw          jsonb,
  created_at   timestamptz default now()
);


-- 3) sales RLS : 관리자 이메일 화이트리스트 (members 와 동일 · 유일한 PII 방어선) -----
alter table public.sales enable row level security;

drop policy if exists "admins_full_access" on public.sales;
create policy "admins_full_access"
on public.sales
for all
to authenticated
using      ( (auth.jwt() ->> 'email') = any (array['basegolf.official@gmail.com']) )
with check ( (auth.jwt() ->> 'email') = any (array['basegolf.official@gmail.com']) );
