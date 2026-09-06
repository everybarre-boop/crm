// ============================================================================
// 재시도 게이트 — "오늘 D+1 발송이 이미 끝났나?"
// ----------------------------------------------------------------------------
// 왜 있나: GitHub 의 schedule 은 **정각을 보장하지 않고, 부하 시간대엔 통째로 건너뛴다.**
//   건너뛰면 실패 알림조차 없다(실행이 없었으니 알릴 주체도 없다) — 이 저장소가 가장
//   싫어하는 "밤새 아무 일도 없었는데 아침에 조용한" 상태다.
//   그래서 워크플로에 예비 실행을 자정 전으로 여러 번 둔다(21:43 · 22:26 · 23:11).
//   다만 매번 전 지점을
//   스크랩하면 15분짜리 작업이 두 배가 되므로, 예비 실행은 **먼저 이 게이트를 통과해야**
//   Playwright 설치부터 시작한다. 이미 끝났으면 1분 안에 조용히 종료한다.
//
// 판정: crm_slack_posts 의 (대상일자 = D+1) 행을 본다.
//   · 실패(failed)가 하나라도 있으면          → 재실행한다(멱등하므로 안전하다)
//   · ok 가 하나도 없으면(=행 자체가 없으면)   → 재실행한다
//   · ok 가 있고 실패가 없으면                 → 건너뛴다
//   ⚠️ skipped(0명이라 안 보낸 지점)는 성공도 실패도 아니다. ok 가 하나도 없이 skipped 만
//      있는 날은 "정말 대상이 0명"일 수도, "CRM 이 통째로 실패"했을 수도 있다. 구분할 수
//      없으므로 **재실행 쪽으로 기운다** — 재실행은 chat.update 라 중복 발송이 아니다.
//
// 출력: GITHUB_OUTPUT 에 should_run=true|false. (없으면 stdout 에만 찍는다)
// 종료 코드는 항상 0 이다 — 게이트가 파이프라인을 실패로 만들면 안 된다.
//   조회 자체가 실패하면 **재실행 쪽**(should_run=true)으로 답한다. 모르면 도는 게 낫다.
// ============================================================================
import { appendFileSync } from 'node:fs';
import { dateKST } from '../shared/crm-core.mjs';
import { env } from './config.mjs';
import { getAdminClient } from './apply.mjs';
import { T } from './db.mjs';

const targetDate = env.TARGET_DATE || dateKST(1);

function answer(shouldRun, reason) {
  console.log(`[guard] ${targetDate} → ${shouldRun ? '실행' : '건너뜀'} · ${reason}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `should_run=${shouldRun}\n`);
  }
  process.exit(0);
}

try {
  const sb = await getAdminClient();
  const { data, error } = await sb
    .from(T.posts)
    .select('지점,상태')
    .eq('대상일자', targetDate)
    .eq('종류', 'daily');
  if (error) throw new Error(error.message);

  const rows = data || [];
  const ok = rows.filter((r) => r.상태 === 'ok').length;
  const failed = rows.filter((r) => r.상태 === 'failed').length;

  if (failed) answer(true, `실패한 지점 ${failed}곳이 있습니다(ok ${ok}곳). 재실행합니다.`);
  if (!ok) answer(true, `성공한 발송이 없습니다(행 ${rows.length}개). 재실행합니다.`);
  answer(false, `이미 ${ok}개 지점 발송 완료 · 실패 0.`);
} catch (err) {
  // 모르면 도는 쪽 — 조회 실패로 그날 CRM 이 통째로 빠지는 게 더 나쁘다.
  answer(true, `상태를 확인하지 못했습니다(${err.message}). 안전하게 재실행합니다.`);
}
