// ============================================================================
// 스튜디오메이트 스크래퍼 — 파사드
// ----------------------------------------------------------------------------
// 실제 구현은 studiomate/ 아래에 세 파일로 나뉜다:
//   studiomate/selectors.mjs   ⚠️ 라이브 세션에서 고치는 유일한 파일 (URL·셀렉터)
//   studiomate/scrape.mjs      흐름(로그인·순회·추출). 셀렉터를 모른다.
//   studiomate/normalize.mjs   원문 문자열 → DB 형태 정규화
//
// 기존 import 경로(`./studiomate.mjs`)를 유지하기 위해 여기서 re-export 만 한다.
// ============================================================================
export { loginStudioMate, scrapeBranch } from './studiomate/scrape.mjs';
export { toAttendanceRecords, toReservationRecord } from './studiomate/normalize.mjs';
export { selectorsReady, SELECTORS, URLS } from './studiomate/selectors.mjs';
