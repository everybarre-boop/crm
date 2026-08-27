-- ============================================================================
-- crm_attendance — 스튜디오메이트가 직접 센 출석 수를 1급 데이터로 들인다
-- ----------------------------------------------------------------------------
-- 먼저:  npm run db:backup members
-- 실행:  npm run db:sql sql/2026-08_attendance_truth.sql
-- 한 파일 = 한 트랜잭션. 재실행 안전(idempotent).
--
-- 🔥 왜 만드나 — 지금까지 회차·마일스톤의 근거는 `전체횟수 − 잔여횟수` 였는데, 그건
--    "출석 횟수"가 아니라 **"수강권에서 차감된 횟수"** 다. 넷이 이 둘을 갈라놓는다:
--      ① 결석·노쇼도 차감된다        (실측: 김미애 출석 49 · 결석 6)
--      ② 횟수 조정을 되짚을 수 없다  (명목 10회권인데 전체횟수가 1·5·9)
--      ③ 만료 소멸 = 완전 소진        (3회 쓰고 7회 날린 것과 10회 출석이 DB 에서 동일)
--      ④ 스냅샷은 시점 값             (자동화가 멈춘 기간만큼 뒤처진다)
--    검증 가능한 회원 137명 중 34% 가 어긋났고, **양방향**이다(회차를 높게도 낮게도 부른다).
--    배경·설계: docs/NEXT-attendance-count.md
--
-- 회원 페이지(`/users/detail?id=` → 이용내역)의 `출석(N)` 은 예약 이력을 직접 센 값이라
-- 저 넷을 전부 피한다. 2026-08-27 라이브 확인:
--   · 회원 전체·전 수강권 누적이다(수강권별 집계가 아니다)
--   · `전체(N)` = 예약+출석+결석+노쇼+취소 로 정확히 쪼개진다
--   · 회원 한 명 읽는 데 ~1.6초 → 내일 예약자 전원을 **매일 밤 다시 읽을 수 있다**
--
-- ⚠️ 그래서 이 테이블은 "한 번 찍고 마는 기준선"이 아니라 **최신 관측치 캐시**다.
--    매일 갱신되므로 드리프트가 없다. 저장하는 이유는 두 가지뿐이다:
--      · 그날 읽기에 실패한 회원의 폴백(마지막 값 + 그 이후 reservations 출석)
--      · 검증·추적 (docs 의 "137명 재측정")
--
-- ⚠️ **사이트별로 따로 센다.** 지점=사이트라 청담+송파를 다니는 회원은 양쪽에 각각
--    출석 수가 있다. 사람 단위 합계는 person_key 로 묶어 **사이트별 행을 더해서** 낸다.
--    (지점별 인원을 더해 전체를 내지 말라는 CLAUDE.md 의 원칙과 같은 이유다.)
-- ============================================================================

create table if not exists public.crm_attendance (
  id            bigint generated always as identity primary key,

  /* 스튜디오메이트 slug — 'everybarre'(청담·판교) / 'everybarre-songpa' 등.
     지점이 아니라 **사이트**다. everybarre 하나에 청담·판교가 같이 있다. */
  site          text        not null,
  /* 스튜디오메이트 회원 id. 이름·연락처와 달리 **바뀌지 않는** 식별자라 유니크 키로 쓴다.
     예약자 행의 컴포넌트 상태에서 읽는다(그 링크의 href 는 null 이다). */
  "회원id"       text        not null,

  /* 우리 쪽 동일인 판정 키 = 이름 + chr(31) + 숫자연락처 (shared/crm-core.mjs 의 personKey).
     ⚠️ 유니크 키가 아니다 — 이름·연락처는 바뀐다. 조인용이라 매번 최신값으로 덮는다. */
  person_key    text        not null default '',
  "이름"         text        not null default '',

  /* 이 값을 읽은 날짜(KST). 폴백 계산의 기준선이다 —
     "이 날짜 **이후** 의 reservations 출석 행"만 더해야 이중 계수가 안 된다. */
  "기준일"       date        not null,
  "출석수"       integer     not null,

  /* 진단용 — "왜 차감 횟수와 다른가"를 이 세 값이 설명한다. 규칙은 출석수만 쓴다. */
  "결석수"       integer     not null default 0,
  "노쇼수"       integer     not null default 0,
  "취소수"       integer     not null default 0,
  "예약수"       integer     not null default 0,
  "전체수"       integer     not null default 0,

  "읽은시각"     timestamptz not null default now(),

  constraint crm_attendance_site_member_key unique (site, "회원id")
);

comment on table public.crm_attendance is
  '스튜디오메이트 회원 페이지가 직접 센 출석 수(사이트별). 회차·마일스톤·휴면의 근거. '
  '`전체횟수 − 잔여횟수`(차감된 횟수)를 대체한다 — docs/NEXT-attendance-count.md';

create index if not exists crm_attendance_person_idx on public.crm_attendance (person_key);

-- 🔐 다른 crm_* 테이블과 같은 정책 — authenticated + 관리자 이메일 화이트리스트.
--    여기엔 회원 실명이 들어가므로 anon 에 절대 열지 않는다.
alter table public.crm_attendance enable row level security;
drop policy if exists "admins_full_access" on public.crm_attendance;
create policy "admins_full_access" on public.crm_attendance for all to authenticated
using      ( (auth.jwt() ->> 'email') = any (array['basegolf.official@gmail.com']) )
with check ( (auth.jwt() ->> 'email') = any (array['basegolf.official@gmail.com']) );

-- ----------------------------------------------------------------------------
-- 사람 단위 출석 수 — 사이트별 행을 **더해서** 낸다.
--   · 그날 읽은 행(기준일 = 오늘)은 그 값이 곧 현재값이다(더할 게 없다).
--   · 읽기에 실패해 옛 행만 있으면 그 뒤의 reservations 출석 행을 더해 메운다.
-- ⚠️ 뷰는 반드시 security_invoker=on — 없으면 뷰가 소유자 권한으로 돌아 RLS 를 우회한다.
-- ----------------------------------------------------------------------------
create or replace view public.crm_attendance_person
with (security_invoker = on) as
select
  a.person_key,
  max(a."이름")                                   as "이름",
  count(*)                                        as "사이트수",
  min(a."기준일")                                  as "가장오래된기준일",
  sum(a."출석수")                                  as "기준선합",
  sum(a."출석수" + coalesce(r.이후출석, 0))         as "출석수",
  sum(coalesce(r.이후출석, 0))                     as "이후출석합",
  sum(a."결석수")                                  as "결석수"
from public.crm_attendance a
left join lateral (
  select count(*) as 이후출석
  from public.reservations v
  where v.person_key = a.person_key
    and v."예약상태" = '출석'
    and v."예약일자" > a."기준일"
) r on true
group by a.person_key;

comment on view public.crm_attendance_person is
  '사람 단위 출석 수(전 사이트 합). 기준일 이후의 reservations 출석 행을 더해 보정한다.';

-- ----------------------------------------------------------------------------
-- 점검
-- ----------------------------------------------------------------------------
select count(*) as "crm_attendance 행수" from public.crm_attendance;
select count(*) as "뷰 행수" from public.crm_attendance_person;
