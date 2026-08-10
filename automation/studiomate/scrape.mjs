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
export async function loginStudioMate(page, { phone, password, slug }) {
  await page.goto(URLS.login(slug), {
    waitUntil: 'domcontentloaded',
    timeout: TIMING.navTimeout,
  });
  await page.fill(SELECTORS.login.phone, phone, { timeout: TIMING.waitTimeout });
  await page.fill(SELECTORS.login.password, password, { timeout: TIMING.waitTimeout });
  await page.click(SELECTORS.login.submit, { timeout: TIMING.waitTimeout });

  if (SELECTORS.login.success) {
    await page
      .locator(SELECTORS.login.success)
      .first()
      .waitFor({ timeout: TIMING.waitTimeout })
      .catch(() => {});
  }
  await page.waitForLoadState('networkidle', { timeout: TIMING.waitTimeout }).catch(() => {});

  if (await page.locator(SELECTORS.login.password).count()) {
    throw new Error(
      `[${slug}] 스튜디오메이트 로그인 실패 — 휴대폰 번호/비밀번호 또는 login 셀렉터를 확인하세요.`,
    );
  }
}

/* ----------------------------------------------------------------------
   날짜 이동 — 화살표를 한 칸씩 누르며 매번 검증한다.
   ---------------------------------------------------------------------- */
async function currentDate(page) {
  const loc = page.locator(SELECTORS.calendar.dateInput).first();
  await loc.waitFor({ timeout: TIMING.waitTimeout });
  return normDate(await loc.inputValue());
}

async function gotoDate(page, target) {
  // 일간(룸별) 뷰가 아니면 .event-item 배치가 달라진다 → 먼저 고정
  const radio = page.locator(SELECTORS.calendar.dayRoomViewRadio).first();
  if ((await radio.count()) && !(await radio.isChecked())) {
    await page.locator(SELECTORS.calendar.dayRoomViewLabel).first().click();
    await page.waitForTimeout(TIMING.daySettle);
  }

  let cur = await currentDate(page);
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

  const rows = page.locator(SELECTORS.bookings.list);
  const n = await rows.count();
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

  const items = page.locator(SELECTORS.calendar.classItem);
  const 수업수 = await items.count();
  const rows = [];

  for (let i = 0; i < 수업수; i++) {
    await items.nth(i).click({ timeout: TIMING.waitTimeout });
    await page.waitForURL(/\/lecture\/detail/, { timeout: TIMING.waitTimeout });

    const raws = await readLecture(page, date);
    for (const raw of raws) {
      rows.push(toReservationRecord(raw, { branch: site.defaultBranch, date }));
    }

    await page.goBack({ waitUntil: 'domcontentloaded', timeout: TIMING.navTimeout });
    await page.locator(SELECTORS.calendar.classItem).first().waitFor({ timeout: TIMING.waitTimeout });
    /* ⚠️ 이 SPA 는 ?date= 를 무시하므로, 뒤로 가면 캘린더가 오늘로 되돌아갈 수 있다.
       매번 확인해서 어긋나면 다시 이동한다(대개 한두 칸이라 싸다). */
    if ((await currentDate(page)) !== date) await gotoDate(page, date);
  }

  const missing = rows.length ? WANTED.filter((f) => rows.every((r) => !r[f])) : [];
  return { rows, 수업수, missing };
}
