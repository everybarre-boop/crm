// ============================================================================
// 스튜디오메이트 — URL + 셀렉터 (⚠️ 화면이 바뀌면 고치는 파일은 여기 **하나뿐**이다)
// ----------------------------------------------------------------------------
// 2026-08-10 실제 화면(everybarre.studiomate.kr)에서 확인해 채웠다.
// scrape.mjs 는 흐름만 담당하고 이 파일의 값만 본다.
//
// 화면 구조 (라이브 확인 결과)
//   /schedule                     일간(룸별) 캘린더. FullCalendar 기반.
//                                 · 날짜는 URL 쿼리(?date=)로 못 바꾼다 — **무시된다.**
//                                   좌/우 화살표 버튼으로만 이동한다.
//                                 · 수업 블록 = .event-item  (예약/정원, 시각, 수업명)
//   → 수업 블록 클릭
//   /lecture/detail?id=<n>        수업 상세. **여기 한 페이지에 필요한 게 전부 있다.**
//                                 회원 상세 모달에 따로 들어갈 필요가 없다:
//                                   이름 · 연락처 · 수강권명 · 잔여횟수 · 수강권기간 · 예약상태
//
// ⚠️ 전체횟수는 화면 어디에도 없다("12회 남음"만 있다). 그래서 스크래퍼는 전체횟수를
//    비워 보내고, apply_attendance v2 가 coalesce 로 DB 기존 값을 유지한다.
//    (전체횟수는 등록 시점 확정값이고 주간 엑셀 재업로드로 교정된다)
// ============================================================================

export const URLS = {
  /** 로그인 — ⚠️ 이메일이 아니라 **휴대폰 번호**로 로그인한다. */
  login: (slug) => `https://${slug}.studiomate.kr/login`,
  /** 일정(일간). 날짜는 쿼리로 못 넘긴다 — 화살표로 이동해야 한다. */
  schedule: (slug) => `https://${slug}.studiomate.kr/schedule`,
};

export const SELECTORS = {
  // ── 로그인 ────────────────────────────────────────────────────────────
  login: {
    phone: 'input#mobileRequired',
    password: 'input#password',
    submit: 'button[type="submit"]',
    /** 로그인 성공 판정 — 상단 메뉴가 뜨면 성공 */
    success: '.main-nav',
  },

  // ── 일정(캘린더) ──────────────────────────────────────────────────────
  calendar: {
    /** 현재 보고 있는 날짜(YYYY-MM-DD)를 담은 input. 목표 날짜 도달 검증에 쓴다. */
    dateInput: '.el-date-editor input.el-input__inner',
    prevDay: '.calendar-controls__buttons button:has(.el-icon-arrow-left)',
    nextDay: '.calendar-controls__buttons button:has(.el-icon-arrow-right)',
    /** 일간(룸별) 뷰로 고정 — 다른 뷰면 .event-item 배치가 달라진다. */
    dayRoomViewLabel: 'label:has(input.el-radio-button__orig-radio[value="date|room"])',
    dayRoomViewRadio: 'input.el-radio-button__orig-radio[value="date|room"]',
    /** 수업 블록. 클릭하면 /lecture/detail 로 이동한다. */
    classItem: '.event-item',
  },

  // ── 수업 상세 ─────────────────────────────────────────────────────────
  detail: {
    /** 이 요소가 보이면 상세 페이지 로딩 완료 */
    ready: '.lecture-detail-header__content__title',
    수업명: '.lecture-detail-header__content__title h3',
    /** "2026년 8월 11일 화요일 · 09:30 ~ 10:20" — normalize 가 날짜/시각으로 쪼갠다 */
    일시: '.lecture-detail-header__content__title p',
    강사: '.lecture-info__block__instructor a',
  },

  // ── 예약자 목록 (수업 상세 안) ─────────────────────────────────────────
  bookings: {
    /* ⚠️ li 만으로 잡으면 안 된다 — 예약상태 드롭다운의 옵션(취소/출석/결석/노쇼)도
          li 라서 11명짜리 수업에서 55개가 잡힌다. 반드시 .members-list-item 을 쓴다. */
    list: 'li.members-list-item',
  },
  booking: {
    /** "박진화 · 010-3850-9069" — normalize 가 이름/연락처로 쪼갠다 */
    회원: '.members-list-item__name a',
    /** "바레 그룹 40회(판교) · 12회 남음 · 2026. 5. 8.~2026. 11. 3." */
    수강권: '.members-list-item__ticket-info',
    /* 예약상태는 텍스트가 아니라 **readonly input 의 value** 다.
       (Element UI 셀렉트라 선택값이 textContent 에 안 나온다) */
    예약상태: async (row) => {
      const el = row.locator('.members-list-item__select input').first();
      if (!(await el.count())) return '';
      return (await el.inputValue()) || '';
    },
  },
};

/** 예약상태 어휘 — 실제 드롭다운 옵션에서 확인 (미래 수업은 '예약') */
export const STATUS_VALUES = ['예약', '출석', '결석', '노쇼', '취소'];

export const TIMING = {
  navTimeout: 30000,
  waitTimeout: 15000,
  /** 캘린더가 날짜를 다시 그릴 때까지의 여유 */
  daySettle: 700,
  /** 상세 페이지 렌더 여유 */
  detailSettle: 400,
};

/** 셀렉터가 채워졌는지 — run.mjs 가 친절한 에러를 내기 위해 쓴다. */
export function selectorsReady() {
  return Boolean(
    SELECTORS.calendar.classItem && SELECTORS.bookings.list && SELECTORS.booking.회원,
  );
}
