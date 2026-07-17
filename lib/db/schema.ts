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

   ⚠️ 주의 — 실제 DB에는 `dedup_key` 컬럼/유니크 인덱스가 없다.
      그러나 lib/members.ts(makeKey / onConflict:'dedup_key' / eq('dedup_key',…))와
      CLAUDE.md 는 `dedup_key` 불변식을 전제한다. 즉 코드/문서와 실제 스키마가
      어긋나 있다. 여기서는 "실제 DB" 를 그대로 반영했다(그래야 db:generate 가
      허위 diff 를 만들지 않는다). 이 불일치 해소는 별도 결정 사항이다.
   ====================================================================== */
import { pgTable, pgPolicy, bigint, integer, text, jsonb, timestamp, unique } from 'drizzle-orm/pg-core';
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
    // 중복 판정 키(이름·연락처·수강권명·등록일·전체횟수). 앱의 makeKey(KEY_COLS)가 계산해
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
