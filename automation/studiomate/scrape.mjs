// ============================================================================
// 스튜디오메이트 스크래핑 — 흐름만 담당한다 (셀렉터는 selectors.mjs 에만 있다)
// ----------------------------------------------------------------------------
// 실제 화면 흐름 (2026-08-10 확인):
//   /schedule (일간·룸별)  →  .event-item 클릭  →  /lecture/detail?id=…  →  뒤로
//
// ⚠️ 날짜는 URL 쿼리(?date=)로 못 바꾼다 — 무시된다. 좌/우 화살표로만 이동한다.
//    그래서 gotoDate() 가 현재 날짜를 읽어 목표까지 한 칸씩 이동하고 매번 검증한다.
//
// ⚠️ 수업 상세 한 페이지에 이름·연락처·수강권명·잔여횟수·수강권기간·예약상태가 전부 있다.
//    회원 상세 모달에 따로 들어가지 않는다(클릭 수가 수백 회 줄어든다).
//    전체횟수만 화면에 없어서 빈 값으로 두고, apply_attendance v2 가 DB 값을 유지한다.
// ============================================================================
import { SELECTORS, TIMING, URLS, selectorsReady } from './selectors.mjs';
import {
  normDate,
  normText,
  parseLectureDateTime,
  parseMemberLine,
  parseTicketLine,
  toReservationRecord,
} from './normalize.mjs';
import { daysBetween } from '../../shared/crm-core.mjs';

/* 스크랩이 채워야 하는 필드 — 전 행이 비어 있으면 "셀렉터 미설정"으로 경고한다. */
const WANTED = ['수업시간', '수업명', '이름', '연락처', '수강권명', '예약상태', '잔여횟수'];

async function text(scope, sel) {
  if (!sel) return '';
  if (typeof sel === 'function') return normText(await sel(scope));
  const loc = scope.locator(sel).first();
  if ((await loc.count()) === 0) return '';
  return normText(await loc.textContent());
}

/* ----------------------------------------------------------------------
   로그인
   ⚠️ 스튜디오메이트는 **이메일이 아니라 휴대폰 번호**로 로그인한다.
   ⚠️ 로그인 후에도 비밀번호 입력칸이 남아 있으면 실패로 본다 — 로그인 실패를
      "예약자 0명"으로 오해하면 아무 일도 안 일어난 채 초록불만 남는다.
   ---------------------------------------------------------------------- */
export async function loginStudioMate(page, { phone, password, slug, retries = 2 }) {
  await installOverlayGuard(page);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await attemptLogin(page, { phone, password, slug });
      return;
    } catch (err) {
      lastErr = err;
      // 자격증명이 실제로 틀렸으면(화면이 그렇게 말하면) 재시도해도 소용없다
      if (/일치하지|잠긴|차단/.test(err.message)) throw err;
      if (attempt < retries) await page.waitForTimeout(3000 * (attempt + 1));
    }
  }
  throw lastErr;
}

async function attemptLogin(page, { phone, password, slug }) {
  await page.goto(URLS.login(slug), {
    waitUntil: 'domcontentloaded',
    timeout: TIMING.navTimeout,
  });

  // 이미 로그인돼 있으면(앱이 곧장 /schedule 로 보낸다) 다시 하지 않는다
  const already = await page
    .locator(SELECTORS.login.success)
    .first()
    .waitFor({ timeout: 3000 })
    .then(() => true)
    .catch(() => false);
  if (already) return;

  await page
    .locator(SELECTORS.login.phone)
    .first()
    .waitFor({ timeout: TIMING.waitTimeout });
  // 셀렉터가 콤마로 묶여 있어 여러 개가 매칭될 수 있다 → strict 모드를 피하려 .first() 를 쓴다
  await page.locator(SELECTORS.login.phone).first().fill(phone, { timeout: TIMING.waitTimeout });
  await page
    .locator(SELECTORS.login.password)
    .first()
    .fill(password, { timeout: TIMING.waitTimeout });
  await page.locator(SELECTORS.login.submit).first().click({ timeout: TIMING.waitTimeout });

  /* 로그인 성공하면 앱이 스스로 /schedule 로 옮겨 간다. 그 전에 다른 곳으로 goto 하면
     리다이렉트가 끊겨 로그인이 안 붙는다 → URL 이 /login 을 벗어날 때까지 기다린다. */
  await page
    .waitForURL((u) => !/\/login/.test(String(u)), { timeout: TIMING.waitTimeout })
    .catch(() => {});
  /* 성공 표식(상단 메뉴)이 뜨는지로 판정한다.
     "비밀번호 칸이 사라졌는가" 같은 소극적 판정은 오탐이 난다(숨은 input 등). */
  const ok = await page
    .locator(SELECTORS.login.success)
    .first()
    .waitFor({ timeout: TIMING.waitTimeout })
    .then(() => true)
    .catch(() => false);

  if (!ok) {
    // 화면에 뜬 안내 문구를 그대로 물고 온다 — "비밀번호 불일치"인지 "잠김"인지 구분해야 한다
    const msg = await page
      .evaluate(() => {
        const t = [...document.querySelectorAll('p, span, div')]
          .map((e) => (e.textContent || '').trim())
          .find((s) => s && s.length < 100 && /(일치하지|실패|잠긴|차단|초과|오류)/.test(s));
        return t || '';
      })
      .catch(() => '');
    throw new Error(
      `[${slug}] 스튜디오메이트 로그인 실패 (URL: ${page.url()})` +
        (msg ? ` — 화면 안내: "${msg}"` : ' — 휴대폰 번호/비밀번호 또는 login 셀렉터를 확인하세요.'),
    );
  }
  await page.waitForLoadState('networkidle', { timeout: TIMING.waitTimeout }).catch(() => {});
}

/* ----------------------------------------------------------------------
   날짜 이동 — 화살표를 한 칸씩 누르며 매번 검증한다.
   ---------------------------------------------------------------------- */
/* ⚠️ 요소가 있다고 값이 있는 건 아니다. SPA 가 날짜를 채우기 전에 읽으면 빈 문자열이 온다
   (첫 진입에서 실제로 겪었다). 값이 생길 때까지 짧게 폴링한다. */
async function currentDate(page) {
  const loc = page.locator(SELECTORS.calendar.dateInput).first();
  await loc.waitFor({ timeout: TIMING.waitTimeout });
  const deadline = Date.now() + TIMING.waitTimeout;
  for (;;) {
    const v = normDate(await loc.inputValue().catch(() => ''));
    if (v) return v;
    if (Date.now() > deadline) return '';
    await page.waitForTimeout(200);
  }
}

/* 공지/배너 다이얼로그 무력화.
   ⚠️ 이 오버레이는 **페이지를 옮길 때마다 다시 뜬다.** 닫기 버튼을 누르는 것만으로는
      부족해서(실측: 뒤로 간 뒤 다시 떠서 화살표 클릭이 30초간 막혔다) CSS 로 아예 없앤다.
      addInitScript 는 이후 모든 네비게이션에 자동 적용되므로 한 번만 걸면 된다.
      우리는 어떤 다이얼로그도 쓰지 않으므로 전부 숨겨도 안전하다. */
const _guarded = new WeakSet();
async function installOverlayGuard(page) {
  if (_guarded.has(page)) return;
  _guarded.add(page);
  await page.addInitScript(() => {
    const css = '.el-dialog__wrapper,.v-modal,.el-loading-mask{display:none !important;}';
    const add = () => {
      const s = document.createElement('style');
      s.textContent = css;
      (document.head || document.documentElement).appendChild(s);
    };
    if (document.head) add();
    else document.addEventListener('DOMContentLoaded', add, { once: true });
  });
}

/** 이미 떠 있는 다이얼로그를 닫는다(가드를 걸기 전에 뜬 것 대비). */
async function dismissDialogs(page) {
  for (let i = 0; i < 5; i++) {
    const dlg = page.locator(SELECTORS.dialogs.any).first();
    if (!(await dlg.count())) return;
    const btn = dlg.locator(SELECTORS.dialogs.close).first();
    if (await btn.count()) await btn.click({ timeout: 3000 }).catch(() => {});
    else await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(400);
  }
}

/* 일간 뷰로 고정한다.
   ⚠️ 지점마다 선택지가 다르다 — 룸이 여러 개인 곳만 '일간(룸별)'이 있고, 광교처럼 룸이
      하나면 '일간(강사별)'뿐이다. 그리고 새 세션의 기본 뷰는 **주간**이라
      (뷰 설정이 localStorage 에만 저장된다) 그대로 두면 날짜 값이 '2026w33' 처럼 나온다. */
async function ensureDayView(page) {
  for (const v of SELECTORS.calendar.dayViewValues) {
    const radio = page.locator(SELECTORS.calendar.dayViewRadio(v)).first();
    if (!(await radio.count())) continue;
    if (!(await radio.isChecked())) {
      await page.locator(SELECTORS.calendar.dayViewLabel(v)).first().click();
      await page.waitForTimeout(TIMING.daySettle);
    }
    return v;
  }
  throw new Error(
    '일간 뷰를 찾지 못했습니다(월간/주간만 있음). selectors.mjs 의 dayViewValues 를 확인하세요.',
  );
}

async function gotoDate(page, target) {
  // 캘린더 컨트롤이 그려질 때까지 기다린다(로그인 직후엔 아직 없다)
  await page
    .locator(SELECTORS.calendar.prevDay)
    .first()
    .waitFor({ timeout: TIMING.waitTimeout });

  await dismissDialogs(page); // 공지 팝업이 클릭을 가로채기 전에 치운다
  await ensureDayView(page);

  let cur = await currentDate(page);
  if (!cur) {
    throw new Error(
      '캘린더의 현재 날짜를 읽지 못했습니다 — 로그인이 풀렸거나 화면이 안 그려졌습니다 ' +
        `(URL: ${page.url()})`,
    );
  }
  for (let guard = 0; cur !== target && guard < 60; guard++) {
    const diff = daysBetween(cur, target);
    if (diff === null) throw new Error(`날짜를 읽지 못했습니다 (현재="${cur}", 목표="${target}")`);
    await page
      .locator(diff > 0 ? SELECTORS.calendar.nextDay : SELECTORS.calendar.prevDay)
      .first()
      .click({ timeout: TIMING.waitTimeout });
    await page.waitForTimeout(TIMING.daySettle);
    const next = await currentDate(page);
    if (next === cur) {
      throw new Error(`날짜 이동이 동작하지 않습니다 (${cur} 에서 멈춤). 화살표 셀렉터 확인.`);
    }
    cur = next;
  }
  if (cur !== target) throw new Error(`목표 날짜에 도달하지 못했습니다 (${cur} ≠ ${target})`);
}

/* ----------------------------------------------------------------------
   수업 상세 한 건 읽기
   ---------------------------------------------------------------------- */
async function readLecture(page, fallbackDate) {
  await page.locator(SELECTORS.detail.ready).first().waitFor({ timeout: TIMING.waitTimeout });
  await page.waitForTimeout(TIMING.detailSettle);

  const 수업명 = await text(page, SELECTORS.detail.수업명);
  const 강사 = await text(page, SELECTORS.detail.강사);
  const { 예약일자, 수업시간 } = parseLectureDateTime(await text(page, SELECTORS.detail.일시));

  /* ⚠️ 목록이 다 그려지기 전에 세면 실행마다 인원이 달라진다(실측: 같은 날이 78/96/88).
     화면의 "예약회원 (N명)" 이 정답이므로 그 수에 도달할 때까지 기다린다. */
  const rows = page.locator(SELECTORS.bookings.list);
  const labelText = await text(page, SELECTORS.bookings.countLabel);
  const expected = Number((labelText.match(/\((\d+)\s*명/) || [])[1] ?? NaN);

  let n = await rows.count();
  if (Number.isFinite(expected)) {
    const deadline = Date.now() + TIMING.waitTimeout;
    while (n < expected && Date.now() < deadline) {
      await page.waitForTimeout(200);
      n = await rows.count();
    }
    if (n !== expected) {
      throw new Error(
        `예약자 목록이 안 맞습니다 — 화면은 ${expected}명인데 ${n}명만 읽혔습니다 ` +
          `(${수업명} ${수업시간}). 조용히 넘기면 그만큼 CRM 에서 빠집니다.`,
      );
    }
  }

  const out = [];
  for (let i = 0; i < n; i++) {
    const row = rows.nth(i);
    const { 이름, 연락처 } = parseMemberLine(await text(row, SELECTORS.booking.회원));
    if (!이름) continue;
    const ticket = parseTicketLine(await text(row, SELECTORS.booking.수강권));
    out.push({
      예약일자: 예약일자 || fallbackDate,
      수업시간,
      수업명,
      강사,
      이름,
      연락처,
      예약상태: await text(row, SELECTORS.booking.예약상태),
      ...ticket,
    });
  }
  return out;
}

/* ----------------------------------------------------------------------
   한 사이트의 하루치 예약자 수집
   site: { slug, defaultBranch }  ← everybarre 는 청담·판교 두 지점이 섞여 있어
         지점은 수강권명에서 뽑고(branchOf), 태그가 없을 때만 defaultBranch 로 폴백한다.
   반환: { rows, 수업수, missing }
     · 수업수 0 은 정상일 수 있다(휴무일). 수업은 있는데 예약자가 0명이면 셀렉터를 의심.
   실패는 삼키지 않고 throw 한다.
   ---------------------------------------------------------------------- */
export async function scrapeBranch(page, site, { date }) {
  if (!site.slug) throw new Error(`[${site.label ?? site.slug}] slug 미설정`);
  if (!selectorsReady()) {
    throw new Error(
      'automation/studiomate/selectors.mjs 의 셀렉터가 비어 있습니다. MOCK_FILE 로 먼저 검증하세요.',
    );
  }

  await page.goto(URLS.schedule(site.slug), {
    waitUntil: 'domcontentloaded',
    timeout: TIMING.navTimeout,
  });
  await gotoDate(page, date);

  /* ⚠️ 날짜 input 은 즉시 바뀌지만 수업 블록은 API 응답 뒤에 그려진다.
     바로 세면 0 이 나오고, 0 은 "휴무일"로 취급돼 **조용히 넘어간다**
     (실측: 실제 12개인 날을 0개로 읽었다). 잠깐 더 기다렸다 다시 센다. */
  const items = page.locator(SELECTORS.calendar.classItem);
  await page.waitForLoadState('networkidle', { timeout: TIMING.waitTimeout }).catch(() => {});
  let 수업수 = await items.count();
  for (let i = 0; 수업수 === 0 && i < 4; i++) {
    await page.waitForTimeout(TIMING.emptySettle);
    수업수 = await items.count();
  }
  const rows = [];

  /* ⚠️ 수업 블록에는 안정적인 id/href 가 없어 nth(i) 로 도는데, **뒤로 가면 DOM 순서가
     바뀔 수 있다.** 실측에서 같은 수업을 두 번 긁고 어떤 건 빠뜨려, 같은 날짜를 두 번
     돌렸더니 예약자 수가 78 → 96 으로 달라졌다.
     → 상세 URL 의 lecture id 로 중복을 제거하고, 못 본 수업이 남으면 한 번 더 훑는다. */
  const seen = new Set();
  for (let pass = 0; pass < 2 && seen.size < 수업수; pass++) {
    const n = await items.count();
    for (let i = 0; i < n; i++) {
      await items.nth(i).click({ timeout: TIMING.waitTimeout });
      await page.waitForURL(/\/lecture\/detail/, { timeout: TIMING.waitTimeout });

      const id = new URL(page.url()).searchParams.get('id') || `#${pass}-${i}`;
      if (!seen.has(id)) {
        seen.add(id);
        for (const raw of await readLecture(page, date)) {
          rows.push(toReservationRecord(raw, { branch: site.defaultBranch, date }));
        }
      }

      await page.goBack({ waitUntil: 'domcontentloaded', timeout: TIMING.navTimeout });
      await page
        .locator(SELECTORS.calendar.classItem)
        .first()
        .waitFor({ timeout: TIMING.waitTimeout })
        .catch(() => {});
      /* 이 SPA 는 ?date= 를 무시하므로 뒤로 가면 캘린더가 오늘로 되돌아갈 수 있다. */
      if ((await currentDate(page)) !== date) await gotoDate(page, date);
      if (seen.size >= 수업수) break;
    }
  }

  const missing = rows.length ? WANTED.filter((f) => rows.every((r) => !r[f])) : [];
  // 못 본 수업이 있으면 조용히 넘기지 않는다
  const 누락 = 수업수 - seen.size;
  return { rows, 수업수, 누락: 누락 > 0 ? 누락 : 0, missing };
}
