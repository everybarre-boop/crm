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
import { pgTable, pgPolicy, bigint, text, jsonb, timestamp } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const members = pgTable(
  'members',
  {
    // bigint identity. maxValue 등은 Postgres 기본값이라 굳이 명시하지 않는다.
    // (JS number 로는 bigint 최댓값을 정확히 표현 못 해 허위 diff 가 생긴다.)
    id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    이름: text('이름'),
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
    raw: jsonb(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).defaultNow(),
  },
  () => [
    // RLS: 관리자 이메일 화이트리스트(authenticated). 유일한 PII 방어선. (CLAUDE.md 참고)
    pgPolicy('admins_full_access', {
      as: 'permissive',
      for: 'all',
      to: ['authenticated'],
      using: sql`((auth.jwt() ->> 'email'::text) = ANY (ARRAY['basegolf.official@gmail.com'::text]))`,
      withCheck: sql`((auth.jwt() ->> 'email'::text) = ANY (ARRAY['basegolf.official@gmail.com'::text]))`,
    }),
  ],
);
