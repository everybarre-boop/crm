-- ============================================================================
-- 에블바레 — branch_costs (지점별·월별 비용) 테이블 + RLS
-- ----------------------------------------------------------------------------
-- Supabase → SQL Editor 에 그대로 붙여 1회 실행하세요. (idempotent — 재실행 안전)
-- 용도: 대시보드의 "비용 총합 / 인건비 비율 / 임대료 비율"을 계산할 비용 데이터.
--       매출은 sales 에서 자동 집계하고, 비용은 관리자가 이 테이블에 월별로 입력한다.
-- 보안 모델은 members/sales 와 동일 — 관리자 이메일 화이트리스트 RLS 가 유일한 방어선.
-- 이 파일은 lib/db/schema.ts 의 branchCosts 정의와 짝을 이룹니다.
-- ============================================================================

-- 1) 테이블 -----------------------------------------------------------------------
create table if not exists public.branch_costs (
  id           bigint generated always as identity primary key,
  "지점"        text not null,               -- BRANCHES 중 하나 (청담·옥수·광교·반포·판교·송파)
  "연월"        text not null,               -- 'YYYY-MM'
  "인건비"      integer not null default 0,
  "임대료"      integer not null default 0,
  "기타비용"    integer not null default 0,
  "메모"        text,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  unique ("지점", "연월")                     -- upsert onConflict 대상
);

create index if not exists branch_costs_ym_idx on public.branch_costs ("연월");

-- 2) RLS : 관리자 이메일 화이트리스트 (members/sales 와 동일) ------------------------
alter table public.branch_costs enable row level security;

drop policy if exists "admins_full_access" on public.branch_costs;
create policy "admins_full_access"
on public.branch_costs
for all
to authenticated
using      ( (auth.jwt() ->> 'email') = any (array['basegolf.official@gmail.com']) )
with check ( (auth.jwt() ->> 'email') = any (array['basegolf.official@gmail.com']) );
