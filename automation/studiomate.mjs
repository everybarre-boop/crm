// ============================================================================
// 스튜디오메이트 스크래퍼 (Playwright)
// ----------------------------------------------------------------------------
// 하는 일: 지점별로 로그인 → "당일 수업" → 각 수업의 예약자 → 회원 상세의
//          수강권 모달에서 "전체 / 잔여" 횟수를 읽어 records 로 만든다.
//          (gwanggyo 수동 SQL 의 데이터 출처를 자동화. "예약 가능"은 쓰지 않는다.)
//
// ⚠️ 셀렉터는 스튜디오메이트 실제 화면에 맞춰 채워야 한다(아래 SELECTORS / TODO).
//    Playwright codegen 으로 실제 클릭 경로를 뽑으면 쉽다:
//      npx playwright codegen https://<slug>.studiomate.kr
//    셀렉터를 채우기 전에는 run.mjs 를 MOCK_FILE 로 먼저 검증한다(파이프라인 확인).
//
// 반환: [{ 이름, 연락처, 수강권명, 전체횟수, 잔여횟수 }, ...]  (전체/잔여는 문자열)
// ============================================================================

// 실제 화면에 맞게 확정할 셀렉터 모음 (TODO)
const SELECTORS = {
  // 로그인
  loginEmail: 'input[type="email"]',
  loginPassword: 'input[type="password"]',
  loginSubmit: 'button[type="submit"]',
  // TODO: 당일 수업 목록, 예약자 행, 회원 상세 진입, 수강권 모달의 전체/잔여 셀렉터
};

const baseUrl = (slug) => `https://${slug}.studiomate.kr`; // TODO: 실제 도메인 형태 확인

export async function loginStudioMate(page, { email, password }) {
  // TODO: 실제 로그인 URL/폼에 맞게 조정
  await page.goto(baseUrl(''), { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.fill(SELECTORS.loginEmail, email);
  await page.fill(SELECTORS.loginPassword, password);
  await page.click(SELECTORS.loginSubmit);
  await page.waitForLoadState('networkidle');
}

// 한 지점의 "오늘 예약자 + 전체/잔여" 수집
export async function scrapeBranch(page, branch, { date }) {
  if (!branch.slug) {
    throw new Error(
      `[${branch.name}] STUDIOMATE slug 미설정. automation/config.mjs 의 SM_SLUG_* 환경변수를 채우거나 ` +
        `MOCK_FILE 로 파이프라인을 먼저 검증하세요.`,
    );
  }

  // ------------------------------------------------------------------
  // TODO(핵심): 아래는 실제 스튜디오메이트 화면 구조에 맞춰 구현해야 하는 부분.
  //   1) baseUrl(branch.slug) 의 "당일 수업"(date) 화면으로 이동
  //   2) 수업별 예약자 목록을 순회
  //   3) 각 예약자 상세 → 수강권 모달에서 이름·연락처·수강권명·전체·잔여 읽기
  //   Playwright MCP 로 테스트했던 클릭 경로를 여기에 옮기면 된다.
  // ------------------------------------------------------------------
  throw new Error(
    `[${branch.name}] scrapeBranch 미구현. studiomate.mjs 의 SELECTORS/TODO 를 실제 화면에 맞춰 채우세요. ` +
      `(우선은 MOCK_FILE 로 검증)`,
  );

  // 구현 완료 시 반환 형태 예:
  // return [
  //   { 이름: '김보미', 연락처: '010-4234-2380', 수강권명: '바레 그룹 20회 (광교)', 전체횟수: '20', 잔여횟수: '18' },
  // ];
}
