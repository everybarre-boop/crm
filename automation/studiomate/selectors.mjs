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
  /* 수업 상세. **여기는 쿼리가 먹는다** — 날짜(?date=)와 달리 id 로 직접 열 수 있다(실측).
     클릭 대신 이걸로 여는 이유는 scrape.mjs 2단계 주석 참고(클릭 직후엔 직전 수업이 보인다). */
  lectureDetail: (slug, id) => `https://${slug}.studiomate.kr/lecture/detail?id=${encodeURIComponent(id)}`,
};

export const SELECTORS = {
  // ── 로그인 ────────────────────────────────────────────────────────────
  login: {
    /* ⚠️ 로그인 폼이 두 종류다(실측):
         지점 서브도메인(everybarre-*.studiomate.kr) → input#identity      placeholder "휴대폰 번호"
         공통 관리자앱(manager.studiomate.kr)        → input#mobileRequired placeholder "휴대폰 번호 입력"
       셋을 콤마로 묶어 둔다(같은 요소가 여러 번 매칭돼도 Playwright 가 하나로 본다). */
    phone: 'input#identity, input#mobileRequired, input[placeholder^="휴대폰 번호"]',
    password: 'input#password, input[type="password"]',
    submit: 'button[type="submit"], button:has-text("로그인")',
    /** 로그인 성공 판정 — 상단 메뉴가 뜨면 성공 */
    success: '.main-nav',
  },

  /* ── 방해 요소 ─────────────────────────────────────────────────────────
     로그인 직후 공지/배너 다이얼로그(.noti-dialog)가 떠서 **클릭을 가로챈다**.
     실측에서 뷰 전환 클릭이 30초간 막혔다 → 조작 전에 먼저 닫는다. */
  dialogs: {
    any: '.el-dialog__wrapper:visible',
    close:
      '.el-dialog__headerbtn, button:has-text("닫기"), button:has-text("오늘 하루"), button:has-text("확인")',
  },

  // ── 일정(캘린더) ──────────────────────────────────────────────────────
  calendar: {
    /** 현재 보고 있는 날짜를 담은 input.
        ⚠️ 뷰에 따라 값 형식이 다르다 — 일간이면 '2026-08-10', 주간이면 '2026w33'.
           그래서 반드시 **일간 뷰로 바꾼 뒤** 읽어야 한다. */
    dateInput: '.el-date-editor input',
    prevDay: '.calendar-controls__buttons button:has(.el-icon-arrow-left)',
    nextDay: '.calendar-controls__buttons button:has(.el-icon-arrow-right)',

    /* 일간 뷰 라디오 — 앞에 있는 것부터 시도한다.
       ⚠️ 지점마다 선택지가 다르다: 룸이 여러 개인 곳(청담·판교)에만 '일간(룸별)'이 있고,
          룸이 하나인 곳(광교 등)은 '일간(강사별)'만 있다. 실측으로 확인했다.
       ⚠️ 새 세션의 기본 뷰는 **주간**이다(뷰 설정은 localStorage 에 저장되는데
          자동화는 매번 새 세션이다). 그래서 매번 일간으로 바꿔야 한다. */
    dayViewValues: ['date|room', 'date|instructor'],
    dayViewRadio: (v) => `input.el-radio-button__orig-radio[value="${v}"]`,
    dayViewLabel: (v) => `label:has(input.el-radio-button__orig-radio[value="${v}"])`,

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

  /* ── 예약자 목록 (수업 상세 안) ─────────────────────────────────────────
     실측 구조 (2026-08-12, 27개 수업 전수 확인):

       div.lecture-members
         h5 "예약회원 (11명)"
         div.lecture-members__list > ul > li.members-list-item        ← 예약자
         h5 "예약 대기 회원 (3명)"                                     ← 대기자가 있을 때만
         div.lecture-members__list > ul > li.members-list-item        ← 대기자 (별도 ul)
         h5 "예약 취소"                                                ← 표본 27개에선 행이 0개였다

     🔥 라벨 N 은 li 수와 다르다. 두 가지 이유가 겹친다:
       ① 결석 행에는 `uncounted` 클래스가 붙고 라벨 N 에서 **빠진다**
          (27개 수업에서 결석 ⇔ uncounted 가 1:1, 예외 0건).
       ② 대기자는 자기 라벨("예약 대기 회원 (M명)")로 따로 센다.
       → 정확한 불변식:  count(li:not(.uncounted)) == N + M
     예전엔 이걸 몰라 만석 수업에서 "화면은 10명인데 11명이 읽혔습니다"로 실패했다. */
  bookings: {
    /* ⚠️ li 만으로 잡으면 안 된다 — 예약상태 드롭다운의 옵션(취소/출석/결석/노쇼)도
          li 라서 11명짜리 수업에서 55개가 잡힌다. 반드시 .members-list-item 을 쓴다.
       예약자와 대기자를 **둘 다** 잡는다. 구분은 DOM 이 아니라 예약상태 값으로 한다
       (대기자 li 에는 구분용 클래스가 없다 — 실측 확인). */
    list: 'li.members-list-item',
    /** 인원수에 세는 행만 — 결석(uncounted)을 뺀 것. 렌더 완료 판정의 기준이다. */
    counted: 'li.members-list-item:not(.uncounted)',
    /* "예약회원 (11명)" — 목록이 **다 그려졌는지** 판정하는 기대값.
       이게 없으면 렌더 도중에 세어 실행마다 인원이 달라진다(실측: 78/96/88).
       ⚠️ **예약자가 0명인 수업엔 이 라벨이 아예 없다**(실측 2026-08-13 광교 11:00 —
          라벨이 "수강회원"과 "예약 취소"뿐이고 li 도 0개). 부재를 곧바로 실패로 보면
          빈 수업 하나가 그 지점 CRM 을 통째로 끊는다. scrape.mjs 가 li 개수로 구분한다. */
    countLabel: 'h5:has-text("예약회원")',
    /** "예약 대기 회원 (3명)" — 대기자가 없는 수업엔 아예 없다(그때 M=0).
        ⚠️ 위 countLabel 과 겹치지 않는다. "예약 대기 회원"에는 "예약회원"이 안 들어간다. */
    waitLabel: 'h5:has-text("예약 대기")',
  },
  /* 예약자 행 안의 필드 — 전부 **li 기준 하위 CSS 셀렉터**여야 한다.
     scrape.mjs 가 이 값들을 브라우저 안으로 넘겨 `li.querySelector(...)` 로 한 번에 읽는다
     (행마다 왕복하면 읽는 도중 목록이 다시 그려져 같은 행을 두 번 읽는다 — 아래 참고). */
  booking: {
    /** "박진화 · 010-3850-9069" — normalize 가 이름/연락처로 쪼갠다 */
    회원: '.members-list-item__name a',
    /** "바레 그룹 40회(판교) · 12회 남음 · 2026. 5. 8.~2026. 11. 3." */
    수강권: '.members-list-item__ticket-info',
    /* ⚠️ 예약상태는 텍스트가 아니라 **readonly input 의 value** 다
       (Element UI 셀렉트라 선택값이 textContent 에 안 나온다) → `.value` 로 읽는다. */
    예약상태: '.members-list-item__select input',
  },
};

/* 예약상태 어휘 — 정규화 **후**의 값. 화면 원문은 "예약 확정", "예약 대기 (1)" 처럼
   띄어쓰기·순번이 붙어 나오므로 normalize.mjs 의 normStatus 가 여기로 접는다. */
export const STATUS_VALUES = ['예약', '예약대기', '출석', '결석', '노쇼', '취소'];

export const TIMING = {
  navTimeout: 30000,
  // 로그인 직후 앱이 초기 데이터를 여럿 부르느라 느릴 때가 있다(실측: 간헐적 15초 초과)
  waitTimeout: 25000,
  /** 캘린더가 날짜를 다시 그릴 때까지의 여유 */
  daySettle: 700,
  /** "수업 0개"로 보일 때 한 번 더 기다리는 간격 — 0 을 휴무일로 오인하지 않기 위함 */
  emptySettle: 1200,
  /** 상세 페이지 렌더 여유 */
  detailSettle: 400,
};

/** 셀렉터가 채워졌는지 — run.mjs 가 친절한 에러를 내기 위해 쓴다. */
export function selectorsReady() {
  return Boolean(
    SELECTORS.calendar.classItem && SELECTORS.bookings.list && SELECTORS.booking.회원,
  );
}
