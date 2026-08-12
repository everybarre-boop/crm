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
  WAITLIST,
  normDate,
  normStatus,
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

/* 수업 상세 전용 탭.
   캘린더 탭을 그대로 두려고 따로 연다 — 상세를 같은 탭에서 열면 캘린더가 오늘로 되돌아가
   다음 날짜마다 화살표를 처음부터 눌러야 한다(백필이 O(n²) 가 된다).
   같은 BrowserContext 라 쿠키·세션을 공유하므로 다시 로그인할 필요가 없다. */
const _detailPages = new WeakMap();
async function getDetailPage(page) {
  const ctx = page.context();
  const cached = _detailPages.get(ctx);
  if (cached && !cached.isClosed()) return cached;
  const p = await ctx.newPage();
  await installOverlayGuard(p); // 공지 오버레이는 새 탭에도 뜬다
  _detailPages.set(ctx, p);
  return p;
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
     화면 라벨이 정답인데, **라벨 수 = li 수가 아니다.** 두 가지가 겹친다:
       ① 결석 행에는 `uncounted` 클래스가 붙고 "예약회원 (N명)" 에서 빠진다.
       ② 예약대기자는 "예약 대기 회원 (M명)" 이라는 자기 라벨로 따로 센다.
     실측 27개 수업에서 예외 없이 성립한 불변식:  count(li:not(.uncounted)) == N + M   */
  const rows = page.locator(SELECTORS.bookings.list);
  const counted = page.locator(SELECTORS.bookings.counted);
  const 명수 = (s) => Number((normText(s).match(/\((\d+)\s*명/) || [])[1] ?? NaN);

  const 예약N = 명수(await text(page, SELECTORS.bookings.countLabel));
  // 대기자가 없는 수업엔 라벨 자체가 없다 → NaN → 0
  const 대기M = 명수(await text(page, SELECTORS.bookings.waitLabel)) || 0;

  let n = await rows.count();
  if (Number.isFinite(예약N)) {
    const 기대 = 예약N + 대기M;
    const deadline = Date.now() + TIMING.waitTimeout;
    let c = await counted.count();
    while (c < 기대 && Date.now() < deadline) {
      await page.waitForTimeout(200);
      c = await counted.count();
    }
    n = await rows.count();
    if (c !== 기대) {
      throw new Error(
        `예약자 목록이 안 맞습니다 — 화면은 예약 ${예약N}명 + 대기 ${대기M}명 = ${기대}명인데 ` +
          `${c}명이 읽혔습니다 (${수업명} ${수업시간} · li 총 ${n}개). ` +
          `조용히 넘기면 그만큼 CRM 에서 빠집니다. ` +
          `※ 결석 행(.uncounted)은 화면 인원수에서 빠지므로 이 수에도 안 들어갑니다.`,
      );
    }
  }

  /* 🔥 목록은 **한 번의 evaluate 로 통째로** 읽는다. 행마다 locator 로 왕복하면
     (nth(i) × 필드 3개 = 100명이면 300왕복) 읽는 도중 Vue 가 목록을 다시 그릴 때
     인덱스가 밀려 **같은 행을 두 번 읽고 다른 행을 통째로 빠뜨린다.**
     실측(2026-08-12 백필 첫 실행): 옥수 07-29 에서 44행을 읽었는데 서로 다른 사람은
     35명뿐이었다 — 8명이 조용히 사라졌고, 재실행하니 43명이 정상으로 나왔다.
     ⚠️ 인원수 검증은 **개수만** 보므로 이 오류를 못 잡는다. 원자적으로 읽는 게 유일한 방어다.
     (덤으로 왕복이 사라져 훨씬 빠르다.) */
  const raw = await page.evaluate(
    ({ listSel, nameSel, ticketSel, statusSel }) => {
      const txt = (el) => (el ? el.textContent || '' : '');
      return [...document.querySelectorAll(listSel)].map((li) => ({
        회원: txt(li.querySelector(nameSel)),
        수강권: txt(li.querySelector(ticketSel)),
        // Element UI 셀렉트 — 선택값은 textContent 가 아니라 input.value 에 있다
        예약상태: li.querySelector(statusSel)?.value ?? '',
      }));
    },
    {
      listSel: SELECTORS.bookings.list,
      nameSel: SELECTORS.booking.회원,
      ticketSel: SELECTORS.booking.수강권,
      statusSel: SELECTORS.booking.예약상태,
    },
  );

  const out = [];
  let 대기수 = 0;
  for (const r of raw) {
    const 예약상태 = normText(r.예약상태);
    if (normStatus(예약상태) === WAITLIST) 대기수++;
    const { 이름, 연락처 } = parseMemberLine(r.회원);
    if (!이름) continue;
    const ticket = parseTicketLine(r.수강권);
    out.push({
      예약일자: 예약일자 || fallbackDate,
      수업시간,
      수업명,
      강사,
      이름,
      연락처,
      예약상태,
      ...ticket,
    });
  }

  /* 원자적으로 읽었으니 같은 사람이 두 번 나오면 그건 **진짜 중복**이다(위 경합이 아니다).
     res_key 가 같아 저장 때 한 건으로 접히므로, 조용히 넘기지 말고 알려 준다. */
  const 키 = out.map((r) => `${r.이름}|${String(r.연락처).replace(/\D/g, '')}`);
  const 중복 = 키.length - new Set(키).size;
  if (중복) {
    console.warn(
      `  ⚠️ ${수업명} ${수업시간}: 같은 사람이 ${중복}번 중복 표시됩니다 — 저장 시 1건으로 접힙니다.`,
    );
  }

  /* 대기 라벨과 상태값이 어긋나면 둘 중 하나가 바뀐 것이다. 그냥 두면 대기자가
     예약자로 섞여 "내일 봬요" 멘트가 나가므로 여기서 멈춘다. */
  if (Number.isFinite(예약N) && 대기수 !== 대기M) {
    throw new Error(
      `예약대기 인원이 안 맞습니다 — 화면 라벨은 ${대기M}명인데 상태값으로 센 건 ${대기수}명입니다 ` +
        `(${수업명} ${수업시간}). selectors.mjs 의 bookings.waitLabel 또는 ` +
        `normalize.mjs 의 '예약대기' 규칙이 화면과 어긋났습니다.`,
    );
  }
  return out;
}

/* ----------------------------------------------------------------------
   한 사이트의 하루치 예약자 수집
   site: { slug, defaultBranch }  ← everybarre 는 청담·판교 두 지점이 섞여 있어
         지점은 수강권명에서 뽑고(branchOf), 태그가 없을 때만 defaultBranch 로 폴백한다.
   반환: { rows, 수업수, 누락, 대기, missing }
     · 수업수 0 은 정상일 수 있다(휴무일). 수업은 있는데 예약자가 0명이면 셀렉터를 의심.
     · 대기 = 예약대기 행 수. rows 에 **포함돼 있다**(reservations 에는 남기고,
       CRM 대상에서만 crm-rules.mjs 의 NOT_ATTENDING 이 뺀다).
   실패는 삼키지 않고 throw 한다.
   ---------------------------------------------------------------------- */
export async function scrapeBranch(page, site, { date, navigate = true }) {
  if (!site.slug) throw new Error(`[${site.label ?? site.slug}] slug 미설정`);
  if (!selectorsReady()) {
    throw new Error(
      'automation/studiomate/selectors.mjs 의 셀렉터가 비어 있습니다. MOCK_FILE 로 먼저 검증하세요.',
    );
  }

  /* navigate=false 는 백필용이다 — 날짜를 연속으로 훑을 때 매번 /schedule 로 다시 가면
     캘린더가 오늘로 돌아가 gotoDate 가 목표까지 **처음부터** 한 칸씩 이동한다(30일 백필이면
     화살표 클릭이 O(n²)). 이미 /schedule 에 있으면 직전 날짜에서 한 칸만 움직이면 된다.
     단, 어떤 이유로든 /schedule 이 아니면 안전하게 다시 이동한다. */
  if (navigate || !/\/schedule/.test(page.url())) {
    await page.goto(URLS.schedule(site.slug), {
      waitUntil: 'domcontentloaded',
      timeout: TIMING.navTimeout,
    });
  }
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

  /* ── 1단계: 수업 id 만 모은다 (내용은 여기서 읽지 않는다) ────────────────
     수업 블록에는 안정적인 id/href 가 없어(실측: data-id 도 href 도 없다) nth(i) 로 도는데,
     **뒤로 가면 DOM 순서가 바뀐다.** 그래서 상세 URL 의 lecture id 로 중복을 제거하고,
     못 본 수업이 남으면 한 번 더 훑는다. */
  const seen = new Set();
  const ids = [];
  for (let pass = 0; pass < 2 && seen.size < 수업수; pass++) {
    const n = await items.count();
    for (let i = 0; i < n; i++) {
      await items.nth(i).click({ timeout: TIMING.waitTimeout });
      await page.waitForURL(/\/lecture\/detail/, { timeout: TIMING.waitTimeout });

      const id = new URL(page.url()).searchParams.get('id');
      if (!id) {
        // 폴백 키(#pass-i)를 쓰면 같은 수업이 다른 키로 두 번 담긴다 — 조용히 넘기지 않는다
        throw new Error(`수업 상세 URL 에 id 가 없습니다 (${page.url()}). URL 구조가 바뀌었습니다.`);
      }
      if (!seen.has(id)) {
        seen.add(id);
        ids.push(id);
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

  /* ── 2단계: 상세를 URL 로 **직접 열어** 읽는다 ──────────────────────────
     🔥 클릭 직후에 그 자리에서 읽으면 안 된다. 이 SPA 는 URL 을 먼저 바꾸고 내용은 API
        응답 뒤에 다시 그리는데, 로딩 판정용 요소(.lecture-detail-header__content__title)는
        **직전 수업 것이 그대로 남아 있어** waitFor 가 즉시 통과한다 → 이전 수업 명단을
        새 id 로 한 번 더 읽는다.
        실측(2026-07-29 청담·판교): 해월쌤12:00 명단이 솔쌤09:30 의 id 로 또 저장되고,
        **솔쌤10:30 수업 10명은 통째로 사라졌다.** 고유 id 수는 8개로 맞아서 누락 검사도
        통과했다 — 조용히 한 수업이 빠진 것이다.
     goto 로 새로 로드하면 내용이 URL 과 반드시 일치한다(실측 확인).
     캘린더는 **별도 탭**에 그대로 둔다 — 그래야 다음 날짜가 화살표 한 칸이다(백필 성능). */
  const detail = await getDetailPage(page);
  const 시그니처 = new Set();
  for (const id of ids) {
    await detail.goto(URLS.lectureDetail(site.slug, id), {
      waitUntil: 'domcontentloaded',
      timeout: TIMING.navTimeout,
    });
    const read = await readLecture(detail, date);
    /* 같은 수업을 두 번 읽었다면 위 stale 문제가 되살아난 것이다. res_key 가 접어 주지만
       그만큼 다른 수업을 못 읽었다는 뜻이라 조용히 넘기면 안 된다. */
    const sig = `${read[0]?.수업명 ?? ''}|${read[0]?.수업시간 ?? ''}`;
    if (read.length && 시그니처.has(sig)) {
      throw new Error(
        `같은 수업(${sig})을 두 번 읽었습니다 — 상세 화면이 URL 을 따라오지 못하고 있습니다. ` +
          `그만큼 다른 수업이 통째로 빠집니다.`,
      );
    }
    시그니처.add(sig);
    for (const raw of read) {
      rows.push(toReservationRecord(raw, { branch: site.defaultBranch, date }));
    }
  }

  const missing = rows.length ? WANTED.filter((f) => rows.every((r) => !r[f])) : [];
  // 못 본 수업이 있으면 조용히 넘기지 않는다
  const 누락 = 수업수 - seen.size;
  const 대기 = rows.filter((r) => r.예약상태 === WAITLIST).length;
  return { rows, 수업수, 누락: 누락 > 0 ? 누락 : 0, 대기, missing };
}
