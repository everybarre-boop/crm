// ============================================================================
// 일간 CRM 자동화 오케스트레이터 — 매일 21:00 KST 1회 실행
// ----------------------------------------------------------------------------
// 한 번의 실행이 다음을 순서대로 한다:
//   1 scrape D-1 (attendance)  어제 수업의 출석/결석 확정 + 수강권 전체/잔여
//   2 applyAttendance          → members 갱신 (used_count 는 생성 컬럼이라 자동 재계산)
//   3 saveReservations D-1     → 예약 스냅샷의 상태를 '예약' → '출석/결석'으로 확정
//   4 scrape D+1 (roster)      내일 예약자 명단 (목록만. 상세 모달 진입 X)
//   5 saveReservations D+1
//   5.5 attcount               내일 예약자의 **실제 출석 수**를 회원 페이지에서 읽어 저장
//                              (회차·마일스톤의 근거. `전체횟수 − 잔여횟수`를 대체한다)
//   6 buildCrm                 규칙 평가 → crm_messages + crm_dormant
//   7 postSlack                지점별 채널에 통합 메시지 1건
//   8 summary                  실패 집계 → 운영 채널 알림 → exit code
//
// ⚠️ 순서가 중요하다. 2단계(어제 출석 반영)가 6단계(마일스톤 누적 횟수)의 입력이다.
//
// 실행 예:
//   # 파이프라인만 검증 (스튜디오메이트 없이)
//   MOCK_FILE=automation/mock.local.json MOCK_DATE=2026-08-05 DRY_RUN=true node automation/run.mjs
//   # 특정 지점·단계만
//   ONLY_BRANCHES=광교 STEPS=roster DRY_RUN=true node automation/run.mjs
//   # 실제 반영
//   DRY_RUN=false node automation/run.mjs
// ============================================================================
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { BRANCHES, SITES, env, preflight, siteOfBranch } from './config.mjs';
import { applyAttendance } from './apply.mjs';
import { fetchAttendanceFresh, saveAttendance, saveReservations } from './db.mjs';
import { buildAndSaveCrm, postCrmToSlack } from './crm.mjs';
import { notifyOps } from './slack.mjs';
import { branchOf, dateKST, personKey } from '../shared/crm-core.mjs';
import { toAttendanceRecords, toReservationRecord } from './studiomate/normalize.mjs';

const OUT_DIR = 'automation/out';
const NOTIFIED_MARKER = `${OUT_DIR}/.notified`;

/** 실행 기준 "오늘"(KST). MOCK_DATE 로 고정할 수 있다 — 날짜 의존 규칙 재현에 필수. */
function todayKST() {
  return env.MOCK_DATE || dateKST(0);
}

const failures = [];
function fail(step, branch, error) {
  failures.push({ step, branch, error: String(error?.message ?? error) });
  console.error(`[error] ${step}${branch ? ` · ${branch}` : ''}: ${error?.message ?? error}`);
}

/* ==========================================================================
   수집 — MOCK 또는 실제 스크랩
   ========================================================================== */
let _mock = null;
async function loadMock() {
  if (_mock) return _mock;
  _mock = JSON.parse(await readFile(env.MOCK_FILE, 'utf8'));
  return _mock;
}

/** MOCK 에서 (mode, date) 에 해당하는 행을 꺼낸다. 최상위가 배열이면 옛 형식. */
async function mockRows(mode, date) {
  const mock = await loadMock();
  if (Array.isArray(mock)) {
    // 옛 형식: attendance 전용 축약 레코드. 지점/날짜를 보강해 준다.
    if (mode !== 'attendance') return [];
    return mock.map((r) =>
      toReservationRecord(
        { ...r, 예약일자: date, 예약상태: '출석' },
        { branch: branchOf(r.수강권명) || '(미지정)', date },
      ),
    );
  }
  const rows = (mock[mode] || {})[date] || [];
  return rows.map((r) =>
    toReservationRecord(r, { branch: r.지점 || branchOf(r.수강권명) || '(미지정)', date }),
  );
}

/* 사이트 하나를 처음부터 다시 도는 횟수. 한 번이면 충분하다 — 지금까지의 실패는 전부
   간헐적인 타임아웃이었고, 전 사이트 재시도는 러너 시간(timeout-minutes)을 그만큼 먹는다. */
const SITE_RETRIES = 1;

let _browser = null;
let _page = null;
const _loggedIn = new Set();

async function getPage() {
  if (_page) return _page;
  const { chromium } = await import('playwright');
  _browser = await chromium.launch({ headless: env.HEADLESS });
  const ctx = await _browser.newContext();
  _page = await ctx.newPage();
  return _page;
}

/* 사이트(서브도메인)마다 세션이 따로다 — 쿠키가 공유되지 않으므로 각각 로그인한다.
   실행당 사이트별 1회만. */
async function ensureLogin(page, slug) {
  if (_loggedIn.has(slug)) return;
  const { loginStudioMate } = await import('./studiomate.mjs');
  await loginStudioMate(page, {
    phone: env.STUDIOMATE_PHONE,
    password: env.STUDIOMATE_PASSWORD,
    slug,
  });
  _loggedIn.add(slug);
}

async function closeBrowser() {
  if (_browser) await _browser.close().catch(() => {});
  _browser = null;
  _page = null;
}

/**
 * 한 모드(attendance|roster)로 전 지점을 수집한다.
 * 반환: Map<지점명, rows[]>
 * ⚠️ 전 지점이 실패하면 그냥 넘어가지 않고 던진다 — 로그인 실패/DOM 변경을 "예약자 0명"으로
 *    오해하면 아무 일도 안 일어난 채 초록불만 남는다(예전 run.mjs 의 실제 문제).
 */
async function collect(mode, date) {
  const byBranch = new Map();

  if (env.MOCK_FILE) {
    const rows = await mockRows(mode, date);
    for (const r of rows) {
      const b = r.지점 || '(미지정)';
      if (env.ONLY_BRANCHES.length && !env.ONLY_BRANCHES.includes(b)) continue;
      if (!byBranch.has(b)) byBranch.set(b, []);
      byBranch.get(b).push(r);
    }
    console.log(`[mock] ${mode} ${date}: ${rows.length}건`);
    return byBranch;
  }

  const { scrapeBranch } = await import('./studiomate.mjs');
  const page = await getPage();
  let okCount = 0;

  /* ⚠️ 스크랩 단위는 "지점"이 아니라 "사이트"다 — 청담·판교가 everybarre 한 곳을 같이 쓴다.
     지점은 각 예약행의 수강권명에서 뽑히므로(branchOf), 여기서는 반환된 rows 를 지점별로 나눈다. */
  for (const site of SITES) {
    /* 🔥 사이트 하나가 통째로 실패하면 그 지점의 하루치가 사라진다 — 청담·판교는 예약자의 절반이다.
       2026-09-03~05 에 5번 그랬다(수업 상세 클릭이 40초 타임아웃). 스크랩은 읽기 전용이고
       저장은 이 루프 밖에서 하므로(rows 는 메모리에만 쌓인다) 처음부터 다시 도는 것은 안전하다.
       ⚠️ 마지막 시도까지 실패해야 fail() 이다 — 재시도가 실패를 감추지 않게 한다. */
    let siteErr = null;
    for (let attempt = 0; attempt <= SITE_RETRIES; attempt++) {
      try {
        await ensureLogin(page, site.slug);
        const { rows, 수업수, 누락, 대기, missing, 재확인 } = await scrapeBranch(page, site, { date, mode });
        for (const r of rows) {
          const b = r.지점 || '(미지정)';
          if (env.ONLY_BRANCHES.length && !env.ONLY_BRANCHES.includes(b)) continue;
          if (!byBranch.has(b)) byBranch.set(b, []);
          byBranch.get(b).push(r);
        }
        okCount++;
        const perBranch = [...new Set(rows.map((r) => r.지점 || '(미지정)'))].join('/') || '-';
        console.log(
          `[scrape:${mode}] ${site.label} ${date}: 수업 ${수업수}개 · 예약자 ${rows.length}명 (${perBranch})` +
            // 대기자는 rows 에 포함돼 있고 CRM 대상에서만 빠진다 — 몇 명이 빠지는지 보여야 한다
            (대기 ? ` · 그중 예약대기 ${대기}명(CRM 제외)` : '') +
            (수업수 > 0 && rows.length === 0 ? '  ⚠️ 수업은 있는데 예약자 0명 — 셀렉터 의심' : '') +
            /* "0개"가 한 번 읽고 내린 판정인지, 재시도(날짜 흔들기·재로드)까지 해 본 판정인지
               구분한다. 2026-08-13 러너에서 3개 사이트가 0개로 나갔는데 로그는 정상이었다.
               어느 전략이 먹혔는지는 scrape.mjs 가 따로 경고로 찍는다. */
            (재확인 && 수업수 === 0 ? '  (재시도 후에도 0개 — 휴무일로 봅니다)' : ''),
        );
        if (누락) {
          // 조용히 지나가면 그 수업 예약자가 통째로 빠진 채 CRM 이 나간다
          fail(`scrape:${mode}`, site.label, new Error(`수업 ${수업수}개 중 ${누락}개를 못 열었습니다`));
        }
        if (missing.length) {
          console.warn(`  ⚠️ ${site.label}: 못 읽은 필드 ${missing.join(', ')} (selectors.mjs 확인)`);
        }
        siteErr = null;
        break;
      } catch (err) {
        siteErr = err;
        if (attempt < SITE_RETRIES) {
          console.warn(
            `  ⚠️ [${site.label}] ${mode} ${date}: 스크랩이 실패해 사이트를 처음부터 다시 시도합니다 ` +
              `(${attempt + 1}/${SITE_RETRIES}) · ${String(err?.message ?? err).split('\n')[0].slice(0, 200)}`,
          );
          /* 세션이 끊겨서 실패한 것일 수도 있다 — 다음 시도는 로그인부터 다시 한다. */
          _loggedIn.delete(site.slug);
          await page.waitForTimeout(5000);
        }
      }
    }
    if (siteErr) fail(`scrape:${mode}`, site.label, siteErr);
  }

  if (SITES.length && okCount === 0) {
    throw new Error(
      `전 사이트(${SITES.length}곳) 스크랩이 실패했습니다 — 로그인 또는 화면 구조 문제로 보입니다.`,
    );
  }
  return byBranch;
}

/* ==========================================================================
   단계들
   ========================================================================== */
async function stepAttendance(yesterday, dryRun) {
  const byBranch = await collect('attendance', yesterday);
  const summaries = [];

  for (const [branch, rows] of byBranch) {
    if (!rows.length) continue;
    try {
      const records = toAttendanceRecords(rows);
      if (records.length) {
        const res = await applyAttendance(records, { dryRun, branch, targetDate: yesterday });
        summaries.push(res);
        console.log(
          `[apply] ${branch}: 요청 ${res.requested} / 매칭 ${res.matched}` +
            ` / 미매칭 ${res.unmatched_count}` +
            (res.dry_run ? ' (dry-run)' : ` / 갱신 ${res.updated ?? '?'}행`),
        );
        if (res.unmatched_count > 0) {
          console.warn(`  ⚠️ ${branch} 미매칭 ${res.unmatched_count}건 — DB 에서 이름/연락처/수강권명이 안 맞음`);
          for (const u of (res.unmatched || []).slice(0, 10)) {
            console.warn(`     · ${u.이름} / ${u.수강권명} / ${u.연락처}`);
          }
        }
      } else {
        console.log(`[apply] ${branch}: 전체/잔여를 읽은 행이 없어 건너뜀 (상세 셀렉터 확인)`);
      }
      await saveReservations(rows, { branch, targetDate: yesterday, dryRun });
    } catch (err) {
      fail('attendance', branch, err);
    }
  }
  return summaries;
}

async function stepRoster(tomorrow, dryRun) {
  const byBranch = await collect('roster', tomorrow);
  const all = [];

  for (const [branch, rows] of byBranch) {
    all.push(...rows);
    if (!rows.length) continue;
    try {
      const res = await saveReservations(rows, { branch, targetDate: tomorrow, dryRun });
      const 손실 = [
        res.requested - (res.parsed ?? res.usable) > 0
          ? `날짜 파싱 실패 ${res.requested - res.parsed}건`
          : '',
        res.duplicates ? `중복 ${res.duplicates}건` : '',
      ]
        .filter(Boolean)
        .join(' · ');
      console.log(
        `[resv] ${branch}: ${res.requested}건 → ${res.usable}건` +
          (손실 ? ` (${손실})` : '') +
          (res.dry_run ? ' (dry-run)' : ` / 저장 ${res.saved}건`),
      );
    } catch (err) {
      fail('roster', branch, err);
    }
  }
  return all;
}

/* ==========================================================================
   출석 수 읽기 — 내일 예약자 각각의 회원 페이지에서 `출석(N)` 을 가져온다
   --------------------------------------------------------------------------
   🔥 왜 매일 다시 읽나 — 회원당 ~1.6초라 120명이 3분 남짓이다. 그 값이면 "기준선을 한 번
      찍고 이후는 예약으로 더한다" 는 방식의 드리프트(스크랩 빠진 날·기준일 당일 저녁 수업·
      기준선 노후)를 통째로 없애는 편이 낫다. 저장은 폴백·검증용으로만 남긴다.

   ⚠️ 대상은 **내일 예약자**뿐이다. 전 회원(5,000명)을 읽으면 몇 시간이 걸린다.
   ⚠️ 사이트별로 읽는다 — 회원 id 가 사이트마다 다르고, 출석 수도 사이트별이다.
   ⚠️ 재실행(22:30 예비)에서는 오늘 이미 읽은 (사이트,회원id) 를 건너뛴다.
   ========================================================================== */
async function stepAttendanceCount(rosterRows, today, dryRun) {
  if (env.MOCK_FILE) {
    console.log('[attcount] MOCK 실행 — 건너뜁니다(회원 페이지를 열지 않습니다)');
    return { read: 0, failed: 0 };
  }

  /* 사이트별 대상 — 같은 사람이 내일 여러 수업이어도 한 번만 읽는다.
     예약대기·취소도 포함해서 읽는다: 회차를 아는 건 해롭지 않고, 다음날 대상이 될 수 있다. */
  const bySite = new Map();
  let noId = 0;
  for (const r of rosterRows) {
    const id = String(r.회원id ?? '').trim();
    if (!id) { noId++; continue; }
    const site = siteOfBranch(r.지점);
    if (!site) { noId++; continue; }
    if (!bySite.has(site)) bySite.set(site, new Map());
    bySite.get(site).set(id, { 회원id: id, 이름: r.이름 || '', person_key: personKey(r) });
  }
  if (noId) {
    console.warn(
      `  ⚠️ 회원 id 를 못 얻은 예약 ${noId}건 — 그 회원은 마일스톤 회차를 확정할 수 없습니다 ` +
        `(selectors.mjs 의 MEMBER_ID_VUE_PATH 확인).`,
    );
  }

  const 이미 = dryRun ? new Set() : await fetchAttendanceFresh(today);
  const { scrapeMembers } = await import('./studiomate.mjs');
  const page = await getPage();
  let read = 0;
  let failed = 0;
  let 건너뜀 = 0;

  for (const [site, targets] of bySite) {
    const todo = [...targets.values()].filter((t) => !이미.has(`${site}\u0000${t.회원id}`));
    건너뜀 += targets.size - todo.length;
    if (!todo.length) {
      console.log(`[attcount] ${site}: ${targets.size}명 전부 오늘 이미 읽음 — 건너뜀`);
      continue;
    }
    try {
      await ensureLogin(page, site);
      const t0 = Date.now();
      const { rows, failures } = await scrapeMembers(page, site, todo);
      const saved = await saveAttendance(
        rows.map((r) => ({ ...r, 기준일: today, person_key: targets.get(r.회원id)?.person_key || '' })),
        { dryRun },
      );
      read += rows.length;
      failed += failures.length;
      console.log(
        `[attcount] ${site}: ${todo.length}명 중 ${rows.length}명 읽음` +
          (dryRun ? ' (dry-run · 저장 안 함)' : ` / 저장 ${saved}건`) +
          ` · ${((Date.now() - t0) / 1000).toFixed(0)}초` +
          (failures.length ? `  ⚠️ 실패 ${failures.length}명` : ''),
      );
      /* 🔐 실패 로그에는 실명이 섞인다 — 콘솔(러너 로그)에만 남기고 슬랙엔 건수만 나간다. */
      for (const f of failures.slice(0, 5)) console.warn(`     · ${f.이름}: ${f.error.slice(0, 120)}`);
    } catch (err) {
      fail('attcount', site, err);
    }
  }
  if (건너뜀) console.log(`[attcount] 오늘 이미 읽어 건너뛴 회원 ${건너뜀}명 (재실행 멱등)`);
  return { read, failed };
}

/* ==========================================================================
   main
   ========================================================================== */
async function main() {
  const warns = preflight();
  for (const w of warns) console.warn(`⚠️  ${w}`);

  const today = todayKST();
  const yesterday = dateKST(-1, env.MOCK_DATE ? new Date(`${env.MOCK_DATE}T12:00:00Z`) : new Date());
  const tomorrow =
    env.TARGET_DATE || dateKST(1, env.MOCK_DATE ? new Date(`${env.MOCK_DATE}T12:00:00Z`) : new Date());
  const steps = env.STEPS;
  const dryRun = env.DRY_RUN;

  console.log(
    `=== 일간 CRM 자동화 · 오늘 ${today} · 어제 ${yesterday} · 내일 ${tomorrow}\n` +
      `    dry_run=${dryRun} · slack_dry_run=${env.SLACK_DRY_RUN} · steps=${steps.join(',')}` +
      `${env.MOCK_FILE ? ` · MOCK=${env.MOCK_FILE}` : ''} ===`,
  );

  let rosterRows = [];
  let crm = null;
  let slackRes = null;

  try {
    if (steps.includes('attendance')) await stepAttendance(yesterday, dryRun);
    else console.log('[skip] attendance');

    if (steps.includes('roster')) rosterRows = await stepRoster(tomorrow, dryRun);
    else console.log('[skip] roster');

    /* ⚠️ roster 뒤·crm 앞이어야 한다 — roster 가 대상 명단을 만들고 crm 이 그 값을 쓴다.
       브라우저를 닫기 전에 끝내야 하므로 이 try 블록 안에 있다. */
    if (steps.includes('attcount')) await stepAttendanceCount(rosterRows, today, dryRun);
    else console.log('[skip] attcount');
  } finally {
    await closeBrowser();
  }

  if (steps.includes('crm')) {
    try {
      crm = await buildAndSaveCrm({ rosterRows, today, targetDate: tomorrow, dryRun });
    } catch (err) {
      fail('crm', null, err);
    }
  } else console.log('[skip] crm');

  if (steps.includes('slack') && crm) {
    try {
      // dry-run 저장을 안 했으면 id 가 없으므로 초안(draft)을 그대로 프리뷰한다
      const msgs = crm.saved.length ? crm.saved : crm.result.messages;
      slackRes = await postCrmToSlack({
        rules: crm.rules,
        messages: msgs,
        targetDate: tomorrow,
        dryRun: env.SLACK_DRY_RUN,
      });
      failures.push(...slackRes.failures);
    } catch (err) {
      fail('slack', null, err);
    }
  } else if (!steps.includes('slack')) console.log('[skip] slack');

  // 감사용 로컬 로그. ⚠️ 회원 실명이 들어가므로 커밋 금지(.gitignore)·artifact 업로드 금지.
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(
    `${OUT_DIR}/run-${today}.local.json`,
    JSON.stringify(
      { today, yesterday, tomorrow, dryRun, steps, stats: crm?.result?.stats ?? null, failures },
      null,
      2,
    ),
    'utf8',
  );

  console.log(
    `\n=== 완료 · 멘트 ${crm?.result?.messages.length ?? 0}건 · 휴면 ${crm?.result?.dormant.length ?? 0}명` +
      ` · 실패 ${failures.length}건 ===`,
  );

  if (failures.length) {
    const byStep = failures.reduce((m, f) => {
      const k = `${f.step}${f.branch ? `(${f.branch})` : ''}`;
      m[k] = (m[k] ?? 0) + 1;
      return m;
    }, {});
    // ⚠️ 운영 채널에는 건수와 단계만 보낸다 — 미매칭 로그에는 회원 실명이 섞인다.
    const text =
      `${failures.length}건 실패 · dry_run=${dryRun}\n` +
      Object.entries(byStep).map(([k, v]) => `· ${k}: ${v}건`).join('\n') +
      `\n첫 오류: ${String(failures[0].error).slice(0, 200)}`;
    const sent = await notifyOps(text, { level: 'error' });
    if (sent) await writeFile(NOTIFIED_MARKER, new Date().toISOString(), 'utf8').catch(() => {});
    // process.exit() 대신 exitCode — 남은 출력이 잘리지 않는다
    process.exitCode = 1;
  }
}

main().catch(async (err) => {
  console.error('실행 실패:', err);
  const sent = await notifyOps(`치명적 실패: ${String(err.message).slice(0, 300)}`, {
    level: 'error',
  }).catch(() => false);
  if (sent) {
    await mkdir(OUT_DIR, { recursive: true }).catch(() => {});
    await writeFile(NOTIFIED_MARKER, new Date().toISOString(), 'utf8').catch(() => {});
  }
  process.exitCode = 1;
});
