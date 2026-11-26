// ============================================================================
// 출석 수 일괄 보정 — 수강권은 있는데 출석 기록이 없는 (사람, 사이트)를 채운다 (1회성)
// ----------------------------------------------------------------------------
// 왜 필요한가 (2026-11-26 임동우 사고):
//   예전 attcount 는 내일 예약이 잡힌 사이트만 읽었다. 그래서 예전에 다닌 사이트의 출석이
//   한 번도 안 읽힌 회원이 125명(빠진 사이트 143곳)이었고, 회원별 집계의 출석 합계가 그만큼
//   낮게 나왔다. 야간 실행은 이제 전 사이트를 읽지만, 그건 **내일 예약자**에 한해서라
//   예약이 뜸한 회원은 한참 동안 그대로다 → 이 스크립트로 한 번에 메운다.
//
// 대상: crm_attendance 에 한 사이트라도 기록이 있는 사람 중, members 상 수강권이 있는데
//       기록이 없는 사이트. 그 사이트에서 연락처로 회원 id 를 찾아 회원 페이지를 읽는다.
//       이미 기록이 있는 사이트는 다시 읽지 않는다(그건 뷰가 reservations 로 보정한다).
//
// 실행 예:
//   DRY_RUN=true  node automation/attcount-backfill.mjs   # 대상 건수만(브라우저를 안 연다)
//   DRY_RUN=false node automation/attcount-backfill.mjs   # 실제 저장
//   DRY_RUN=false ONLY_BRANCHES=옥수 node automation/attcount-backfill.mjs
//
// 재실행 안전: crm_attendance 는 (site, 회원id) upsert 이고, 다시 돌리면 이미 채운 사이트는
// 대상에서 빠진다. id 를 못 찾은 사람은 다음 실행에서 다시 시도된다.
// ============================================================================
import { env, preflight } from './config.mjs';
import { fetchAttendanceRows, fetchMemberSiteRows } from './db.mjs';
import { personOfKey, planAttendanceReads, readAttendancePlan } from './attcount.mjs';
import { dateKST } from '../shared/crm-core.mjs';

async function main() {
  for (const w of preflight(['attcount'])) console.warn(`⚠️  ${w}`);
  const today = dateKST(0);
  const dryRun = env.DRY_RUN;

  const [memberRows, attendanceRows] = await Promise.all([fetchMemberSiteRows(), fetchAttendanceRows()]);
  const seen = new Set();
  const people = [];
  for (const a of attendanceRows) {
    if (seen.has(a.person_key)) continue;
    seen.add(a.person_key);
    people.push(personOfKey(a.person_key));
  }
  const plan = planAttendanceReads({ people, memberRows, attendanceRows, reread: false });

  let total = 0;
  for (const [site, { byId, toFind }] of plan) {
    const n = byId.size + toFind.length;
    total += n;
    console.log(`[계획] ${site}: ${n}명 (id 검색 필요 ${toFind.length})`);
  }
  console.log(`=== 출석 기록이 빠진 (사람, 사이트) ${total}건 · 기준일 ${today} · dry_run=${dryRun} ===`);
  if (dryRun || !total) return;

  const { chromium } = await import('playwright');
  const { loginStudioMate } = await import('./studiomate.mjs');
  const browser = await chromium.launch({ headless: env.HEADLESS });
  const page = await (await browser.newContext()).newPage();
  const loggedIn = new Set();
  const errors = [];
  try {
    const tot = await readAttendancePlan(page, plan, {
      today,
      dryRun,
      ensureLogin: async (p, slug) => {
        if (loggedIn.has(slug)) return;
        await loginStudioMate(p, { phone: env.STUDIOMATE_PHONE, password: env.STUDIOMATE_PASSWORD, slug });
        loggedIn.add(slug);
      },
      onSiteError: (site, err) => {
        errors.push(site);
        console.error(`[error] ${site}: ${err?.message ?? err}`);
      },
    });
    console.log(
      `=== 완료 · 읽음 ${tot.read} · 읽기 실패 ${tot.failed} · id 못 찾음 ${tot.notFound}` +
        ` · 사이트 실패 ${errors.length} ===`,
    );
    if (errors.length || tot.failed) process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exitCode = 1;
});
