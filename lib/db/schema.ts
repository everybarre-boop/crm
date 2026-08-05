/* ======================================================================
   Drizzle 스키마 — ⚠️ 개발 도구(마이그레이션/스키마 관리) 전용
   ----------------------------------------------------------------------
   · 이 파일과 drizzle-kit 은 "런타임"에서 쓰이지 않는다. 브라우저 앱은 여전히
     @supabase/supabase-js(PostgREST + RLS)로만 DB에 접근한다. (lib/supabase.ts)
   · Drizzle 직접 연결은 DATABASE_URL(전권 접속 문자열)로 붙으며 RLS 를 우회한다.
     → 절대 클라이언트/정적 번들에 넣지 말 것. drizzle-orm/postgres 는 devDependencies.
   · 아래 정의는 `npm run db:pull` 로 실제 운영 DB(public.members)를 인트로스펙션해
     맞춘 것이다. 스키마를 바꿀 때는 이 파일 수정 → `npm run db:generate` → 검토 →
     `npm run db:migrate` 순서로 반영한다.

   ✅ `dedup_key` 는 members·sales 양쪽에 실재한다(text + unique).
      과거 members 에 없어 코드/문서와 어긋났으나 sql/2026-07_dedup_members.sql 로 해소됐다.
      키를 이루는 컬럼 목록은 DB가 아니라 lib/members.ts 의 KEY_COLS 가 기준이다
      (값은 앱이 계산해서 넣고, DB는 유니크 제약으로 덮어쓰기를 보장하는 역할만 한다).
   ====================================================================== */
import {
  pgTable,
  pgPolicy,
  bigint,
  boolean,
  date,
  integer,
  text,
  jsonb,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

// 관리자 이메일 화이트리스트 (members·sales 공통 RLS). 유일한 PII 방어선. (CLAUDE.md 참고)
const adminOnly = sql`((auth.jwt() ->> 'email'::text) = ANY (ARRAY['basegolf.official@gmail.com'::text]))`;

export const members = pgTable(
  'members',
  {
    // bigint identity. maxValue 등은 Postgres 기본값이라 굳이 명시하지 않는다.
    // mode:'bigint' — JS number 는 2^53 초과 정수를 정확히 표현 못 하므로 bigint 로 받는다.
    id: bigint({ mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    이름: text('이름'),
    연락처: text('연락처'),
    성별: text('성별'),
    등록일: text('등록일'),
    생년월일: text('생년월일'),
    수강권명: text('수강권명'),
    수강권종류: text('수강권종류'),
    결제구분: text('결제구분'),
    결제금액: text('결제금액'),
    결제방법: text('결제방법'),
    결제일시: text('결제일시'),
    할부개월수: text('할부개월수'),
    잔여횟수: text('잔여횟수'),
    전체횟수: text('전체횟수'),
    예약가능횟수: text('예약가능횟수'),
    취소가능횟수: text('취소가능횟수'),
    수강권시작일: text('수강권시작일'),
    수강권종료일: text('수강권종료일'),
    // 사용횟수 = 전체횟수 − 잔여횟수 (숫자 외 문자는 제거하고 계산). 회원/대시보드의
    // "사용횟수 범위" 필터가 이 컬럼을 .gte/.lte 로 서버에서 거른다. STORED 생성 컬럼이라
    // 업로드 upsert 에는 넣지 않는다(넣으면 에러). 표현식은 sql/ 폴더의 마이그레이션과 동일.
    usedCount: integer('used_count').generatedAlwaysAs(
      sql`(COALESCE(NULLIF(regexp_replace(COALESCE("전체횟수", ''), '[^0-9-]', '', 'g'), '')::int, 0) - COALESCE(NULLIF(regexp_replace(COALESCE("잔여횟수", ''), '[^0-9-]', '', 'g'), '')::int, 0))`,
    ),
    // 중복 판정 키(이름·연락처·수강권명·수강권시작일·결제구분/금액/일시/방법/할부).
    // 앱의 makeKey(KEY_COLS)가 계산해
    // 보내고, unique 인덱스가 재업로드 시 덮어쓰기(upsert onConflict:'dedup_key')를 보장한다.
    // (백필/유니크는 sql/2026-07_dedup_members.sql 로 반영)
    dedupKey: text('dedup_key').unique(),
    raw: jsonb(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  () => [
    pgPolicy('admins_full_access', {
      as: 'permissive',
      for: 'all',
      to: ['authenticated'],
      using: adminOnly,
      withCheck: adminOnly,
    }),
  ],
);

/* ======================================================================
   branch_costs — 지점별·월별 비용 (대시보드 비용/인건비율/임대료율 계산용)
   매출은 sales 에서 자동 집계, 비용은 관리자가 이 테이블에 월별로 입력한다.
   (sql/2026-07_branch_costs.sql 와 짝. unique(지점,연월) 로 upsert.)
   ====================================================================== */
export const branchCosts = pgTable(
  'branch_costs',
  {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    지점: text('지점').notNull(),
    연월: text('연월').notNull(), // 'YYYY-MM'
    인건비: integer('인건비').notNull().default(0),
    임대료: integer('임대료').notNull().default(0),
    기타비용: integer('기타비용').notNull().default(0),
    메모: text('메모'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (t) => [
    unique().on(t.지점, t.연월),
    pgPolicy('admins_full_access', {
      as: 'permissive',
      for: 'all',
      to: ['authenticated'],
      using: adminOnly,
      withCheck: adminOnly,
    }),
  ],
);

/* ======================================================================
   sales — 매출(결제) 전용 테이블
   회원 엑셀에서 결제 컬럼만 분리해 저장한다. dedup_key + 유니크 인덱스로
   재업로드 시 중복 매출 행을 upsert 로 막는다. (lib/sales.ts 와 컬럼/키 일치)
   ⚠️ members 와 달리 이 테이블은 처음부터 dedup_key 유니크 제약을 둔다 —
      onConflict:'dedup_key' upsert 가 정상 동작한다.
   ====================================================================== */
export const sales = pgTable(
  'sales',
  {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    이름: text('이름'),
    연락처: text('연락처'),
    생년월일: text('생년월일'),
    수강권명: text('수강권명'),
    수강권종류: text('수강권종류'),
    등록일: text('등록일'),
    결제구분: text('결제구분'),
    결제금액: text('결제금액'),
    결제일시: text('결제일시'),
    결제방법: text('결제방법'),
    할부개월수: text('할부개월수'),
    dedupKey: text('dedup_key').unique(),
    raw: jsonb(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  () => [
    pgPolicy('admins_full_access', {
      as: 'permissive',
      for: 'all',
      to: ['authenticated'],
      using: adminOnly,
      withCheck: adminOnly,
    }),
  ],
);

/* ======================================================================
   일간 CRM 자동화 테이블 (sql/2026-08_crm.sql 과 짝)
   ----------------------------------------------------------------------
   ⚠️ 운영 반영은 sql/ 의 손수 작성 SQL 로 한다. 여기 정의는 `npm run db:pull` 대조용
      짝맞춤이다(생성 컬럼·부분 인덱스·RPC·뷰까지 Drizzle 로 표현하지는 않는다).
   ====================================================================== */

/* 예약 스냅샷. 하루 300~800행씩 쌓인다 — 클라이언트 전량 스캔 금지(예약일자로 끊을 것).
   자연키 res_key = 지점⋮예약일자⋮수업시간⋮수업명⋮이름⋮숫자연락처 (⋮=chr(31)).
   ⛔️ 예약상태·수강권명·강사는 재실행 때 값이 변하므로 키에 넣지 않는다(dedup_key 와 같은 원칙). */
export const reservations = pgTable(
  'reservations',
  {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    지점: text('지점').notNull().default(''),
    예약일자: date('예약일자').notNull(),
    수업시간: text('수업시간').notNull().default(''),
    수업명: text('수업명').notNull().default(''),
    강사: text('강사').notNull().default(''),
    이름: text('이름').notNull().default(''),
    연락처: text('연락처').notNull().default(''),
    수강권명: text('수강권명').notNull().default(''),
    예약상태: text('예약상태').notNull().default('예약'), // 예약|출석|결석|노쇼|취소|기타
    전체횟수: text('전체횟수'),
    잔여횟수: text('잔여횟수'),
    수강권시작일: text('수강권시작일'),
    수강권종료일: text('수강권종료일'),
    // shared/crm-core.mjs 의 personKey() 와 같은 공식
    personKey: text('person_key').generatedAlwaysAs(
      sql`(btrim("이름") || chr(31) || regexp_replace("연락처", '[^0-9]'::text, ''::text, 'g'::text))`,
    ),
    resKey: text('res_key').notNull().unique(),
    source: text('source').notNull().default('studiomate'),
    raw: jsonb(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  () => [
    pgPolicy('admins_full_access', {
      as: 'permissive',
      for: 'all',
      to: ['authenticated'],
      using: adminOnly,
      withCheck: adminOnly,
    }),
  ],
);

/* 규칙 + 멘트 템플릿. 관리자 화면(CRM 성과 → 템플릿 편집)에서 수정한다.
   seed 는 on conflict do nothing 이라 SQL 재실행이 편집분을 되돌리지 않는다. */
export const crmRules = pgTable(
  'crm_rules',
  {
    id: text('id').primaryKey(), // milestone|trial|first-paid|expiring|dormant-14
    라벨: text('라벨').notNull(),
    이모지: text('이모지').notNull().default(''),
    활성: boolean('활성').notNull().default(true),
    슬랙발송: boolean('슬랙발송').notNull().default(true),
    정렬순서: integer('정렬순서').notNull().default(0),
    재발송억제일수: integer('재발송억제일수').notNull().default(0), // 0=없음, -1=평생 1회
    파라미터: jsonb('파라미터').notNull().default({}),
    템플릿: text('템플릿').notNull().default(''),
    예시멘트: text('예시멘트').notNull().default(''),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  () => [
    pgPolicy('admins_full_access', {
      as: 'permissive',
      for: 'all',
      to: ['authenticated'],
      using: adminOnly,
      withCheck: adminOnly,
    }),
  ],
);

/* 생성된 멘트 + 슬랙 발송 결과 + **강사 피드백(인라인 컬럼)**.
   피드백을 별도 테이블로 두지 않는 이유: "미입력만 보기"가 .is('실행여부',null) 한 줄이 되고,
   일괄 체크가 .update().in('id',ids) 1회로 끝난다. 나중에 강사 계정을 붙일 때는
   컬럼 단위 GRANT(grant update (실행여부,반응,메모))로 열면 된다. */
export const crmMessages = pgTable(
  'crm_messages',
  {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    대상일자: date('대상일자').notNull(),
    지점: text('지점').notNull().default(''),
    ruleId: text('rule_id').notNull(),
    규칙키: text('규칙키').notNull().default(''),
    personKey: text('person_key').notNull(),
    이름: text('이름').notNull().default(''),
    // ⚠️ 반드시 채운다. 비면 makePersonResolver 폴백이 행 단위 키로 떨어져 sales 와 안 붙고,
    //    CRM 성과 화면의 결제 전환 계산이 통째로 무너진다.
    연락처: text('연락처').notNull().default(''),
    수업시간: text('수업시간').notNull().default(''),
    수업명: text('수업명').notNull().default(''),
    강사: text('강사').notNull().default(''),
    수강권명: text('수강권명').notNull().default(''),
    멘트: text('멘트').notNull().default(''),
    예시멘트: text('예시멘트').notNull().default(''),
    근거: jsonb('근거').notNull().default({}),
    발송여부: boolean('발송여부').notNull().default(false),
    발송시각: timestamp('발송시각', { withTimezone: true, mode: 'string' }),
    slackTs: text('slack_ts'),
    발송오류: text('발송오류'),
    실행여부: boolean('실행여부'), // NULL = 아직 미입력
    반응: text('반응'), // 좋음|보통|무반응|부정
    메모: text('메모'),
    피드백작성자: text('피드백작성자'),
    피드백시각: timestamp('피드백시각', { withTimezone: true, mode: 'string' }),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (t) => [
    unique().on(t.대상일자, t.지점, t.personKey, t.ruleId, t.규칙키),
    pgPolicy('admins_full_access', {
      as: 'permissive',
      for: 'all',
      to: ['authenticated'],
      using: adminOnly,
      withCheck: adminOnly,
    }),
  ],
);

/* 14일 미방문 — 사람당 1행.
   일자별 이력으로 쌓으면 300명 × 365일 = 연 10만 행인데 화면은 "오늘 것"만 본다.
   ⚠️ upsert payload 에 최초감지일을 넣지 말 것 — 넣으면 매일 덮여서 "얼마나 오래 휴면인지"를 잃는다. */
export const crmDormant = pgTable(
  'crm_dormant',
  {
    personKey: text('person_key').primaryKey(),
    이름: text('이름').notNull().default(''),
    연락처: text('연락처').notNull().default(''),
    마지막출석일: date('마지막출석일'), // null = 관측 이력 없음(= "모름")
    마지막지점: text('마지막지점').notNull().default(''),
    경과일: integer('경과일').notNull().default(0),
    잔여합: integer('잔여합').notNull().default(0),
    보유수강권: jsonb('보유수강권').notNull().default([]),
    최초감지일: date('최초감지일').notNull().default(sql`CURRENT_DATE`),
    갱신일: date('갱신일').notNull().default(sql`CURRENT_DATE`),
    조치여부: boolean('조치여부'),
    조치메모: text('조치메모'),
    조치작성자: text('조치작성자'),
    조치시각: timestamp('조치시각', { withTimezone: true, mode: 'string' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  () => [
    pgPolicy('admins_full_access', {
      as: 'permissive',
      for: 'all',
      to: ['authenticated'],
      using: adminOnly,
      withCheck: adminOnly,
    }),
  ],
);

/* 지점·일자별 슬랙 메시지 1건. unique 가 중복 발송 방지 + chat.update 의 근거다. */
export const crmSlackPosts = pgTable(
  'crm_slack_posts',
  {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    대상일자: date('대상일자').notNull(),
    지점: text('지점').notNull(),
    종류: text('종류').notNull().default('daily'),
    channelId: text('channel_id').notNull().default(''),
    messageTs: text('message_ts'),
    건수: integer('건수').notNull().default(0),
    상태: text('상태').notNull().default('pending'), // pending|ok|failed|skipped
    에러: text('에러'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  (t) => [
    unique().on(t.대상일자, t.지점, t.종류),
    pgPolicy('admins_full_access', {
      as: 'permissive',
      for: 'all',
      to: ['authenticated'],
      using: adminOnly,
      withCheck: adminOnly,
    }),
  ],
);

/* 자동화 실행 로그. RPC(apply_attendance·save_reservations)와 클라이언트(crm·slack)가 함께 쓴다.
   sql/2026-07_apply_attendance.sql 에서 만들어졌고 v2 에서 단계·대상일자가 추가됐다. */
export const dailyRuns = pgTable(
  'daily_runs',
  {
    id: bigint({ mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    runAt: timestamp('run_at', { withTimezone: true, mode: 'string' }).defaultNow(),
    단계: text('단계').notNull().default('attendance'), // attendance|reservations|crm|slack
    대상일자: date('대상일자'),
    지점: text('지점'),
    dryRun: boolean('dry_run').notNull().default(true),
    요청건수: integer('요청건수').notNull().default(0),
    반영건수: integer('반영건수').notNull().default(0),
    미매칭: jsonb('미매칭').notNull().default([]),
    createdBy: text('created_by'),
  },
  () => [
    pgPolicy('admins_full_access', {
      as: 'permissive',
      for: 'all',
      to: ['authenticated'],
      using: adminOnly,
      withCheck: adminOnly,
    }),
  ],
);
