-- ============================================================================
-- 에블바레 CRM — 예약 스냅샷 · 규칙 · 멘트/피드백 · 휴면 명단
-- ----------------------------------------------------------------------------
-- ⚠️ 선행: sql/2026-08_apply_attendance_v2.sql 을 **먼저** 실행할 것.
--    이 파일은 거기서 만든 public.ymd_num() 과 daily_runs."단계" 컬럼을 쓴다.
--
-- 무엇을 만드나
--   reservations      매일 스크랩한 예약/출석 스냅샷 (자연키 res_key 로 멱등)
--   crm_rules         규칙 5개 + 멘트 템플릿 (화면에서 편집)
--   crm_messages      생성된 멘트 + 슬랙 발송 결과 + **강사 피드백(인라인 컬럼)**
--   crm_dormant       14일 미방문 명단 (사람당 1행)
--   crm_slack_posts   지점·일자별 슬랙 메시지 1건 (중복 발송 방지 + chat.update 근거)
--   뷰 2개            crm_last_attendance(마지막 출석일) · crm_history_depth(관측 깊이)
--   RPC 1개           save_reservations (res_key 공식을 DB 한 곳에만 두기 위함)
--
-- 왜 RPC 가 하나뿐인가 — crm_* 테이블은 관리자 JWT + RLS 로 PostgREST upsert 가 그대로
--   되므로 굳이 RPC 를 둘 이유가 없다. reservations 만 **키 공식이 코드와 갈라지면 안 되기**
--   때문에 RPC 로 감싼다(dedup_key 로 두 번 겪은 사고의 재발 방지).
--
-- 🔐 보안: 전 테이블 RLS = authenticated + 관리자 이메일 화이트리스트.
--    **뷰는 반드시 security_invoker=on** — 없으면 뷰가 소유자 권한으로 돌아 RLS 를 우회해
--    anon 이 회원 이름·연락처를 통째로 읽는 경로가 생긴다.
--
-- Supabase → SQL Editor 에 붙여 1회 실행. idempotent(재실행 안전).
-- ============================================================================

-- 관리자 화이트리스트 (다른 SQL 들과 동일 문구)
--   using/with check ( (auth.jwt() ->> 'email') = any (array['basegolf.official@gmail.com']) )


-- ============================================================================
-- 0) 공용 헬퍼 — 텍스트 날짜 → date
-- ============================================================================
create or replace function public.ymd_date(s text)
returns date
language sql
immutable
as $$
  select case when n is null then null
              else make_date(n / 10000, (n % 10000) / 100, n % 100) end
  from (select public.ymd_num(s)) t(n);
$$;

comment on function public.ymd_date(text) is
  '텍스트 날짜 → date. 파싱 실패 시 null(예외를 던지지 않는다). ymd_num 과 같은 정규식.';


-- ============================================================================
-- 1) reservations — 예약 스냅샷
-- ============================================================================
create table if not exists public.reservations (
  id              bigint generated always as identity primary key,
  "지점"           text not null default '',
  "예약일자"       date not null,
  "수업시간"       text not null default '',      -- 'HH:MM'
  "수업명"         text not null default '',
  "강사"           text not null default '',
  "이름"           text not null default '',
  "연락처"         text not null default '',
  "수강권명"       text not null default '',
  "예약상태"       text not null default '예약',   -- 예약|출석|결석|노쇼|취소|기타
  "전체횟수"       text,                          -- attendance 모드에서만 채운다
  "잔여횟수"       text,
  "수강권시작일"   text,
  "수강권종료일"   text,

  -- 사람 식별 — shared/crm-core.mjs 의 personKey() 와 같은 공식(이름 + US + 숫자만연락처)
  person_key      text generated always as
                    (btrim("이름") || chr(31) || regexp_replace("연락처", '[^0-9]', '', 'g'))
                    stored,

  /* 자연키 — save_reservations RPC 가 계산한다(공식은 RPC 안에 한 번만 존재).
     = 지점 ⋮ 예약일자 ⋮ 수업시간 ⋮ 수업명 ⋮ 이름 ⋮ 숫자연락처      (⋮ = chr(31))
     "같은 지점·같은 날·같은 시간·같은 수업에 같은 사람"은 물리적으로 1건이다.
     ⛔️ `예약상태`·`수강권명`·`강사`는 재실행 때 값이 변하므로(예약→출석) 키에 넣지 않는다.
        dedup_key 설계 원칙과 같다 — "변하는 값을 키에 넣으면 upsert 가 새 행 추가가 된다".
     ⚠️ 키 참여 컬럼은 전부 not null default '' 여야 한다. 하나라도 NULL 이면
        unique index 에서 NULL <> NULL 이라 재실행마다 새 행이 쌓인다. */
  res_key         text not null,

  source          text not null default 'studiomate',
  raw             jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create unique index if not exists reservations_res_key_uidx  on public.reservations (res_key);
create index        if not exists reservations_day_idx       on public.reservations ("예약일자" desc, "지점");
create index        if not exists reservations_person_idx    on public.reservations (person_key, "예약일자" desc);

alter table public.reservations enable row level security;
drop policy if exists "admins_full_access" on public.reservations;
create policy "admins_full_access" on public.reservations for all to authenticated
using      ( (auth.jwt() ->> 'email') = any (array['basegolf.official@gmail.com']) )
with check ( (auth.jwt() ->> 'email') = any (array['basegolf.official@gmail.com']) );

comment on table public.reservations is
  '스튜디오메이트 예약/출석 스냅샷. 하루 300~800행씩 쌓인다 — 클라이언트는 절대 전량 스캔하지 말고 예약일자로 끊을 것.';


-- ============================================================================
-- 2) save_reservations RPC — res_key 공식의 유일한 자리
-- ============================================================================

/* 입력 정규화 + res_key 계산 + 중복 제거.
   ⚠️ res_key 공식이 존재하는 **유일한 자리**다. save_reservations 가 이 함수를 두 번
      (건수 확인용 / 저장용) 호출하므로 공식이 두 곳으로 갈라지지 않는다.
   ⚠️ 임시 테이블을 쓰지 않는 이유 — SECURITY DEFINER 함수 안에서 pg_temp 를 타면
      temp 객체가 public 객체를 가리는 권한 상승 경로가 생긴다(그래서 search_path 에
      pg_temp 를 명시적으로 마지막에 두는 게 정석). 헬퍼 함수로 빼면 그 문제 자체가 없다. */
create or replace function public._norm_reservations(records jsonb)
returns table (
  "지점" text, "예약일자" date, "수업시간" text, "수업명" text, "강사" text,
  "이름" text, "연락처" text, "수강권명" text, "예약상태" text,
  "전체횟수" text, "잔여횟수" text, "수강권시작일" text, "수강권종료일" text,
  res_key text, raw jsonb
)
language sql
stable
set search_path = public
as $$
  /* 같은 res_key 가 입력에 두 번 오면 ON CONFLICT 가
     "cannot affect row a second time" 로 트랜잭션을 통째로 죽인다 → 먼저 접는다.
     나중 것(ord 큰 쪽)이 더 최신 상태이므로 그걸 남긴다. */
  select distinct on (x.res_key)
         x."지점", x."예약일자", x."수업시간", x."수업명", x."강사",
         x."이름", x."연락처", x."수강권명", x."예약상태",
         x."전체횟수", x."잔여횟수", x."수강권시작일", x."수강권종료일",
         x.res_key, x.raw
  from (
    select
      coalesce(t.e ->> '지점', '')                                            as "지점",
      public.ymd_date(t.e ->> '예약일자')                                      as "예약일자",
      coalesce(t.e ->> '수업시간', '')                                         as "수업시간",
      coalesce(t.e ->> '수업명', '')                                           as "수업명",
      coalesce(t.e ->> '강사', '')                                             as "강사",
      btrim(coalesce(t.e ->> '이름', ''))                                      as "이름",
      coalesce(t.e ->> '연락처', '')                                           as "연락처",
      coalesce(t.e ->> '수강권명', '')                                         as "수강권명",
      coalesce(nullif(t.e ->> '예약상태', ''), '예약')                          as "예약상태",
      nullif(t.e ->> '전체횟수', '')                                           as "전체횟수",
      nullif(t.e ->> '잔여횟수', '')                                           as "잔여횟수",
      nullif(t.e ->> '수강권시작일', '')                                       as "수강권시작일",
      nullif(t.e ->> '수강권종료일', '')                                       as "수강권종료일",
      -- ▼▼ res_key 공식 (여기 한 곳) ▼▼
      coalesce(t.e ->> '지점', '')                                      || chr(31) ||
      coalesce(to_char(public.ymd_date(t.e ->> '예약일자'), 'YYYY-MM-DD'), '') || chr(31) ||
      coalesce(t.e ->> '수업시간', '')                                   || chr(31) ||
      coalesce(t.e ->> '수업명', '')                                     || chr(31) ||
      btrim(coalesce(t.e ->> '이름', ''))                                || chr(31) ||
      regexp_replace(coalesce(t.e ->> '연락처', ''), '[^0-9]', '', 'g')    as res_key,
      t.e                                                               as raw,
      t.ord                                                             as ord
    from jsonb_array_elements(coalesce(records, '[]'::jsonb)) with ordinality as t(e, ord)
  ) x
  where x."예약일자" is not null    -- 날짜를 못 읽은 행은 저장하지 않는다(키가 깨진다)
  order by x.res_key, x.ord desc;
$$;

revoke all on function public._norm_reservations(jsonb) from public;
grant execute on function public._norm_reservations(jsonb) to authenticated;

create or replace function public.save_reservations(
  records     jsonb,
  branch      text default null,
  target_date date default null,
  dry_run     boolean default true
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  caller  text    := auth.jwt() ->> 'email';
  req     integer := coalesce(jsonb_array_length(records), 0);
  usable  integer := 0;
  saved   integer := 0;
  skipped jsonb   := '[]'::jsonb;
begin
  if caller is null or caller <> 'basegolf.official@gmail.com' then
    raise exception 'save_reservations: not authorized (%).', coalesce(caller, 'anon');
  end if;

  select count(*) into usable from public._norm_reservations(records);

  -- 날짜 파싱 실패로 버린 건 → 미매칭처럼 로그에 남긴다(조용히 사라지지 않게)
  if req > usable then
    select coalesce(jsonb_agg(jsonb_build_object(
             '사유', '예약일자 파싱 실패',
             '이름', t.e ->> '이름', '예약일자', t.e ->> '예약일자')), '[]'::jsonb)
      into skipped
    from jsonb_array_elements(coalesce(records, '[]'::jsonb)) t(e)
    where public.ymd_date(t.e ->> '예약일자') is null;
  end if;

  if not dry_run then
    insert into public.reservations as r
      ("지점","예약일자","수업시간","수업명","강사","이름","연락처","수강권명","예약상태",
       "전체횟수","잔여횟수","수강권시작일","수강권종료일", res_key, raw)
    select n."지점", n."예약일자", n."수업시간", n."수업명", n."강사",
           n."이름", n."연락처", n."수강권명", n."예약상태",
           n."전체횟수", n."잔여횟수", n."수강권시작일", n."수강권종료일", n.res_key, n.raw
    from public._norm_reservations(records) n
    on conflict (res_key) do update set
      -- 확정 상태(출석/결석/노쇼/취소)를 나중 roster 스크랩이 '예약'으로 되돌리지 않게 한다
      "예약상태" = case
                     when excluded."예약상태" = '예약'
                      and r."예약상태" in ('출석','결석','노쇼','취소') then r."예약상태"
                     else excluded."예약상태"
                   end,
      -- roster 모드는 값이 비어 있으므로, 이미 채워진 값을 지우지 않는다
      "수강권명"     = case when excluded."수강권명" <> '' then excluded."수강권명" else r."수강권명" end,
      "강사"         = case when excluded."강사"     <> '' then excluded."강사"     else r."강사"     end,
      "연락처"       = case when excluded."연락처"   <> '' then excluded."연락처"   else r."연락처"   end,
      "전체횟수"     = coalesce(excluded."전체횟수",     r."전체횟수"),
      "잔여횟수"     = coalesce(excluded."잔여횟수",     r."잔여횟수"),
      "수강권시작일" = coalesce(excluded."수강권시작일", r."수강권시작일"),
      "수강권종료일" = coalesce(excluded."수강권종료일", r."수강권종료일"),
      raw            = coalesce(excluded.raw, r.raw),
      updated_at     = now();

    get diagnostics saved = row_count;
  end if;

  insert into public.daily_runs("단계", "대상일자", 지점, dry_run, 요청건수, 반영건수, 미매칭, created_by)
  values ('reservations', target_date, branch, dry_run, req, saved, skipped, caller);

  return jsonb_build_object(
    'requested',   req,
    'usable',      usable,
    'saved',       saved,
    'skipped',     skipped,
    'dry_run',     dry_run,
    'branch',      branch,
    'target_date', target_date
  );
end;
$$;

grant execute on function public.save_reservations(jsonb, text, date, boolean) to authenticated;


-- ============================================================================
-- 3) 뷰 — 마지막 출석일 / 관측 깊이
-- ============================================================================

/* 마지막 출석일 (사람 단위).
   ⚠️ "출석"의 정의 — 예약상태가 '출석'인 건 + **지난 날짜인데 아직 '예약'인 건.**
      강사가 출석 체크를 누락하면 '예약'으로 남는데, 그걸 미출석으로 보면 멀쩡히 다니는
      회원이 휴면 명단에 뜬다. '취소'·'노쇼'·'결석'은 출석이 아니다.
   ⚠️ 이 뷰는 원시 그룹(이름+숫자연락처)만 낸다. 최종 1인 합산은 클라이언트/자동화의
      makePersonResolver 가 한다 — "연락처 빈 행" 보수 규칙을 SQL 에 재구현하지 않기 위함. */
create or replace view public.crm_last_attendance
with (security_invoker = on) as
select
  "이름",
  regexp_replace("연락처", '[^0-9]', '', 'g')                 as phone_digits,
  max("연락처") filter (where "연락처" <> '')                  as "연락처",
  max("예약일자")                                              as "마지막출석일",
  count(*)                                                    as "출석횟수",
  (array_agg("지점" order by "예약일자" desc, id desc))[1]      as "마지막지점"
from public.reservations
where "예약상태" = '출석'
   or ("예약상태" = '예약' and "예약일자" < current_date)
group by "이름", regexp_replace("연락처", '[^0-9]', '', 'g');

comment on view public.crm_last_attendance is
  '사람별 마지막 출석일. 지난 날짜의 ''예약''도 출석으로 본다(강사 출석체크 누락 대응).';

/* 관측 깊이 — "14일 미방문"을 언제부터 믿을 수 있는지 판단하는 근거.
   도입 초기엔 스냅샷 이력이 없어 전원이 "14일 미방문"으로 잡히므로, 화면은 이 값으로
   배너를 띄우고 자동화는 휴면 규칙을 잠근다. */
create or replace view public.crm_history_depth
with (security_invoker = on) as
select
  min("예약일자")                                             as "이력시작일",
  max("예약일자")                                             as "이력종료일",
  coalesce(current_date - min("예약일자"), 0)                  as "관측일수",
  count(*)                                                    as "행수"
from public.reservations;


-- ============================================================================
-- 4) crm_rules — 규칙 + 멘트 템플릿
-- ============================================================================
create table if not exists public.crm_rules (
  id                text primary key,                  -- milestone|trial|first-paid|expiring|dormant-14
  "라벨"             text not null,
  "이모지"           text not null default '',
  "활성"             boolean not null default true,
  "슬랙발송"         boolean not null default true,     -- dormant-14 만 false
  "정렬순서"         integer not null default 0,
  "재발송억제일수"   integer not null default 0,        -- 0=억제없음, -1=평생 1회, n=n일
  "파라미터"         jsonb   not null default '{}'::jsonb,
  "템플릿"           text    not null default '',       -- 상황 한 줄 (슬랙 본문)
  "예시멘트"         text    not null default '',       -- ↳ 로 붙는 예시 문장
  updated_at        timestamptz not null default now()
);

alter table public.crm_rules enable row level security;
drop policy if exists "admins_full_access" on public.crm_rules;
create policy "admins_full_access" on public.crm_rules for all to authenticated
using      ( (auth.jwt() ->> 'email') = any (array['basegolf.official@gmail.com']) )
with check ( (auth.jwt() ->> 'email') = any (array['basegolf.official@gmail.com']) );

/* seed — on conflict do nothing.
   ⚠️ 화면에서 고친 템플릿을 이 SQL 재실행이 되돌리지 않게 하려는 것이다.
      기본값을 다시 심고 싶으면 해당 행을 delete 후 재실행할 것.
   치환 변수: {{이름}} {{지점}} {{수업시간}} {{수업명}} {{수강권명}}
              {{누적횟수}} {{마일스톤}} {{잔여횟수}} {{전체횟수}}
              {{수강권종료일}} {{남은일}} {{마지막출석일}} {{경과일}} {{잔여합}} */
insert into public.crm_rules
  (id, "라벨", "이모지", "슬랙발송", "정렬순서", "재발송억제일수", "파라미터", "템플릿", "예시멘트")
values
  ('milestone', '마일스톤', '🎉', true, 10, -1,
   -- 소급허용=false: 지난 마일스톤을 뒤늦게 축하하면 "오늘로 N번째"가 거짓말이 된다
   '{"마일스톤":[10,30,50,100,150,200,300,500],"소급허용":false,"소급한도":10}'::jsonb,
   '*{{마일스톤}}회차!* (누적 {{누적횟수}}회)',
   '{{이름}}님, 오늘로 {{마일스톤}}번째 수업이에요! 꾸준히 나오시는 게 정말 대단해요 👏'),

  -- 정렬순서 = 슬랙 섹션 순서이자 **1인 1건 우선순위**(작을수록 우선).
  -- 나중 단계가 이기게: 마일스톤(10) > 만료임박(20) > 신규(30) > 체험(40)
  ('trial', '체험', '🌱', true, 40, 0,
   -- 제외키워드: "체험 후 1회권" 처럼 체험을 마치고 산 **유료** 수강권을 체험으로 세지 않는다
   '{"제외키워드":["체험 후"]}'::jsonb,
   '체험 수업 · {{수강권명}}',
   '{{이름}}님, 처음 오셨죠? 동작이 어려우면 언제든 편하게 말씀해 주세요. 끝나고 궁금한 점도 여쭤볼게요!'),

  ('first-paid', '신규 등록 첫 수업', '✨', true, 30, -1,
   -- 최대누적: 없으면 재등록한 기존 회원(누적 51회 등)이 전부 "신규"로 잡힌다
   '{"체험이력필수":true,"최대누적":3}'::jsonb,
   '체험 후 등록하고 첫 수업 · {{수강권명}}',
   '{{이름}}님, 등록해 주셔서 정말 반가워요! 앞으로 {{전체횟수}}회 같이 만들어가요 😊'),

  ('expiring', '만료 임박', '⏳', true, 20, 7,
   '{"만료임박일":7,"잔여비율":0.30}'::jsonb,
   '잔여 {{잔여횟수}}/{{전체횟수}}회 · {{수강권종료일}} 만료({{남은일}}일 남음)',
   '{{이름}}님, 수강권이 {{수강권종료일}}에 끝나는데 아직 {{잔여횟수}}회 남으셨어요. 추가 등록하시면 남은 횟수는 그대로 이월돼요!'),

  ('dormant-14', '14일 미방문', '🕰️', false, 50, 0,
   '{"휴면일":14}'::jsonb,
   '마지막 출석 {{마지막출석일}} ({{경과일}}일 전) · 잔여 {{잔여합}}회',
   '')
on conflict (id) do nothing;

/* 이미 seed 된 환경에 새 파라미터만 채워 넣는다.
   ⚠️ `not (파라미터 ? '키')` 조건이 핵심이다 — 화면에서 고친 값을 SQL 재실행이 덮으면 안 된다.
   (2026-08-10 추가: "체험 후 1회권" 같은 유료 수강권이 체험으로 오탐되는 문제) */
update public.crm_rules
   set "파라미터" = "파라미터" || '{"제외키워드":["체험 후"]}'::jsonb,
       updated_at = now()
 where id = 'trial' and not ("파라미터" ? '제외키워드');

/* 2026-08-10 광교 실측 dry-run 에서 드러난 문제 3건 보정.
   ⚠️ 여기는 "이미 seed 된 값을 실제로 바꾸는" 구문이라 조건을 좁게 건다
      (값이 옛 기본값 그대로일 때만 → 화면에서 손댄 설정은 건드리지 않는다). */

-- ① 소급 마일스톤이 "오늘로 N번째 수업" 이라는 거짓 문장을 만든다(누적 51회에 "50번째")
update public.crm_rules
   set "파라미터" = jsonb_set("파라미터", '{소급허용}', 'false'::jsonb), updated_at = now()
 where id = 'milestone' and coalesce(("파라미터" ->> '소급허용')::boolean, false);

-- ② "이 수강권 첫 사용"만 보면 재등록한 기존 회원이 전부 '신규'가 된다
update public.crm_rules
   set "파라미터" = "파라미터" || '{"최대누적":3}'::jsonb, updated_at = now()
 where id = 'first-paid' and not ("파라미터" ? '최대누적');

-- ③ 정렬순서 = 슬랙 섹션 순서이자 1인 1건 우선순위. 나중 단계가 이기게 재배치.
update public.crm_rules set "정렬순서" = 20, updated_at = now() where id = 'expiring' and "정렬순서" = 40;
update public.crm_rules set "정렬순서" = 40, updated_at = now() where id = 'trial'    and "정렬순서" = 20;


-- ============================================================================
-- 5) crm_messages — 생성된 멘트 + 슬랙 발송 결과 + 강사 피드백(인라인)
-- ============================================================================
create table if not exists public.crm_messages (
  id            bigint generated always as identity primary key,
  "대상일자"     date not null,                    -- D+1 수업 날짜 (dormant 는 생성일)
  "지점"         text not null default '',
  rule_id       text not null references public.crm_rules(id),
  "규칙키"       text not null default '',          -- milestone→'100', expiring/first-paid→수강권명
  person_key    text not null,
  "이름"         text not null default '',
  /* ⚠️ 연락처를 반드시 채울 것. crm_messages 에는 dedup_key 가 없어서, 비어 있으면
        makePersonResolver 의 폴백이 "행 단위 일련번호"로 떨어져 sales 와 절대 안 붙는다
        → CRM 성과 화면의 결제 전환 계산이 통째로 무너진다. */
  "연락처"       text not null default '',
  "수업시간"     text not null default '',
  "수업명"       text not null default '',
  "강사"         text not null default '',
  "수강권명"     text not null default '',
  "멘트"         text not null default '',          -- 렌더 완료된 상황 한 줄
  "예시멘트"     text not null default '',          -- 렌더 완료된 예시 문장
  "근거"         jsonb not null default '{}'::jsonb,

  -- 슬랙 발송 결과
  "발송여부"     boolean not null default false,
  "발송시각"     timestamptz,
  slack_ts      text,
  "발송오류"     text,

  -- 강사 피드백 (인라인). 실행여부 IS NULL = 아직 미입력
  "실행여부"     boolean,
  "반응"         text,                              -- 좋음|보통|무반응|부정
  "메모"         text,
  "피드백작성자" text,
  "피드백시각"   timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 재실행 멱등 + 같은 날 중복 발송 차단
create unique index if not exists crm_messages_key_uidx
  on public.crm_messages ("대상일자", "지점", person_key, rule_id, "규칙키");
create index if not exists crm_messages_day_idx
  on public.crm_messages ("대상일자" desc, "지점");
-- 마일스톤 "평생 1회" 억제 조회 전용
create index if not exists crm_messages_sup_idx
  on public.crm_messages (person_key, rule_id, "규칙키") where "발송여부";

alter table public.crm_messages enable row level security;
drop policy if exists "admins_full_access" on public.crm_messages;
create policy "admins_full_access" on public.crm_messages for all to authenticated
using      ( (auth.jwt() ->> 'email') = any (array['basegolf.official@gmail.com']) )
with check ( (auth.jwt() ->> 'email') = any (array['basegolf.official@gmail.com']) );


-- ============================================================================
-- 6) crm_dormant — 14일 미방문 (사람당 1행)
-- ============================================================================
/* 일자별 이력으로 쌓으면 300명 × 365일 = 연 10만 행인데 화면은 결국 "오늘 것"만 본다.
   사람당 1행 + 최초감지일 보존이면 정보량은 같고 크기는 1/365.
   ⚠️ upsert 할 때 payload 에 "최초감지일"을 **넣지 말 것** — PostgREST 는 payload 키만
      SET 하므로, 빼면 insert 시 default current_date, update 시 기존 값 유지가 된다. */
create table if not exists public.crm_dormant (
  person_key      text primary key,
  "이름"           text not null default '',
  "연락처"         text not null default '',
  "마지막출석일"   date,                            -- null = 관측 이력 없음(= "모름")
  "마지막지점"     text not null default '',
  "경과일"         integer not null default 0,
  "잔여합"         integer not null default 0,
  "보유수강권"     jsonb not null default '[]'::jsonb,
  "최초감지일"     date not null default current_date,
  "갱신일"         date not null default current_date,

  -- 조치 기록 (CRM 실행 화면에서 체크)
  "조치여부"       boolean,
  "조치메모"       text,
  "조치작성자"     text,
  "조치시각"       timestamptz,

  updated_at      timestamptz not null default now()
);

create index if not exists crm_dormant_days_idx on public.crm_dormant ("경과일" desc);

alter table public.crm_dormant enable row level security;
drop policy if exists "admins_full_access" on public.crm_dormant;
create policy "admins_full_access" on public.crm_dormant for all to authenticated
using      ( (auth.jwt() ->> 'email') = any (array['basegolf.official@gmail.com']) )
with check ( (auth.jwt() ->> 'email') = any (array['basegolf.official@gmail.com']) );


-- ============================================================================
-- 7) crm_slack_posts — 지점·일자별 슬랙 메시지 1건 (중복 발송 방지)
-- ============================================================================
/* 같은 날 재실행하면 새 메시지를 또 보내는 게 아니라 저장된 ts 로 chat.update 한다.
   unique(대상일자, 지점, 종류) 가 그 근거다. */
create table if not exists public.crm_slack_posts (
  id            bigint generated always as identity primary key,
  "대상일자"     date not null,
  "지점"         text not null,
  "종류"         text not null default 'daily',
  channel_id    text not null default '',
  message_ts    text,
  "건수"         integer not null default 0,
  "상태"         text not null default 'pending',   -- pending|ok|failed|skipped
  "에러"         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique ("대상일자", "지점", "종류")
);

alter table public.crm_slack_posts enable row level security;
drop policy if exists "admins_full_access" on public.crm_slack_posts;
create policy "admins_full_access" on public.crm_slack_posts for all to authenticated
using      ( (auth.jwt() ->> 'email') = any (array['basegolf.official@gmail.com']) )
with check ( (auth.jwt() ->> 'email') = any (array['basegolf.official@gmail.com']) );


-- ============================================================================
-- 점검 — sql/2026-08_verify_crm.sql 로 따로 돌릴 수 있다
-- ============================================================================
select 'reservations' as 항목,
       (to_regclass('public.reservations') is not null)::text as 결과
union all select 'reservations res_key unique',
       (select count(*)::text from pg_indexes
         where schemaname='public' and indexname='reservations_res_key_uidx')
union all select 'crm_rules seed 5행',
       (select count(*)::text from public.crm_rules)
union all select 'crm_messages',
       (to_regclass('public.crm_messages') is not null)::text
union all select 'crm_dormant',
       (to_regclass('public.crm_dormant') is not null)::text
union all select 'crm_slack_posts',
       (to_regclass('public.crm_slack_posts') is not null)::text
union all select '뷰 security_invoker (2개 모두 on 이어야 함)',
       (select count(*)::text from pg_class c
         where c.relname in ('crm_last_attendance','crm_history_depth')
           and c.reloptions::text like '%security_invoker=on%')
union all select 'RLS 걸린 CRM 테이블 수 (5여야 함)',
       (select count(*)::text from pg_tables
         where schemaname='public' and rowsecurity
           and tablename in ('reservations','crm_rules','crm_messages','crm_dormant','crm_slack_posts'))
union all select '관측 깊이(일)',
       (select coalesce("관측일수",0)::text from public.crm_history_depth);
