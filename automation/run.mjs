// ============================================================================
// 일간 자동 갱신 오케스트레이터
// ----------------------------------------------------------------------------
// 흐름: (스크랩 or MOCK) → 지점별 records → apply_attendance RPC(dry-run/반영) → 요약 출력
//
// 실행:
//   # 1) 파이프라인만 먼저 검증 (스튜디오메이트 없이, 항상 dry-run 권장)
//   MOCK_FILE=automation/mock.local.json DRY_RUN=true node automation/run.mjs
//
//   # 2) 실제 스크랩 + dry-run (셀렉터 채운 뒤)
//   DRY_RUN=true node automation/run.mjs
//
//   # 3) 실제 반영
//   DRY_RUN=false node automation/run.mjs
//
// 환경변수는 automation/config.mjs 참고. 비밀값은 GitHub Secrets 또는 로컬 .env.
// ============================================================================
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { env, BRANCHES } from './config.mjs';
import { applyAttendance } from './apply.mjs';

// 오늘 날짜 (KST). GitHub Actions 는 UTC 라 KST 로 보정.
function todayKST() {
  const now = new Date();
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10); // YYYY-MM-DD
}

// records 를 지점별로 나눈다. record 에 지점 힌트가 없으면 수강권명에서 추론.
function groupByBranch(records) {
  const names = BRANCHES.map((b) => b.name);
  const map = new Map();
  for (const r of records) {
    const hit = names.find((n) => String(r.수강권명 ?? '').includes(n)) || '(미지정)';
    if (!map.has(hit)) map.set(hit, []);
    map.get(hit).push(r);
  }
  return map;
}

async function collectRecords() {
  if (env.MOCK_FILE) {
    const raw = await readFile(env.MOCK_FILE, 'utf8');
    const arr = JSON.parse(raw);
    console.log(`[mock] ${env.MOCK_FILE} 에서 ${arr.length}건 로드`);
    return arr;
  }
  // 실제 스크래핑 — playwright 는 automation 실행 시에만 로드(앱 번들과 무관).
  const { chromium } = await import('playwright');
  const { loginStudioMate, scrapeBranch } = await import('./studiomate.mjs');
  const date = todayKST();
  const browser = await chromium.launch({ headless: true });
  const all = [];
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    if (env.STUDIOMATE_EMAIL) {
      await loginStudioMate(page, { email: env.STUDIOMATE_EMAIL, password: env.STUDIOMATE_PASSWORD });
    }
    for (const branch of BRANCHES) {
      if (!branch.slug) {
        console.log(`[skip] ${branch.name}: slug 미설정`);
        continue;
      }
      try {
        const recs = await scrapeBranch(page, branch, { date });
        console.log(`[scrape] ${branch.name}: ${recs.length}건`);
        all.push(...recs);
      } catch (err) {
        console.error(`[error] ${branch.name} 스크랩 실패: ${err.message}`);
      }
    }
  } finally {
    await browser.close();
  }
  return all;
}

async function main() {
  console.log(`=== 일간 갱신 시작 (dry_run=${env.DRY_RUN}, ${todayKST()}) ===`);
  const records = await collectRecords();
  if (!records.length) {
    console.log('반영할 예약자 records 가 없습니다. 종료.');
    return;
  }

  const grouped = groupByBranch(records);
  const summaries = [];
  for (const [branch, recs] of grouped) {
    const res = await applyAttendance(recs, { dryRun: env.DRY_RUN, branch });
    summaries.push(res);
    console.log(
      `[apply] ${branch}: 요청 ${res.requested} / 매칭 ${res.matched} / 미매칭 ${res.unmatched_count}` +
        (res.dry_run ? ' (dry-run)' : ' (반영됨)'),
    );
    if (res.unmatched_count > 0) {
      console.warn(`  ⚠️ 미매칭 ${res.unmatched_count}건 — DB에서 이름/연락처/수강권명이 안 맞음:`);
      for (const u of res.unmatched) console.warn(`     · ${u.이름} / ${u.수강권명} / ${u.연락처}`);
    }
  }

  // 감사용 로컬 로그(gitignore: automation/out/). PII 포함이라 커밋 금지.
  await mkdir('automation/out', { recursive: true });
  const stamp = todayKST();
  await writeFile(`automation/out/run-${stamp}.local.json`, JSON.stringify(summaries, null, 2), 'utf8');

  const totalUnmatched = summaries.reduce((s, r) => s + r.unmatched_count, 0);
  console.log(`=== 완료. 총 미매칭 ${totalUnmatched}건 ===`);
}

main().catch((err) => {
  console.error('실행 실패:', err);
  process.exit(1);
});
