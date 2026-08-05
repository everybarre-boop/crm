// ============================================================================
// 실패 알림 CLI — 워크플로우의 `if: failure()` 스텝에서 부른다
// ----------------------------------------------------------------------------
// run.mjs 자체가 죽는 경우(npm ci 실패, playwright 설치 실패, 20분 timeout, OOM)를 위한
// 마지막 그물이다. run.mjs 가 이미 알렸으면 automation/out/.notified 마커를 보고 건너뛴다.
//
// 사용: node automation/notify.mjs "워크플로 실패 (러너/설치 단계 포함)"
// 필요한 환경변수: SLACK_BOT_TOKEN, SLACK_CHANNEL_OPS, (선택) RUN_URL
// ============================================================================
import { readFile } from 'node:fs/promises';
import { notifyOps } from './slack.mjs';

const MARKER = 'automation/out/.notified';

const msg = process.argv.slice(2).join(' ') || '일간 자동화가 실패했습니다.';

try {
  const seen = await readFile(MARKER, 'utf8').catch(() => '');
  if (seen.trim()) {
    console.log('[notify] run.mjs 가 이미 알림을 보냈습니다 — 중복 발송 생략.');
    process.exit(0);
  }
  const ok = await notifyOps(msg, { level: 'error' });
  process.exit(ok ? 0 : 0); // 알림 실패로 워크플로를 또 빨갛게 만들지는 않는다
} catch (err) {
  console.error('[notify] 실패:', err.message);
  process.exit(0);
}
