/* ======================================================================
   drizzle-kit 설정 — 개발 도구 전용 (스키마/마이그레이션 관리)
   · DATABASE_URL 은 Supabase Postgres 접속 문자열(전권). .env.local 에만 두고
     절대 커밋하지 말 것. (.gitignore 로 차단됨) 런타임 앱은 이 값을 쓰지 않는다.
   · Supabase 대시보드 → Project Settings → Database → Connection string 에서 받는다.
     (마이그레이션은 세션/트랜잭션 풀러 대신 직접 연결 문자열 권장)
   ====================================================================== */
import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// 런타임(.env.local 자동 로드)이 아니라 drizzle-kit CLI 이므로 직접 로드한다.
config({ path: '.env.local' });

export default defineConfig({
  schema: './lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? '',
  },
  // public.members 만 관리 대상으로 좁힌다 (Supabase 내부 스키마 건드리지 않도록).
  schemaFilter: ['public'],
  tablesFilter: ['members'],
  verbose: true,
  strict: true,
});
