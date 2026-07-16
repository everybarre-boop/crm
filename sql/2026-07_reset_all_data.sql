-- ⚠️ 전체 데이터 초기화 (members + sales) — 되돌릴 수 없음
--
-- 목적: 회원/매출 데이터를 전부 비우고 0건 상태에서 엑셀을 다시 업로드한다.
-- 실행: Supabase → SQL Editor 에 붙여넣고 실행.
-- 테이블 구조(컬럼/생성컬럼/유니크 인덱스/RLS 정책)는 그대로 유지되고 행만 지운다.
--
-- ── 실행 전 반드시 확인 ──────────────────────────────────────────
-- 1) 아래 "1. 현재 건수 확인"만 먼저 실행해서 지워질 양을 눈으로 본다.
-- 2) 되돌릴 방법이 없으므로, 다시 업로드할 원본 엑셀이 손에 있는지 확인한다.
--    (백업이 필요하면 Supabase → Table Editor 에서 CSV Export 를 먼저 받아둘 것)
-- ────────────────────────────────────────────────────────────────

-- 1. 현재 건수 확인 (먼저 이것만 실행)
select 'members' as table_name, count(*) from public.members
union all
select 'sales', count(*) from public.sales;


-- 2. 전체 삭제 (위 건수를 확인한 뒤에 실행)
--    identity/serial 컬럼이 있으면 번호도 1부터 다시 시작한다.
truncate table public.members, public.sales restart identity;


-- 3. 결과 확인 — 둘 다 0 이어야 한다
select 'members' as table_name, count(*) from public.members
union all
select 'sales', count(*) from public.sales;
