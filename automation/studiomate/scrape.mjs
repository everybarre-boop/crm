// ============================================================================
// 스튜디오메이트 스크래핑 — 흐름만 담당한다 (셀렉터를 하나도 모른다)
// ----------------------------------------------------------------------------
// 이 파일은 selectors.mjs 의 값을 **데이터로만** 다룬다(필드맵 순회). 화면 구조가 바뀌면
// selectors.mjs 만 고치면 되고 여기는 손대지 않는다.
//
// mode:
//   'roster'     내일(D+1) 예약자 명단. 목록만 읽는다 — 회원 상세를 열지 않아 빠르다.
//                (잔여/종료일은 members DB 가 더 정확하다. 같은 실행의 직전 단계에서
//                 D-1 출석을 반영했고, 주 1회 엑셀 재업로드로 교정까지 되기 때문.)
//   'attendance' 어제(D-1) 출석/결석 확정. 회원 상세(수강권 모달)까지 열어 전체/잔여를 읽는다.
// ============================================================================
import { SELECTORS, URLS, TIMING, selectorsReady } from './selectors.mjs';
import { normText, toReservationRecord } from './normalize.mjs';

/* 스크랩이 채워야 하는 필드 — 전 행이 비어 있으면 "셀렉터 미설정"으로 경고한다.
   (한 번에 다 채우지 않아도 파이프라인을 돌려볼 수 있게 하려는 장치) */
const WANTED = {
  roster: ['수업시간', '수업명', '이름', '수강권명'],
  attendance: ['수업시간', '수업명', '이름', '수강권명', '예약상태', '전체횟수', '잔여횟수'],
};

/** 셀렉터 값 하나를 읽는다. 문자열=CSS, 함수=커스텀, null=미설정('' 반환). */
async function readOne(scope, sel, page) {
  if (!sel) return '';
  if (typeof sel === 'function') return normText(await sel(scope, page));
  const loc = scope.locator(sel).first();
  if ((await loc.count()) === 0) return '';
  return normText(await loc.textContent());
}

/** 필드맵({필드명: 셀렉터})을 통째로 읽는다. */
async function readFields(scope, map, page) {
  const out = {};
  for (const [field, sel] of Object.entries(map || {})) {
    out[field] = await readOne(scope, sel, page);
  }
  return out;
}

/** 빈 값은 빼고 병합 — 목록에서 이미 읽은 값을 상세가 빈 값으로 덮어쓰지 않게. */
function mergeNonEmpty(base, extra) {
  for (const [k, v] of Object.entries(extra || {})) {
    if (v !== '' && v != null) base[k] = v;
  }
  return base;
}

async function closeOverlay(page, closeSel) {
  if (closeSel) {
    const loc = page.locator(closeSel).first();
    if (await loc.count()) {
      await loc.click().catch(() => {});
      await page.waitForTimeout(TIMING.modalSettle);
      return;
    }
  }
  await page.keyboard.press('Escape').catch(() => {});
  await page.waitForTimeout(TIMING.modalSettle);
}

/* ----------------------------------------------------------------------
   로그인
   ⚠️ 옛 코드는 baseUrl('') 을 호출해 `https://.studiomate.kr` 로 갔다가 조용히 실패했다.
      이제는 slug 를 받고, 로그인 후에도 비밀번호 입력칸이 남아 있으면 **에러를 던진다.**
      (로그인 실패를 "예약자 0명"으로 오해하면 전 지점이 조용히 비게 된다)
   ---------------------------------------------------------------------- */
export async function loginStudioMate(page, { email, password, slug = '' }) {
  await page.goto(URLS.login(slug), {
    waitUntil: 'domcontentloaded',
    timeout: TIMING.navTimeout,
  });
  await page.fill(SELECTORS.login.email, email, { timeout: TIMING.waitTimeout });
  await page.fill(SELECTORS.login.password, password, { timeout: TIMING.waitTimeout });
  await page.click(SELECTORS.login.submit, { timeout: TIMING.waitTimeout });

  if (SELECTORS.login.success) {
    await page.locator(SELECTORS.login.success).first().waitFor({ timeout: TIMING.waitTimeout });
  } else {
    await page.waitForLoadState('networkidle', { timeout: TIMING.waitTimeout }).catch(() => {});
  }

  if (await page.locator(SELECTORS.login.password).count()) {
    throw new Error(
      '스튜디오메이트 로그인 실패 — 계정/비밀번호 또는 selectors.mjs 의 login 셀렉터를 확인하세요.',
    );
  }
}

/* ----------------------------------------------------------------------
   한 지점의 하루치 예약자 수집
   반환: { rows, 수업수, missing }
     · rows    reservations 레코드 배열 (정규화 완료)
     · 수업수  그날 화면에 있던 수업 개수. **0건과 실패를 구분하기 위해 따로 준다** —
               일요일 휴무처럼 수업이 0개인 건 정상이지만, 수업은 있는데 예약자가 0명이면
               셀렉터를 의심해야 한다.
     · missing 전 행이 비어 있던 필드(=셀렉터 미설정 의심)
   실패는 삼키지 않고 throw 한다.
   ---------------------------------------------------------------------- */
export async function scrapeBranch(page, branch, { date, mode = 'roster' }) {
  if (!branch.slug) {
    throw new Error(`[${branch.name}] SM_SLUG_* 미설정 — 이 지점은 스크랩할 수 없습니다.`);
  }
  if (!selectorsReady()) {
    throw new Error(
      'automation/studiomate/selectors.mjs 의 셀렉터가 아직 비어 있습니다. ' +
        '라이브 세션에서 채우거나, 그 전까지는 MOCK_FILE 로 파이프라인을 검증하세요.',
    );
  }

  await page.goto(URLS.schedule(branch.slug, date), {
    waitUntil: 'domcontentloaded',
    timeout: TIMING.navTimeout,
  });

  const classList = page.locator(SELECTORS.classes.list);
  try {
    await classList.first().waitFor({ state: 'visible', timeout: TIMING.waitTimeout });
  } catch {
    // 수업이 정말 0개인가(휴무일), 아니면 화면을 못 읽은 건가?
    if (SELECTORS.classes.empty && (await page.locator(SELECTORS.classes.empty).count())) {
      return { rows: [], 수업수: 0, missing: [] };
    }
    throw new Error(
      `[${branch.name}] ${date} 수업 목록을 찾지 못했습니다. ` +
        '(로그인 실패 / URLS.schedule / SELECTORS.classes.list 중 하나를 확인)',
    );
  }

  const 수업수 = await classList.count();
  const rows = [];

  for (let i = 0; i < 수업수; i++) {
    const classRow = classList.nth(i);
    const cls = await readFields(classRow, SELECTORS.class, page);

    if (SELECTORS.classOpen) {
      await classRow.locator(SELECTORS.classOpen).first().click({ timeout: TIMING.waitTimeout });
      await page.waitForTimeout(TIMING.modalSettle);
    }

    const scope = SELECTORS.bookings.root ? page.locator(SELECTORS.bookings.root) : classRow;
    const bookingRows = scope.locator(SELECTORS.bookings.list);
    const n = await bookingRows.count();

    for (let j = 0; j < n; j++) {
      const raw = { ...cls, 예약일자: date };
      mergeNonEmpty(raw, await readFields(bookingRows.nth(j), SELECTORS.booking, page));

      // 출석 모드에서만 회원 상세(수강권 모달)까지 열어 전체/잔여/기간을 읽는다
      if (mode === 'attendance' && SELECTORS.detail.open) {
        mergeNonEmpty(raw, await readDetail(page, bookingRows.nth(j)));
      }

      if (!normText(raw.이름)) continue; // 이름 없는 행(헤더·구분선 등)은 버린다
      rows.push(toReservationRecord(raw, { branch: branch.name, date }));
    }

    if (SELECTORS.classOpen || SELECTORS.bookings.root) {
      await closeOverlay(page, SELECTORS.bookingsClose);
    }
  }

  const wanted = WANTED[mode] || WANTED.roster;
  const missing = rows.length ? wanted.filter((f) => rows.every((r) => !r[f])) : [];

  return { rows, 수업수, missing };
}

/** 예약자 행 → 회원 상세/수강권 모달에서 전체·잔여·기간 읽기 */
async function readDetail(page, bookingRow) {
  const opener = bookingRow.locator(SELECTORS.detail.open).first();
  if ((await opener.count()) === 0) return {};

  await opener.click({ timeout: TIMING.waitTimeout });
  await page.waitForTimeout(TIMING.modalSettle);

  const scope = SELECTORS.detail.root ? page.locator(SELECTORS.detail.root) : page;
  // open/root/close 는 값이 아니라 조작용이므로 필드맵에서 제외한다
  const { open: _o, root: _r, close: _c, ...fields } = SELECTORS.detail;
  const out = await readFields(scope, fields, page);

  await closeOverlay(page, SELECTORS.detail.close);
  return out;
}
