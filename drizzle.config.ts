/* ======================================================================
   drizzle-kit 설정 — 개발 도구 전용 (스키마/마이그레이션 관리)
   · DATABASE_URL 은 Supabase Postgres 접속 문자열(전권). .env.local 에만 두고
     절대 커밋하지 말 것. (.gitignore 로 차단됨) 런타임 앱은 이 값을 쓰지 않는다.
   · Supabase 대시보드 → Connect → Session pooler 문자열을 쓴다.
     직접 연결(db.<ref>.supabase.co)은 IPv6 전용이라 대부분의 IPv4 환경에서
     DNS 가 안 잡힌다(ENOTFOUND). 풀러(aws-*.pooler.supabase.com)를 권장한다.
   ====================================================================== */
import { config } from 'dotenv';
import { defineConfig } from 'drizzle-kit';

// 런타임(.env.local 자동 로드)이 아니라 drizzle-kit CLI 이므로 직접 로드한다.
config({ path: '.env.local' });

// 비어 있으면 drizzle-kit 이 불분명한 연결/파싱 오류를 내므로 여기서 먼저 막는다.
const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error(
    'DATABASE_URL 이 설정되지 않았습니다. .env.local 에 Supabase Postgres 접속 문자열을 넣으세요. (.env.local.example 참고)',
  );
}

export default defineConfig({
  schema: './lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url },
  // public.members 만 관리 대상으로 좁힌다 (Supabase 내부 스키마 건드리지 않도록).
  schemaFilter: ['public'],
  tablesFilter: ['members'],
  verbose: true,
  strict: true,
});
