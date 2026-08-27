// ============================================================================
// 자동화 설정 — 환경변수 + 지점 목록
// ----------------------------------------------------------------------------
// ⚠️ 여기엔 비밀값을 하드코딩하지 않는다. 모두 환경변수(GitHub Secrets / 로컬 .env)로 받는다.
//    이 폴더(automation/)는 앱(app/·components/·lib/)에서 절대 import 하지 않는다
//    — 클라이언트 번들에 섞이면 안 된다(정적 export + RLS 보안 모델 유지).
//    반대로 automation → shared/*.mjs 는 import 해도 된다(순수 함수, 의존성 0).
//
// 🔁 2026-08 개정
//    · 모듈 로드 시점에 throw 하지 않는다. 검증은 preflight() 로 미룬다
//      (notify.mjs 처럼 슬랙 토큰만 필요한 스크립트가 Supabase 설정 없이도 돌아야 한다).
//    · DRY_RUN 은 parseBool 로 엄격하게 읽는다 — 아래 주석 참고.
// ============================================================================

import { existsSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';

/* 로컬 실행 편의 — .env 파일을 읽어 준다.
   GitHub Actions 에서는 Secrets 가 이미 process.env 에 있고, dotenv 는 기존 값을
   덮어쓰지 않으므로 아무 영향이 없다(파일도 없다).
   우선순위: DOTENV_PATH > automation/.env > .env.local  (둘 다 .gitignore 대상)
   ⚠️ dotenv 는 devDependency 다. automation 은 npm ci(dev 포함)로 설치된 환경에서만 돈다. */
for (const p of [process.env.DOTENV_PATH, 'automation/.env', '.env.local']) {
  if (p && existsSync(p)) loadEnv({ path: p });
}

// 공개값 기본치 — lib/supabase.ts 와 같은 값이다(anon 키는 설계상 공개, CLAUDE.md 참고).
// ⚠️ 다른 Supabase 프로젝트로 옮기면 이 둘과 lib/supabase.ts 를 **함께** 고칠 것.
const DEFAULT_SUPABASE_URL = 'https://jxsdopvxtzpbyxxctcem.supabase.co';
const DEFAULT_SUPABASE_ANON_KEY =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imp4c2RvcHZ4dHpwYnl4eGN0Y2VtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyNjI3NDcsImV4cCI6MjA5ODgzODc0N30.5Uqa_RO1MxQw0CuEI2pMlTuD6zJm8NGbHoVeroFjXgI';

/* ----------------------------------------------------------------------
   불리언 환경변수 파싱.
   ⚠️ 예전 코드는 `(v ?? 'true').toLowerCase() !== 'false'` 였다. 그래서
      DRY_RUN=1 / DRY_RUN=yes / 오타 DRY_RUM=false 가 전부 **조용히 true**(=아무것도
      반영 안 함)가 되고 로그는 성공처럼 보였다. 밤새 아무 일도 안 일어났는데
      아침에 초록불만 남는다. → 모르는 값이면 **에러를 던진다.**
   ---------------------------------------------------------------------- */
export function parseBool(name, dflt) {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return dflt;
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'y', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'n', 'off'].includes(v)) return false;
  throw new Error(`${name} 값이 이상합니다: "${raw}" — true/false 만 허용합니다.`);
}

/* 모듈 로드 중에는 던지지 않고 미뤄 둔다 — notify.mjs(실패 알림 전용)가 DRY_RUN 오타 하나로
   같이 죽으면 "실패했다는 사실조차" 못 알린다. 에러는 preflight() 에서 되던진다. */
let _deferredError = null;
function safeBool(name, dflt) {
  try {
    return parseBool(name, dflt);
  } catch (err) {
    _deferredError = _deferredError || err;
    return dflt;
  }
}

/* 숫자 환경변수 — 못 읽으면 기본값. 0 이나 음수는 "무제한"이 되어 조용히 멈추므로 막는다. */
function num(name, dflt) {
  const raw = (process.env[name] ?? '').trim();
  if (!raw) return dflt;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

function list(name) {
  return (process.env[name] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// 실행 단계 — 부분 실행(디버깅·장애 후 재시도)용. 비면 전체.
/* attcount = 내일 예약자의 **실제 출석 수**를 회원 페이지에서 읽는 단계.
   roster 뒤·crm 앞이어야 한다(roster 가 대상 명단을, crm 이 그 값을 쓴다).
   docs/NEXT-attendance-count.md */
export const ALL_STEPS = ['attendance', 'roster', 'attcount', 'crm', 'slack'];

export const env = {
  // 공개값(anon 키는 비밀 아님) — NEXT_PUBLIC_* 이름으로 둬도 읽는다
  SUPABASE_URL:
    process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || DEFAULT_SUPABASE_URL,
  SUPABASE_ANON_KEY:
    process.env.SUPABASE_ANON_KEY ||
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
    DEFAULT_SUPABASE_ANON_KEY,

  // 비밀값 — 관리자 계정으로 로그인해 RLS 안에서 동작한다(service_role 미사용).
  ADMIN_EMAIL: process.env.ADMIN_EMAIL || '',
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || '',

  /* 스튜디오메이트 로그인(스크래핑용). MOCK_FILE 을 쓰면 없어도 된다.
     ⚠️ 이메일이 아니라 **휴대폰 번호**로 로그인한다(2026-08 실제 화면 확인).
        옛 이름 STUDIOMATE_EMAIL 도 읽어 준다 — 이미 등록한 Secret 이 있으면 그대로 쓰라고. */
  STUDIOMATE_PHONE: process.env.STUDIOMATE_PHONE || process.env.STUDIOMATE_EMAIL || '',
  STUDIOMATE_PASSWORD: process.env.STUDIOMATE_PASSWORD || '',

  // 슬랙 (Bot Token. 발송 전용 — 인터랙션 엔드포인트는 만들지 않는다)
  SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN || '',
  SLACK_CHANNEL_OPS: process.env.SLACK_CHANNEL_OPS || '', // 실패 알림 채널

  // 동작 옵션
  DRY_RUN: safeBool('DRY_RUN', true), // 기본 dry-run(안전)
  DRY_RUN_EXPLICIT: (process.env.DRY_RUN ?? '').trim() !== '',
  SLACK_DRY_RUN: safeBool('SLACK_DRY_RUN', safeBool('DRY_RUN', true)),
  SLACK_POST_EMPTY: safeBool('SLACK_POST_EMPTY', false), // 0명인 지점도 메시지를 보낼지
  MOCK_FILE: process.env.MOCK_FILE || '', // 스크래핑 대신 로컬 JSON 으로 파이프라인 검증
  MOCK_DATE: process.env.MOCK_DATE || '', // "오늘"을 고정 — 날짜 의존 규칙 재현에 필수
  TARGET_DATE: process.env.TARGET_DATE || '', // D+1 강제(장애 후 수동 재실행)
  STEPS: list('STEPS').length ? list('STEPS') : ALL_STEPS,

  /* 과거 예약 백필(automation/backfill.mjs) 전용. 기본은 "어제부터 14일" —
     휴면 규칙이 풀리는 최소치다(관측일수 = current_date - min(예약일자)). */
  BACKFILL_FROM: process.env.BACKFILL_FROM || '',
  BACKFILL_TO: process.env.BACKFILL_TO || '',
  BACKFILL_DAYS: process.env.BACKFILL_DAYS || '',

  /* 🔥 스크래핑 타임아웃 — 사이트가 느린 날이 있다.
     2026-08-21 실측(로컬): 로그인 19.7초 · /schedule 이동 25.4초 · 수업 상세 이동 23.7초.
     예전 한도 30초를 **스치듯 넘겨** 백필이 5개 사이트 전부 타임아웃으로 죽었다
     (에러 메시지는 전부 `page.goto: Timeout 30000ms exceeded`).
     한도는 "기다리는 시간"이 아니라 "포기하는 시점"이라, 넉넉히 잡아도 빠른 날엔 비용이 0 이다.
     반대로 짧으면 느린 날 하루치가 통째로 빈다 — 그쪽이 훨씬 비싸다. */
  SCRAPE_NAV_TIMEOUT: num('SCRAPE_NAV_TIMEOUT', 60000),
  SCRAPE_WAIT_TIMEOUT: num('SCRAPE_WAIT_TIMEOUT', 40000),

  ONLY_BRANCHES: list('ONLY_BRANCHES'), // 쉼표구분 지점명; 비면 전체
  HEADLESS: safeBool('HEADLESS', true), // 라이브 셀렉터 작업 때 false 로 두면 창이 보인다
  RUN_URL: process.env.RUN_URL || '', // GitHub Actions run 링크(실패 알림에 첨부)
};

/* 지점 — 슬랙 발송 단위. 채널은 **이름(#광교)이 아니라 ID(C0123ABCD)** 를 넣는다.
   이름은 바뀌면 조용히 실패하고, 그러면 그 지점만 CRM 이 끊긴다. */
export const BRANCHES = [
  { name: '청담', slack: process.env.SLACK_CHANNEL_CHEONGDAM || '' },
  { name: '옥수', slack: process.env.SLACK_CHANNEL_OKSU || '' },
  { name: '광교', slack: process.env.SLACK_CHANNEL_GWANGGYO || '' },
  { name: '반포', slack: process.env.SLACK_CHANNEL_BANPO || '' },
  { name: '판교', slack: process.env.SLACK_CHANNEL_PANGYO || '' },
  { name: '송파', slack: process.env.SLACK_CHANNEL_SONGPA || '' },
].filter((b) => !env.ONLY_BRANCHES.length || env.ONLY_BRANCHES.includes(b.name));

/* 스튜디오메이트 사이트 — ⚠️ 지점과 1:1 이 아니다.
   **청담과 판교는 `everybarre` 한 사이트를 같이 쓴다**(일간·룸별 뷰의 룸 컬럼이 지점이다).
   그래서 스크랩 단위는 "지점"이 아니라 "사이트"이고, 각 예약행의 지점은
   수강권명에서 뽑는다(branchOf). 태그가 없으면 defaultBranch 로 폴백.

   slug 는 비밀이 아니라 공개 서브도메인이라 기본값을 코드에 둔다(Secrets 6개가 준다).
   다른 스튜디오로 옮기면 SM_SLUG_* 환경변수로 덮어쓸 수 있다. */
export const SITES = [
  {
    slug: process.env.SM_SLUG_MAIN || 'everybarre',
    label: '청담·판교',
    branches: ['청담', '판교'],
    defaultBranch: '청담',
  },
  { slug: process.env.SM_SLUG_GWANGGYO || 'everybarre-gwanggyo', label: '광교', branches: ['광교'], defaultBranch: '광교' },
  { slug: process.env.SM_SLUG_OKSU     || 'everybarre-oksu',     label: '옥수', branches: ['옥수'], defaultBranch: '옥수' },
  { slug: process.env.SM_SLUG_BANPO    || 'everybarre-banpo',    label: '반포', branches: ['반포'], defaultBranch: '반포' },
  { slug: process.env.SM_SLUG_SONGPA   || 'everybarre-songpa',   label: '송파', branches: ['송파'], defaultBranch: '송파' },
].filter(
  (s) => !env.ONLY_BRANCHES.length || s.branches.some((b) => env.ONLY_BRANCHES.includes(b)),
);

/* 지점 → 사이트 slug.
   ⚠️ 출석 수(crm_attendance)는 **사이트별**이라, 보정할 때도 사이트를 맞춰야 한다.
      청담·판교는 둘 다 everybarre 하나로 간다. 모르는 지점이면 '' — 호출부는 ''
      를 "모른다"로 보고 **더하지 않는다**(지어내는 것보다 낫다). */
const _SITE_OF_BRANCH = new Map();
for (const s of SITES) for (const b of s.branches) _SITE_OF_BRANCH.set(b, s.slug);
export function siteOfBranch(branch) {
  return _SITE_OF_BRANCH.get(String(branch ?? '')) || '';
}

/* ----------------------------------------------------------------------
   preflight — 실행에 필요한 설정이 다 있는지 **시작 전에** 확인한다.
   중간에 죽으면 "출석은 반영됐는데 슬랙은 안 나간" 어중간한 상태가 남기 때문에,
   부분 실행을 허용하지 않고 처음부터 멈춘다.
   ---------------------------------------------------------------------- */
/* steps 를 넘기면 그 단계만 검사한다 — 백필(automation/backfill.mjs)처럼 슬랙을 안 쓰는
   스크립트가 SLACK_* 미설정만으로 못 돌면 안 된다. 안 넘기면 env.STEPS(=실행 전체). */
export function preflight(steps = env.STEPS) {
  if (_deferredError) throw _deferredError; // DRY_RUN 등 불리언 값 오타
  const missing = [];
  const warn = [];

  for (const k of ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'ADMIN_EMAIL', 'ADMIN_PASSWORD']) {
    if (!env[k]) missing.push(k);
  }

  const needsScrape =
    steps.includes('attendance') || steps.includes('roster') || steps.includes('attcount');
  if (needsScrape && !env.MOCK_FILE) {
    if (!env.STUDIOMATE_PHONE) missing.push('STUDIOMATE_PHONE (휴대폰 번호로 로그인합니다)');
    if (!env.STUDIOMATE_PASSWORD) missing.push('STUDIOMATE_PASSWORD');
    if (!SITES.length) missing.push('스크랩할 사이트가 없습니다 (ONLY_BRANCHES 확인)');
  }

  if (steps.includes('slack') && !env.SLACK_DRY_RUN) {
    if (!env.SLACK_BOT_TOKEN) missing.push('SLACK_BOT_TOKEN');
    const noCh = BRANCHES.filter((b) => !b.slack).map((b) => b.name);
    if (noCh.length === BRANCHES.length) missing.push('SLACK_CHANNEL_* (전 지점 미설정)');
    else if (noCh.length) warn.push(`슬랙 채널 미설정으로 건너뛸 지점: ${noCh.join(', ')}`);
    if (!env.SLACK_CHANNEL_OPS) warn.push('SLACK_CHANNEL_OPS 미설정 — 실패 알림이 안 갑니다.');
  }

  const badStep = env.STEPS.filter((s) => !ALL_STEPS.includes(s));
  if (badStep.length) missing.push(`STEPS 에 모르는 값: ${badStep.join(', ')} (허용: ${ALL_STEPS.join(', ')})`);

  if (!env.DRY_RUN_EXPLICIT) {
    warn.push(
      'DRY_RUN 미설정 → dry-run 으로 동작합니다. ' +
        'members·reservations·crm_messages 저장과 슬랙 발송을 전부 하지 않습니다.',
    );
  }

  if (missing.length) {
    throw new Error(`설정이 부족합니다:\n  · ${missing.join('\n  · ')}`);
  }
  return warn;
}
