-- ============================================================================
-- 2026-08 재키잉 — 개정된 KEY_COLS / SALES_KEY_COLS 를 기존 DB 에 반영
-- ----------------------------------------------------------------------------
-- 왜 필요한가:
--   lib/members.ts 의 KEY_COLS 와 lib/sales.ts 의 SALES_KEY_COLS 가 2026-08 에 바뀌었다.
--     members : 이름·연락처·수강권명·[등록일]·[전체횟수]
--            →  이름·연락처·수강권명·수강권시작일·결제구분·결제금액·결제일시·결제방법·할부개월수
--     sales   : [생년월일] 제거
--   DB 에 쌓인 dedup_key 는 아직 **옛 공식**으로 계산된 값이다. 이 상태로 새 코드를 배포하고
--   엑셀을 올리면 upsert 의 onConflict 가 전부 빗나가 **모든 행이 새로 INSERT** 된다
--   → 전량 중복 → 1인 합산 사용횟수가 정확히 2배. (CLAUDE.md 가 두 번 겪었다고 기록한 사고)
--   그래서 **새 코드를 배포하기 전에** 이 스크립트로 DB 의 키를 새 공식에 맞춘다.
--
-- ⚠️ 재키잉만으로는 "잃어버린 행"이 돌아오지 않는다.
--   옛 키가 거칠어서(등록일이 항상 빈 값) 재등록 건이 이미 1행으로 합쳐진 채 저장돼 있다.
--   재키잉은 앞으로의 중복만 막는다. **원본 엑셀을 다시 업로드해야** 합쳐졌던 행이
--   서로 다른 키로 복원된다(= 사용횟수 48% 누락 복구). 권장 순서:
--     ① npm run db:backup members sales   ② 이 스크립트 실행   ③ 새 코드 배포
--     ④ 전 지점 원본 엑셀 재업로드          ⑤ sql/2026-07_verify_dedup.sql 로 확인
--   (초기화 후 재업로드하는 방법도 있다 — sql/2026-07_reset_all_data.sql. 원본 엑셀이
--    전부 손에 있을 때만 그쪽이 더 깨끗하다.)
--
-- 실행: Supabase → SQL Editor. **1번(점검)만 먼저 실행**해서 숫자를 눈으로 본 뒤,
--       2번(적용)을 실행한다. 2번은 하나의 트랜잭션이라 중간에 실패하면 전부 롤백된다.
--
-- 📌 2026-08-05 실측: 운영 DB 는 **이미 새 공식과 일치한다**(members 17,617행 / sales 17,602행,
--    키가 바뀌는 행 0, 새 키 충돌 0). 2026-08-04 초기화 + 전 지점 재업로드가 새 키 기준으로
--    들어갔기 때문이다. 즉 **지금은 이 스크립트를 돌릴 필요가 없다.**
--    이 파일은 (a) 키 컬럼을 또 바꿀 때, (b) 옛 키가 섞인 백업을 복원했을 때,
--    (c) verify_dedup.sql 의 "공식과_어긋난_행수"가 0이 아닐 때 쓰는 복구 도구다.
--    아래 2번은 어긋난 행만 골라 고치므로, 일치 상태에서 실행하면 아무것도 바꾸지 않는다.
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- 1. 점검 — 읽기 전용. 먼저 이 블록만 실행할 것.
-- ════════════════════════════════════════════════════════════════════════════

-- 1-a) 키가 바뀌는 행 수 (거의 전 행이어야 정상 — 공식이 통째로 바뀌었으므로)
select
  (select count(*) from public.members) as "members_전체",
  (select count(*) from public.members m
     where m.dedup_key is distinct from (
            coalesce(m."이름",         '') || chr(31)
         || coalesce(m."연락처",       '') || chr(31)
         || coalesce(m."수강권명",     '') || chr(31)
         || coalesce(m."수강권시작일", '') || chr(31)
         || coalesce(m."결제구분",     '') || chr(31)
         || coalesce(m."결제금액",     '') || chr(31)
         || coalesce(m."결제일시",     '') || chr(31)
         || coalesce(m."결제방법",     '') || chr(31)
         || coalesce(m."할부개월수",   ''))) as "members_키가_바뀔_행",
  (select count(*) from public.sales) as "sales_전체",
  (select count(*) from public.sales s
     where s.dedup_key is distinct from (
            coalesce(s."이름",       '') || chr(31)
         || coalesce(s."연락처",     '') || chr(31)
         || coalesce(s."수강권명",   '') || chr(31)
         || coalesce(s."결제구분",   '') || chr(31)
         || coalesce(s."결제금액",   '') || chr(31)
         || coalesce(s."결제일시",   '') || chr(31)
         || coalesce(s."결제방법",   '') || chr(31)
         || coalesce(s."할부개월수", ''))) as "sales_키가_바뀔_행";

-- 1-b) 새 공식에서 서로 충돌하는(= 중복이 되는) 행. 2번에서 id 가 큰 1건만 남기고 지운다.
--      결과가 0행이면 아무것도 지워지지 않는다. 몇 행이 지워질지 여기서 반드시 확인할 것.
with k as (
  select id, "이름", "수강권명",
         coalesce("이름",         '') || chr(31)
      || coalesce("연락처",       '') || chr(31)
      || coalesce("수강권명",     '') || chr(31)
      || coalesce("수강권시작일", '') || chr(31)
      || coalesce("결제구분",     '') || chr(31)
      || coalesce("결제금액",     '') || chr(31)
      || coalesce("결제일시",     '') || chr(31)
      || coalesce("결제방법",     '') || chr(31)
      || coalesce("할부개월수",   '') as nk
  from public.members
)
select "이름", "수강권명", count(*) as "중복행수", array_agg(id order by id) as "id목록"
from k group by nk, "이름", "수강권명" having count(*) > 1 order by count(*) desc limit 50;


-- ════════════════════════════════════════════════════════════════════════════
-- 2. 적용 — 위 숫자를 확인하고 `npm run db:backup members sales` 를 뜬 뒤 실행.
--    한 트랜잭션이라 어느 단계에서 실패해도 전부 되돌아간다.
--
--    유니크 인덱스를 잠시 내리는 이유: UPDATE 는 행을 하나씩 고치므로, 최종 결과가
--    유일하더라도 중간 시점에 "아직 안 고친 행의 옛 키"와 충돌해 실패할 수 있다.
-- ════════════════════════════════════════════════════════════════════════════
begin;

-- members 는 `create unique index`(members_dedup_key_uidx), sales 는 컬럼 정의의
-- `dedup_key text unique`(= 제약 sales_dedup_key_key)라 내리는 방법이 다르다.
-- 이름에 의존하지 않도록 dedup_key 에 걸린 유니크 제약·인덱스를 모두 찾아서 내린다.
do $$
declare r record;
begin
  for r in
    select c.conrelid::regclass::text as tbl, c.conname
      from pg_constraint c
      join pg_class t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public' and t.relname in ('members', 'sales')
       and c.contype = 'u' and pg_get_constraintdef(c.oid) ilike '%dedup_key%'
  loop
    execute format('alter table %s drop constraint %I', r.tbl, r.conname);
  end loop;

  for r in
    select indexname from pg_indexes
     where schemaname = 'public' and tablename in ('members', 'sales')
       and indexdef ilike '%dedup_key%' and indexdef ilike '%unique%'
  loop
    execute format('drop index if exists public.%I', r.indexname);
  end loop;
end $$;

-- 2-a) members 재키잉 — 어긋난 행만 고친다(일치하면 0행 = 완전한 no-op).
update public.members set dedup_key =
       coalesce("이름",         '') || chr(31)
    || coalesce("연락처",       '') || chr(31)
    || coalesce("수강권명",     '') || chr(31)
    || coalesce("수강권시작일", '') || chr(31)
    || coalesce("결제구분",     '') || chr(31)
    || coalesce("결제금액",     '') || chr(31)
    || coalesce("결제일시",     '') || chr(31)
    || coalesce("결제방법",     '') || chr(31)
    || coalesce("할부개월수",   '')
where dedup_key is distinct from (
       coalesce("이름",         '') || chr(31)
    || coalesce("연락처",       '') || chr(31)
    || coalesce("수강권명",     '') || chr(31)
    || coalesce("수강권시작일", '') || chr(31)
    || coalesce("결제구분",     '') || chr(31)
    || coalesce("결제금액",     '') || chr(31)
    || coalesce("결제일시",     '') || chr(31)
    || coalesce("결제방법",     '') || chr(31)
    || coalesce("할부개월수",   ''));

-- 2-b) sales 재키잉 (생년월일 제외)
update public.sales set dedup_key =
       coalesce("이름",       '') || chr(31)
    || coalesce("연락처",     '') || chr(31)
    || coalesce("수강권명",   '') || chr(31)
    || coalesce("결제구분",   '') || chr(31)
    || coalesce("결제금액",   '') || chr(31)
    || coalesce("결제일시",   '') || chr(31)
    || coalesce("결제방법",   '') || chr(31)
    || coalesce("할부개월수", '')
where dedup_key is distinct from (
       coalesce("이름",       '') || chr(31)
    || coalesce("연락처",     '') || chr(31)
    || coalesce("수강권명",   '') || chr(31)
    || coalesce("결제구분",   '') || chr(31)
    || coalesce("결제금액",   '') || chr(31)
    || coalesce("결제일시",   '') || chr(31)
    || coalesce("결제방법",   '') || chr(31)
    || coalesce("할부개월수", ''));

-- 2-c) 안전장치 — 지워야 할 중복이 전체의 5% 를 넘으면 공식이 잘못된 것으로 보고 중단한다.
--      (옛 키가 사용횟수를 48% 날렸던 사고가 정확히 "공식이 너무 거칠어서 대량 병합"이었다.
--       이 가드가 있으면 그런 실수는 데이터가 아니라 에러로 드러난다.)
do $$
declare
  m_total int; m_dups int; s_total int; s_dups int;
begin
  select count(*) into m_total from public.members;
  select coalesce(sum(c - 1), 0) into m_dups
    from (select count(*) c from public.members group by dedup_key having count(*) > 1) t;
  select count(*) into s_total from public.sales;
  select coalesce(sum(c - 1), 0) into s_dups
    from (select count(*) c from public.sales group by dedup_key having count(*) > 1) t;

  raise notice '정리 대상 — members % / % 행, sales % / % 행', m_dups, m_total, s_dups, s_total;

  if m_dups > m_total * 0.05 or s_dups > s_total * 0.05 then
    raise exception
      '중복 정리 대상이 5%% 를 넘습니다 (members %/%, sales %/%). 키 공식이 코드와 어긋났을 수 있어 중단합니다.',
      m_dups, m_total, s_dups, s_total;
  end if;
end $$;

-- 2-d) 새 키 기준 중복 정리 — 같은 키 중 id 가 가장 큰(최신) 1건만 남긴다.
delete from public.members m using public.members keep
 where m.dedup_key = keep.dedup_key and m.id < keep.id;
delete from public.sales s using public.sales keep
 where s.dedup_key = keep.dedup_key and s.id < keep.id;

-- 2-e) 유니크 인덱스 복구 — upsert(onConflict:'dedup_key')가 다시 "덮어쓰기"로 동작한다.
--      sales 는 원래 제약이었지만 여기서 인덱스로 통일한다. ON CONFLICT (dedup_key) 는
--      제약이든 유니크 인덱스든 동일하게 매칭되므로 업로드 동작은 그대로다.
create unique index if not exists members_dedup_key_uidx on public.members (dedup_key);
create unique index if not exists sales_dedup_key_uidx   on public.sales   (dedup_key);

commit;


-- ════════════════════════════════════════════════════════════════════════════
-- 3. 검증 — sql/2026-07_verify_dedup.sql 을 실행해 "공식과_어긋난_행수 = 0" 을 확인한다.
--    그 뒤 새 코드를 배포하고 원본 엑셀을 재업로드할 것(위 "권장 순서" ④).
-- ════════════════════════════════════════════════════════════════════════════
