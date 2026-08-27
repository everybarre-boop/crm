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

/* ⚠️ 이 파일의 유일한 import — 타임아웃을 환경변수로 덮어쓰기 위해서다.
   (config.mjs 가 dotenv 를 먼저 읽으므로, process.env 를 직접 보는 것보다 안전하다.
    config.mjs 는 selectors 를 import 하지 않는다 — 순환 없음.) */
import { env } from '../config.mjs';

export const URLS = {
  /** 로그인 — ⚠️ 이메일이 아니라 **휴대폰 번호**로 로그인한다. */
  login: (slug) => `https://${slug}.studiomate.kr/login`,
  /** 일정(일간). 날짜는 쿼리로 못 넘긴다 — 화살표로 이동해야 한다. */
  schedule: (slug) => `https://${slug}.studiomate.kr/schedule`,
  /* 수업 상세. **여기는 쿼리가 먹는다** — 날짜(?date=)와 달리 id 로 직접 열 수 있다(실측).
     클릭 대신 이걸로 여는 이유는 scrape.mjs 2단계 주석 참고(클릭 직후엔 직전 수업이 보인다). */
  lectureDetail: (slug, id) => `https://${slug}.studiomate.kr/lecture/detail?id=${encodeURIComponent(id)}`,
  /* 회원 상세. 여기도 `?id=` 가 먹는다(2026-08-27 실측).
     ⚠️ 다만 **기본정보 탭으로 열린다.** 우리가 원하는 출석 수는 '이용내역' 탭에 있고,
        그 탭은 URL 로 못 연다(?tab=history / ?tab=usage 둘 다 무시되고 URL 이 그대로다).
        → member.historyTab 을 **클릭**해야 한다. */
  userDetail: (slug, id) => `https://${slug}.studiomate.kr/users/detail?id=${encodeURIComponent(id)}`,
  /** 이용회원 목록. 정렬 가능한 '최근출석일' 컬럼이 있다(휴면 규칙에서 쓸 수 있다). */
  users: (slug) => `https://${slug}.studiomate.kr/users`,
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

  /* ── 회원 상세 (`/users/detail?id=`) ───────────────────────────────────
     2026-08-27 라이브 확인. 여기서 읽는 값은 **스튜디오메이트가 직접 센 출석 수**로,
     `전체횟수 − 잔여횟수`(차감된 횟수)를 대체하는 회차·마일스톤의 근거다.
     배경: docs/NEXT-attendance-count.md

     실측으로 확인한 성질 — 이 셋이 설계의 전제다:
       ① 카운트는 **회원 전체·전 수강권 누적**이다(수강권별 집계가 아니다).
          조유림(id 940607, 2021-10 등록): 전체 719 = 출석 528 + 취소 191.
          '이전 수강권 보기' 버튼을 눌러도 값이 그대로다.
       ② `전체(N)` = 예약+출석+결석+노쇼+취소 로 정확히 쪼개진다(실측 2건에서 합 일치).
       ③ 이용내역 탭은 **클릭으로만** 열린다(URL 로 못 연다 — URLS.userDetail 주석 참고).

     ⚠️ 이 값은 **사이트별**이다. 지점=사이트라 청담+송파를 다니는 회원은 양쪽에 각각
        출석 수가 있다. 한쪽만 읽으면 절반이 된다 → 사이트별로 따로 저장하고 합산한다. */
  member: {
    /* 상단 탭바(기본정보 / 이용내역 / 포인트 내역 / 결제 내역).
       ⚠️ el-tabs 가 아니라 그냥 `ul > div > li` 다 — role="tab" 도 없다. */
    detailTabs: 'ul.member-detail__header-tabs li',
    /** 위 li 중에서 이 텍스트인 것을 클릭한다 */
    historyTabText: '이용내역',
    /* 이용내역 탭 안의 카운트 탭 — `전체(719)` `예약(0)` `출석(528)` … 형태.
       숫자는 텍스트에서 파싱한다(별도 요소가 없다). */
    historyCounts: 'ul.member-history__header__tabs li',
    /* 🔥 SPA stale 방지의 핵심 — **이 회원이 맞는지** 확인할 요소.
       수업 상세에서 겪은 그대로다: URL 을 먼저 바꾸고 내용은 API 응답 뒤에 그리므로,
       "요소가 있다"로 판정하면 **직전 회원의 출석 수를 읽는다.**
       존재가 아니라 이름이 일치하는지로 판정할 것. */
    identityName: '.member-detail__header h3',
  },
};

/* 🔥 예약자 행에서 회원 id 를 얻는 법 — **href 가 아니다.**
   docs/NEXT-attendance-count.md 와 예전 메모는 `.members-list-item__name a` 의 href 에서
   얻는다고 적었는데, 2026-08-27 실측 결과 그 `a` 의 **href 는 null** 이다(Vue 클릭 핸들러).
   클릭하면 같은 탭에서 /users/detail?id= 로 이동해 버리므로, 행마다 클릭하면
   "행 단위 왕복"이 되어 목록이 다시 그려지고 사람이 사라진다(그 사고의 재발).

   대신 렌더된 행의 **컴포넌트 상태**를 읽는다 — `li.__vue__.$props.member.id`.
   예약자 목록을 통째로 읽는 **같은 evaluate 한 번**에 같이 읽히므로 왕복이 0 이고,
   네트워크 요청도 추가되지 않는다.

   ⚠️ 이건 API 호출이 아니다. api.studiomate.kr 직접 호출은 `x-sm-signature` 게이트가
      있고 **쓰지 않기로 한 결정**이다(memory: studiomate-scraping). 여기서는 앱이 이미
      그려 놓은 화면의 상태를 읽을 뿐이라 그 결정과 충돌하지 않는다.

   검증(2026-08-27): 첫 행의 member.id = 3205433 이고, 그 이름을 클릭했을 때 이동한 주소가
   /users/detail?id=3205433 으로 일치했다. */
export const MEMBER_ID_VUE_PATH = ['member', 'id'];

/* 예약상태 어휘 — 정규화 **후**의 값. 화면 원문은 "예약 확정", "예약 대기 (1)" 처럼
   띄어쓰기·순번이 붙어 나오므로 normalize.mjs 의 normStatus 가 여기로 접는다. */
export const STATUS_VALUES = ['예약', '예약대기', '출석', '결석', '노쇼', '취소'];

export const TIMING = {
  /* 페이지 이동 한도. **기다리는 시간이 아니라 포기하는 시점**이다 — 빠른 날엔 비용이 0 이고,
     짧게 잡으면 느린 날 하루치가 통째로 빈다.
     🔥 2026-08-21 실측(로컬): 로그인 19.7초 · /schedule 25.4초 · 수업 상세 23.7초.
        옛 한도 30초를 스치듯 넘겨 백필이 5개 사이트 전부 `Timeout 30000ms exceeded` 로 죽었다.
     SCRAPE_NAV_TIMEOUT / SCRAPE_WAIT_TIMEOUT 로 덮어쓸 수 있다(config.mjs). */
  navTimeout: env.SCRAPE_NAV_TIMEOUT,
  // 로그인 직후 앱이 초기 데이터를 여럿 부르느라 느릴 때가 있다(실측: 간헐적 15초 초과)
  waitTimeout: env.SCRAPE_WAIT_TIMEOUT,
  /** 캘린더가 날짜를 다시 그릴 때까지의 여유 */
  daySettle: 700,
  /** "수업 0개"로 보일 때 한 번 더 기다리는 간격 — 0 을 휴무일로 오인하지 않기 위함 */
  emptySettle: 1200,
  /* 🔥 "수업 0개"를 휴무일로 인정하기 전에 **총 이만큼**은 기다린다.
     2026-08-13 GitHub Actions 첫 전 지점 실행에서, 예산이 4.8초(1.2×4)뿐이라
     **수업이 많은 사이트일수록 렌더를 못 기다리고 0 으로 읽었다.**
     실측: 청담·판교(11개)·옥수(5)·반포(5) → 0개 / 광교(4)·송파(4) → 정상.
     멘트가 30건에서 6건으로 줄었는데 워크플로는 **초록불**이었다.
     러너가 로컬보다 느려서 생기는 자리라 **로컬에서는 재현되지 않는다.** */
  emptyBudget: 20000,
  /** 상세 페이지 렌더 여유 */
  detailSettle: 400,
  /* 회원 상세 — 탭을 클릭한 뒤 카운트가 채워질 때까지의 여유.
     ⚠️ 이 값에 의존해 "다 그려졌다"고 판정하지 말 것. scrape.mjs 는 이름 일치 + 카운트
        파싱 성공을 **둘 다** 확인하고, 안 되면 실패시킨다(빈 화면을 0회로 통과시키지 않기 위함). */
  memberSettle: 800,
};

/** 셀렉터가 채워졌는지 — run.mjs 가 친절한 에러를 내기 위해 쓴다. */
export function selectorsReady() {
  return Boolean(
    SELECTORS.calendar.classItem && SELECTORS.bookings.list && SELECTORS.booking.회원,
  );
}
