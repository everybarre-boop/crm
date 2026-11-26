// ============================================================================
// 출석 수 일괄 보정 (1회성)
// ----------------------------------------------------------------------------
// 두 가지 모드가 있다.
//
// ① 기본 — 수강권은 있는데 출석 기록이 없는 (사람, 사이트)를 채운다 (2026-11-26 임동우 사고).
//    예전 attcount 는 내일 예약이 잡힌 사이트만 읽었다. 그래서 예전에 다닌 사이트의 출석이
//    한 번도 안 읽힌 회원이 125명(빠진 사이트 143곳)이었다.
//    대상: crm_attendance 에 한 사이트라도 기록이 있는 사람 중, 기록이 없는 사이트.
//
// ② YEARS=true — **전 회원 × 수강권이 있는 전 사이트**의 연도별 출석을 채운다 (2026-11-26).
//    회원별 집계의 연도별 출석(crm_attendance_person_yearly)의 근거. 이용내역 → 출석 탭의
//    엑셀 다운로드로 수업일을 읽는다(scrape.mjs 의 readYearlyAttendance). 출석 합계도 같이 갱신.
//    대상: members 의 모든 사람(연락처가 있거나 이미 회원 id 를 아는 사람).
//    이미 연도별이 있는 (사이트, 회원id) 는 건너뛴다 → **중간에 끊겨도 다시 돌리면 이어서 한다.**
//    BATCH 명씩 읽고 바로 저장한다(몇 시간짜리라 끝에 한 번 저장하면 죽을 때 다 잃는다).
//
// 실행 예:
//   DRY_RUN=true  node automation/attcount-backfill.mjs                 # 대상 건수만(브라우저 안 염)
//   DRY_RUN=false node automation/attcount-backfill.mjs                 # ① 실제 저장
//   DRY_RUN=false YEARS=true ONLY_BRANCHES=옥수 node automation/attcount-backfill.mjs
//     → 사이트별로 따로 띄우면 병렬로 돈다(사이트마다 세션이 따로라 서로 안 막는다).
//       청담·판교는 사이트가 하나(everybarre)라 ONLY_BRANCHES=청담 하나로 둘 다 처리된다.
//
// 재실행 안전: crm_attendance 는 (site, 회원id) upsert. id 를 못 찾은 사람은 다음 실행에서 다시 시도.
// ============================================================================
import { env, parseBool, preflight } from './config.mjs';
import { fetchAttendanceRows, fetchMemberSiteRows } from './db.mjs';
import { makeNeedsYears, personOfKey, planAttendanceReads, readAttendancePlan } from './attcount.mjs';
import { dateKST, makePersonResolver } from '../shared/crm-core.mjs';

const BATCH = 40;

/** members 의 모든 사람 — 대표 이름(개명 병합 후) + 숫자 연락처. 연락처가 없으면 검색할 수 없어 뺀다. */
function peopleFromMembers(memberRows) {
  const keyOf = makePersonResolver(memberRows);
  const out = new Map();
  for (const r of memberRows) {
    const k = keyOf(r);
    if (out.has(k)) continue;
    const p = personOfKey(k);
    if (!/^\d{9,}$/.test(p.연락처)) continue;
    out.set(k, p);
  }
  return [...out.values()];
}

/** 사이트 계획을 BATCH 명씩 쪼갠다 — 한 묶음 = 한 번 저장. */
function* batches(plan) {
  for (const [site, { byId, toFind }] of plan) {
    const ids = [...byId.values()];
    for (let i = 0; i < ids.length; i += BATCH) {
      yield new Map([[site, { byId: new Map(ids.slice(i, i + BATCH).map((t) => [t.회원id, t])), toFind: [] }]]);
    }
    for (let i = 0; i < toFind.length; i += BATCH) {
      yield new Map([[site, { byId: new Map(), toFind: toFind.slice(i, i + BATCH) }]]);
    }
  }
}

async function main() {
  for (const w of preflight(['attcount'])) console.warn(`⚠️  ${w}`);
  const today = dateKST(0);
  const dryRun = env.DRY_RUN;
  const years = parseBool('YEARS', false);

  const [memberRows, attendanceRows] = await Promise.all([fetchMemberSiteRows(), fetchAttendanceRows()]);
  const seen = new Set();
  const people = years ? peopleFromMembers(memberRows) : [];
  for (const a of attendanceRows) {
    if (seen.has(a.person_key)) continue;
    seen.add(a.person_key);
    people.push(personOfKey(a.person_key));
  }
  const plan = planAttendanceReads({ people, memberRows, attendanceRows, reread: years });
  const needsYears = years ? makeNeedsYears(attendanceRows) : () => false;

  // 연도별 모드: 이미 연도별이 있는 회원은 계획에서 뺀다(재실행 = 이어서)
  if (years) {
    for (const [site, s] of plan) {
      for (const id of [...s.byId.keys()]) if (!needsYears(site, id)) s.byId.delete(id);
    }
  }

  // SHARD=i/n — 한 사이트를 여러 프로세스로 나눠 돌린다(청담·판교 사이트만 5천 명이라 혼자 6시간).
  //   ⚠️ 순번이 아니라 **키의 해시**로 나눈다 — 순번은 다른 샤드가 저장할 때마다(이미 읽은 회원이
  //      계획에서 빠지며) 밀려서, 늦게 띄운 샤드와 겹치거나 빈다. 해시는 계획이 바뀌어도 그대로다.
  const shard = String(process.env.SHARD || '').match(/^(\d+)\/(\d+)$/);
  if (process.env.SHARD && !shard) throw new Error(`SHARD 값이 이상합니다: "${process.env.SHARD}" — 예: SHARD=0/3`);
  if (shard) {
    const [i, n] = [Number(shard[1]), Number(shard[2])];
    if (!(n > 0 && i < n)) throw new Error(`SHARD 범위가 이상합니다: ${i}/${n}`);
    const bucket = (s) => {
      let h = 0;
      for (const ch of String(s)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
      return h % n;
    };
    for (const s of plan.values()) {
      s.byId = new Map([...s.byId].filter(([id]) => bucket(id) === i));
      s.toFind = s.toFind.filter((t) => bucket(t.person_key) === i);
    }
    console.log(`[샤드] ${i}/${n}`);
  }

  let total = 0;
  for (const [site, { byId, toFind }] of plan) {
    const n = byId.size + toFind.length;
    total += n;
    console.log(`[계획] ${site}: ${n}명 (id 검색 필요 ${toFind.length})`);
  }
  console.log(
    `=== ${years ? '연도별 출석' : '출석 기록이 빠진'} (사람, 사이트) ${total}건 · 기준일 ${today} · dry_run=${dryRun} ===`,
  );
  if (dryRun || !total) return;

  const { chromium } = await import('playwright');
  const { loginStudioMate } = await import('./studiomate.mjs');
  const browser = await chromium.launch({ headless: env.HEADLESS });
  const page = await (await browser.newContext({ acceptDownloads: true })).newPage();
  const loggedIn = new Set();
  const errors = [];
  const sum = { read: 0, failed: 0, notFound: 0, years: 0, yearsFailed: 0 };
  const t0 = Date.now();
  let done = 0;
  try {
    for (const part of batches(plan)) {
      const [[site, s]] = part;
      const n = s.byId.size + s.toFind.length;
      const tot = await readAttendancePlan(page, part, {
        today,
        dryRun,
        needsYears,
        ensureLogin: async (p, slug) => {
          if (loggedIn.has(slug)) return;
          await loginStudioMate(p, { phone: env.STUDIOMATE_PHONE, password: env.STUDIOMATE_PASSWORD, slug });
          loggedIn.add(slug);
        },
        onSiteError: (st, err) => {
          errors.push(st);
          console.error(`[error] ${st}: ${err?.message ?? err}`);
          loggedIn.delete(st); // 세션이 끊겼을 수 있다 — 다음 묶음은 로그인부터
        },
      });
      for (const k of Object.keys(sum)) sum[k] += tot[k] || 0;
      done += n;
      const min = (Date.now() - t0) / 60000;
      console.log(
        `[진행] ${site} ${done}/${total} · ${min.toFixed(0)}분 경과 · 남은 예상 ${((min / done) * (total - done)).toFixed(0)}분`,
      );
    }
    console.log(
      `=== 완료 · 읽음 ${sum.read} · 연도별 ${sum.years} · 연도별 실패 ${sum.yearsFailed}` +
        ` · 읽기 실패 ${sum.failed} · id 못 찾음 ${sum.notFound} · 묶음 실패 ${errors.length} ===`,
    );
    if (errors.length || sum.failed || sum.yearsFailed) process.exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((err) => {
  console.error(err?.message ?? err);
  process.exitCode = 1;
});
