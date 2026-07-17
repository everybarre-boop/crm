// ============================================================================
// 자동화 설정 — 환경변수 + 지점 목록
// ----------------------------------------------------------------------------
// ⚠️ 여기엔 비밀값을 하드코딩하지 않는다. 모두 환경변수(GitHub Secrets / 로컬 .env)로 받는다.
//    이 폴더(automation/)는 앱(app/·components/·lib/supabase.ts)에서 절대 import 하지 않는다
//    — 클라이언트 번들에 섞이면 안 된다(정적 export + RLS 보안 모델 유지).
// ============================================================================

function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`환경변수 ${name} 가 없습니다. (GitHub Secrets 또는 automation/.env 에 설정)`);
  return v;
}

export const env = {
  // 공개값(anon 키는 비밀 아님) — 없으면 앱 기본값과 동일 URL 을 쓰도록 요구
  SUPABASE_URL: req('SUPABASE_URL'),
  SUPABASE_ANON_KEY: req('SUPABASE_ANON_KEY'),

  // 비밀값 — 관리자 계정으로 로그인해 RLS 안에서 동작한다(service_role 미사용).
  ADMIN_EMAIL: req('ADMIN_EMAIL'),
  ADMIN_PASSWORD: req('ADMIN_PASSWORD'),

  // 스튜디오메이트 로그인(스크래핑용). MOCK_FILE 을 쓰면 없어도 된다.
  STUDIOMATE_EMAIL: process.env.STUDIOMATE_EMAIL || '',
  STUDIOMATE_PASSWORD: process.env.STUDIOMATE_PASSWORD || '',

  // 동작 옵션
  DRY_RUN: (process.env.DRY_RUN ?? 'true').toLowerCase() !== 'false', // 기본 dry-run(안전)
  MOCK_FILE: process.env.MOCK_FILE || '', // 스크래핑 대신 로컬 JSON 을 읽어 파이프라인 검증
  ONLY_BRANCHES: (process.env.ONLY_BRANCHES || '') // 쉼표구분 지점명; 비면 전체
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

// 지점 목록 — 각 지점의 스튜디오메이트 사이트 식별자(slug)를 채워 넣는다.
// (gwanggyo SQL 출처가 "everybarre-gwanggyo" 였다 → 지점마다 서브도메인/slug 가 다를 가능성.)
// slug 가 비어 있으면 그 지점 스크래핑은 건너뛴다(설정 전까지 안전).
export const BRANCHES = [
  { name: '청담', slug: process.env.SM_SLUG_CHEONGDAM || '' },
  { name: '옥수', slug: process.env.SM_SLUG_OKSU || '' },
  { name: '광교', slug: process.env.SM_SLUG_GWANGGYO || '' },
  { name: '반포', slug: process.env.SM_SLUG_BANPO || '' },
  { name: '판교', slug: process.env.SM_SLUG_PANGYO || '' },
  { name: '송파', slug: process.env.SM_SLUG_SONGPA || '' },
].filter((b) => !env.ONLY_BRANCHES.length || env.ONLY_BRANCHES.includes(b.name));
