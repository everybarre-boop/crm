// ============================================================================
// 스튜디오메이트 — URL + 셀렉터 (⚠️ 라이브 세션에서 고치는 파일은 여기 **하나뿐**이다)
// ----------------------------------------------------------------------------
// scrape.mjs 는 이 파일의 값을 데이터로만 다룬다(필드맵 순회). 그래서 화면 구조가 바뀌면
// 여기만 고치면 되고, 흐름 코드는 손댈 필요가 없다.
//
// 셀렉터 값은 두 가지를 허용한다:
//   1) 문자열  — CSS/Playwright 셀렉터. 첫 매치의 textContent 를 읽는다.
//   2) 함수    — async (scope, page) => string.  속성 읽기·정규식 등 예외 케이스용.
//                예: (row) => row.getAttribute('data-phone')
//   3) null    — "아직 모름". 그 필드는 빈 값이 되고 실행 요약에 '미수집 필드'로 경고가 뜬다.
//                → 셀렉터를 한 번에 다 채우지 않아도 파이프라인을 돌려볼 수 있다.
//
// 채우는 법:
//   HEADLESS=false 로 두면 브라우저 창이 뜬다. 또는
//   npx playwright codegen https://<slug>.studiomate.kr
//
// 확인 순서: roster(D+1 명단, 단순) → attendance(D-1 출석 + 수강권 모달, 복잡)
// ============================================================================

/* ----------------------------------------------------------------------
   URL — 실제 도메인 형태를 라이브 세션에서 확인할 것.
   지점마다 서브도메인이 다를 가능성이 높아 slug 를 받는 형태로 뒀다.
   ---------------------------------------------------------------------- */
export const URLS = {
  /** 로그인 페이지. slug 별로 다르면 (slug) => ... 로 바꿀 것. */
  login: (slug) => (slug ? `https://${slug}.studiomate.kr/login` : 'https://studiomate.kr/login'),
  /** 특정 날짜(YYYY-MM-DD)의 수업 목록. */
  schedule: (slug, date) => `https://${slug}.studiomate.kr/schedule?date=${date}`,
};

export const SELECTORS = {
  // ── 로그인 ────────────────────────────────────────────────────────────
  login: {
    email: 'input[type="email"]',
    password: 'input[type="password"]',
    submit: 'button[type="submit"]',
    /** 로그인 성공을 확인할 요소. null 이면 networkidle 만 기다린다. */
    success: null,
  },

  // ── 수업 목록 ─────────────────────────────────────────────────────────
  classes: {
    /** 수업 한 개를 나타내는 행/카드. TODO */
    list: null,
    /** "수업 없음" 안내 요소. 있으면 0건을 '정상'으로 판정한다(휴무일 구분). */
    empty: null,
  },
  /** 수업 행 안에서 읽는 필드 */
  class: {
    수업시간: null,
    수업명: null,
    강사: null,
  },
  /** 예약자 목록을 펼치기 위해 수업 행에서 클릭할 요소. null 이면 클릭 없이 바로 읽는다. */
  classOpen: null,

  // ── 예약자 목록 ───────────────────────────────────────────────────────
  bookings: {
    /** 예약자 목록이 모달/사이드패널로 뜨면 그 루트. null 이면 수업 행 안에서 찾는다. */
    root: null,
    /** 예약자 한 명을 나타내는 행. TODO */
    list: null,
  },
  /** 예약자 행 안에서 읽는 필드 */
  booking: {
    이름: null,
    연락처: null,   // 목록에 안 보이면 null 로 두고 detail 에서 읽는다
    수강권명: null,
    예약상태: null,
  },
  /** 예약자 목록을 닫는 요소(모달인 경우). null 이면 Escape 키를 누른다. */
  bookingsClose: null,

  // ── 회원 상세 / 수강권 모달 (mode:'attendance' 에서만 탄다) ─────────────
  detail: {
    /** 예약자 행에서 상세를 여는 요소. null 이면 상세 진입 자체를 하지 않는다. */
    open: null,
    /** 모달 루트. null 이면 page 전체에서 찾는다. */
    root: null,
    전체횟수: null,
    잔여횟수: null,
    수강권시작일: null,
    수강권종료일: null,
    연락처: null,
    /** 닫기 버튼. null 이면 Escape. */
    close: null,
  },
};

/* ----------------------------------------------------------------------
   타이밍 — 화면이 느리면 여기만 늘린다.
   ---------------------------------------------------------------------- */
export const TIMING = {
  navTimeout: 30000,
  waitTimeout: 15000,
  /** 모달이 열리고 내용이 그려질 때까지의 여유 (ms) */
  modalSettle: 300,
};

/** 셀렉터가 아직 하나도 안 채워졌는지 — run.mjs 가 친절한 에러를 내기 위해 쓴다. */
export function selectorsReady() {
  return Boolean(SELECTORS.classes.list && SELECTORS.bookings.list && SELECTORS.booking.이름);
}
