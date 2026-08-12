// ============================================================================
// 과거 예약 백필 — "14일 미방문"을 도입 첫날부터 내기 위한 1회성 채우기
// ----------------------------------------------------------------------------
// 왜 필요한가:
//   휴면 규칙은 reservations 스냅샷이 쌓여야 동작한다. 관측일수는
//     crm_history_depth.관측일수 = current_date - min(예약일자)
//   라서, 매일 실행만으로는 14일을 기다려야 명단이 나온다.
//   스튜디오메이트는 **과거 날짜를 조회할 수 있으므로** 그 14일을 미리 채울 수 있다.
//
// ⚠️ 이 스크립트는 reservations 만 채운다 — apply_attendance 는 **절대 부르지 않는다.**
//    수업 상세의 "12회 남음"은 그 날짜의 값이 아니라 **회원의 현재 잔여횟수**다.
//    과거 날짜를 돌면서 members 를 갱신하면 같은 값을 수백 번 덮어쓸 뿐이고,
//    중간에 실패하면 어느 날짜까지 반영됐는지도 알 수 없게 된다.
//    출석 반영은 매일 도는 run.mjs 의 attendance 단계가 D-1 에 대해서만 한다.
//
// 실행 예:
//   # 어제부터 14일 전까지 (기본) — 먼저 dry-run 으로 건수만 확인
//   DRY_RUN=true node automation/backfill.mjs
//   # 실제 저장. 30일치.
//   DRY_RUN=false BACKFILL_DAYS=30 node automation/backfill.mjs
//   # 기간 직접 지정
//   DRY_RUN=false BACKFILL_FROM=2026-07-15 BACKFILL_TO=2026-08-11 node automation/backfill.mjs
//   # 한 지점만
//   DRY_RUN=false ONLY_BRANCHES=광교 node automation/backfill.mjs
//
// 재실행 안전:
//   · reservations 는 res_key upsert 라 같은 날짜를 두 번 넣어도 중복되지 않는다.
//   · 어디까지 했는지 automation/out/backfill-progress.local.json 에 남긴다.
//     중단 후 다시 돌리면 끝낸 (사이트,날짜)는 건너뛴다. RESET_PROGRESS=true 로 초기화.
// ============================================================================
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { SITES, env, parseBool, preflight } from './config.mjs';
import { saveReservations } from './db.mjs';
import { addDays, dateKST, daysBetween } from '../shared/crm-core.mjs';

const OUT_DIR = 'automation/out';
const PROGRESS = `${OUT_DIR}/backfill-progress.local.json`;

/* ----------------------------------------------------------------------
   기간 정하기
   기본: 어제부터 거슬러 BACKFILL_DAYS 일 (기본 14 — 휴면 규칙이 풀리는 최소치)
   ⚠️ 오늘·미래는 넣지 않는다. 미래 예약은 매일 도는 roster 단계가 맡고, 여기서
      같이 긁으면 확정 전 상태('예약')가 섞여 백필 결과를 읽기 어려워진다.
   ---------------------------------------------------------------------- */
function resolveRange() {
  const 어제 = dateKST(-1);
  const to = env.BACKFILL_TO || 어제;
  const days = Number(env.BACKFILL_DAYS || 14);
  const from = env.BACKFILL_FROM || addDays(to, -(days - 1));

  const span = daysBetween(from, to);
  if (span === null) throw new Error(`기간을 읽지 못했습니다 (from="${from}", to="${to}")`);
  if (span < 0) throw new Error(`BACKFILL_FROM(${from}) 이 BACKFILL_TO(${to}) 보다 뒤입니다.`);
  if (to > 어제) {
    throw new Error(
      `BACKFILL_TO(${to}) 가 어제(${어제}) 보다 뒤입니다 — 백필은 과거만 채웁니다. ` +
        `내일 예약은 run.mjs 의 roster 단계가 맡습니다.`,
    );
  }
  const dates = [];
  for (let d = from; ; d = addDays(d, 1)) {
    dates.push(d);
    if (d === to) break;
    if (dates.length > 400) throw new Error('기간이 400일을 넘습니다 — 범위를 확인하세요.');
  }
  return { from, to, dates };
}

/* ----------------------------------------------------------------------
   진행 상황 — (사이트,날짜) 단위. 실명은 안 들어간다.
   ---------------------------------------------------------------------- */
async function loadProgress() {
  if (parseBool('RESET_PROGRESS', false)) return new Set();
  try {
    const raw = JSON.parse(await readFile(PROGRESS, 'utf8'));
    return new Set(raw.done || []);
  } catch {
    return new Set();
  }
}

async function saveProgress(done) {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(PROGRESS, JSON.stringify({ done: [...done] }, null, 2), 'utf8');
}

/* ========================================================================== */
async function main() {
  /* 스크랩 단계만 검사한다 — 백필은 슬랙을 안 쓰므로 SLACK_* 미설정으로 막히면 안 된다. */
  const warns = preflight(['attendance']);
  for (const w of warns) console.warn(`⚠️  ${w}`);

  if (env.MOCK_FILE) {
    throw new Error('백필은 실제 스크랩 전용입니다 (MOCK_FILE 을 비우고 실행하세요).');
  }
  const { from, to, dates } = resolveRange();
  const dryRun = env.DRY_RUN;
  const done = await loadProgress();

  console.log(
    `=== 과거 예약 백필 · ${from} ~ ${to} (${dates.length}일) · 사이트 ${SITES.length}곳\n` +
      `    dry_run=${dryRun}${done.size ? ` · 이미 끝낸 (사이트,날짜) ${done.size}건은 건너뜁니다` : ''} ===`,
  );
  if (!dryRun) {
    console.log('    ℹ️ reservations 만 채웁니다. members(출석 반영)는 건드리지 않습니다.');
  }

  const { chromium } = await import('playwright');
  const { loginStudioMate, scrapeBranch } = await import('./studiomate.mjs');
  const browser = await chromium.launch({ headless: env.HEADLESS });
  const page = await (await browser.newContext()).newPage();

  const failures = [];
  let 저장합 = 0;
  let 행합 = 0;

  try {
    /* 사이트를 바깥, 날짜를 안쪽에 둔다 — 사이트마다 로그인이 1회고, 날짜는 화살표로
       한 칸씩만 움직이면 된다(navigate:false). 반대로 두면 매 날짜마다 5번 로그인한다. */
    for (const site of SITES) {
      try {
        await loginStudioMate(page, {
          phone: env.STUDIOMATE_PHONE,
          password: env.STUDIOMATE_PASSWORD,
          slug: site.slug,
        });
      } catch (err) {
        failures.push({ site: site.label, date: '(로그인)', error: String(err.message ?? err) });
        console.error(`[error] ${site.label} 로그인 실패 — 이 사이트 전체를 건너뜁니다: ${err.message}`);
        continue;
      }

      let 첫날 = true;
      for (const date of dates) {
        const mark = `${site.slug}|${date}`;
        if (done.has(mark)) continue;

        try {
          const { rows, 수업수, 누락, 대기 } = await scrapeBranch(page, site, {
            date,
            navigate: 첫날, // 첫 날짜만 /schedule 로 이동, 이후는 화살표로 한 칸씩
          });
          첫날 = false;

          // 지점별로 나눠 저장한다 — save_reservations 가 지점 단위로 로그를 남긴다
          const byBranch = new Map();
          for (const r of rows) {
            const b = r.지점 || '(미지정)';
            if (env.ONLY_BRANCHES.length && !env.ONLY_BRANCHES.includes(b)) continue;
            if (!byBranch.has(b)) byBranch.set(b, []);
            byBranch.get(b).push(r);
          }

          let 저장 = 0;
          let 중복 = 0;
          let 파싱실패 = 0;
          for (const [branch, list] of byBranch) {
            const res = await saveReservations(list, { branch, targetDate: date, dryRun });
            저장 += res.saved ?? 0;
            중복 += res.duplicates ?? 0;
            파싱실패 += (res.requested ?? 0) - (res.parsed ?? res.requested ?? 0);
          }
          행합 += rows.length;
          저장합 += 저장;

          /* 수집한 것보다 적게 저장됐으면 **왜** 줄었는지 반드시 드러낸다. 그냥 "저장 45건"만
             찍히면 7건이 사라진 걸 아무도 모른다(실측: 그래서 스크랩 경합을 늦게 발견했다). */
          const 손실 = [
            파싱실패 ? `날짜 파싱 실패 ${파싱실패}건` : '',
            중복 ? `res_key 중복 ${중복}건` : '',
          ]
            .filter(Boolean)
            .join(' · ');

          console.log(
            `[backfill] ${site.label} ${date}: 수업 ${수업수}개 · 예약 ${rows.length}건` +
              (대기 ? ` (대기 ${대기})` : '') +
              (dryRun ? ' (dry-run)' : ` → 저장 ${저장}건`) +
              (손실 ? `  ⚠️ ${손실}` : ''),
          );
          if (누락) {
            // 조용히 넘기면 그 수업 예약자가 통째로 빠진 채 "관측했다"고 기록된다
            throw new Error(`수업 ${수업수}개 중 ${누락}개를 못 열었습니다`);
          }

          /* ⚠️ dry-run 은 진행 파일에 남기지 않는다. 남기면 "저장은 안 했는데 완료"로
             기록돼 뒤이은 실제 실행이 그 날짜를 통째로 건너뛴다. */
          if (!dryRun) {
            done.add(mark);
            await saveProgress(done);
          }
        } catch (err) {
          failures.push({ site: site.label, date, error: String(err.message ?? err) });
          console.error(`[error] ${site.label} ${date}: ${err.message}`);
          /* 그 날짜만 실패로 두고 계속 간다. done 에 넣지 않으므로 재실행 때 다시 시도한다.
             다음 날짜로 넘어가기 전에 캘린더 상태가 깨졌을 수 있으니 다시 이동시킨다. */
          첫날 = true;
        }
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  console.log(
    `\n=== 백필 완료 · 예약 ${행합}건 수집` +
      (dryRun ? ' (dry-run · 저장 안 함)' : ` · 저장 ${저장합}건`) +
      ` · 실패 ${failures.length}건 ===`,
  );
  if (failures.length) {
    for (const f of failures.slice(0, 20)) console.error(`  · ${f.site} ${f.date}: ${f.error}`);
    console.error(
      `\n실패한 (사이트,날짜)는 진행 파일에 기록되지 않았습니다 — 그대로 다시 실행하면 그것만 재시도합니다.`,
    );
    process.exitCode = 1;
  } else if (!dryRun) {
    console.log(
      `\n다음 확인: crm_history_depth.관측일수 가 ${dates.length}일 이상인지 보세요.\n` +
        `  npm run db:sql sql/2026-08_verify_crm.sql`,
    );
  }
}

main().catch((err) => {
  console.error('백필 실패:', err);
  process.exitCode = 1;
});
