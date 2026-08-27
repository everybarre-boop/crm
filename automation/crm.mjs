// ============================================================================
// CRM 단계 — 규칙 평가 → 저장 → 지점별 슬랙 발송
// ----------------------------------------------------------------------------
// 판정 로직은 여기 없다. 전부 shared/crm-rules.mjs(순수 함수)에 있다.
// 이 파일은 "DB 에서 읽어와 넘기고, 결과를 저장하고, 슬랙에 뿌리는" 배선만 한다.
// ============================================================================
import { buildCrm, mergeRules } from '../shared/crm-rules.mjs';
import { BRANCHES, env, siteOfBranch } from './config.mjs';
import {
  fetchAttendanceRows,
  fetchCrmInputs,
  fetchReservationsSince,
  fetchRules,
  getSlackPost,
  logRun,
  markMessagesSent,
  saveCrmMessages,
  saveDormant,
  upsertSlackPost,
} from './db.mjs';
import { notifyOps, postBranchDigest, printPreview } from './slack.mjs';

/* ----------------------------------------------------------------------
   1) 규칙 평가 + 저장
   ---------------------------------------------------------------------- */
export async function buildAndSaveCrm({ rosterRows, today, targetDate, dryRun }) {
  const [dbRules, inputs, attendanceRows] = await Promise.all([
    fetchRules(),
    fetchCrmInputs(),
    /* 회차·마일스톤의 근거 — 스튜디오메이트가 직접 센 출석 수(사이트별).
       비어 있으면 buildCrm 이 옛 경로(차감 횟수)로 폴백한다. docs/NEXT-attendance-count.md */
    fetchAttendanceRows(),
  ]);

  /* 기준일 이후 보정용 예약 행.
     ⚠️ reservations 전량 스캔 금지(하루 300~800행) — 가장 오래된 기준일 이후로만 끊는다.
        그날 읽은 회원에겐 더할 게 없으므로 대부분 빈 손이다. */
  const 가장오래된기준일 = attendanceRows.reduce(
    (min, r) => (!min || String(r.기준일) < min ? String(r.기준일).slice(0, 10) : min),
    '',
  );
  const recentReservations = 가장오래된기준일
    ? await fetchReservationsSince(가장오래된기준일)
    : [];
  /* ⚠️ DB(crm_rules)에 아직 없는 규칙을 코드 기본값으로 채운다.
     postCrmToSlack 은 여기서 넘긴 rules 의 "슬랙발송"·"라벨"만 보므로, 병합하지 않으면
     새로 추가한 규칙이 멘트는 만들어지는데 **슬랙에 안 나가고 라벨도 비는** 상태가 된다.
     seed SQL(sql/2026-08_crm_rules_v2.sql)을 돌리면 DB 값이 이긴다. */
  const rules = mergeRules(dbRules);

  const result = buildCrm({
    memberRows: inputs.memberRows,
    rosterRows,
    lastAttendance: inputs.lastAttendance,
    sentHistory: inputs.sentHistory,
    rules,
    today,
    targetDate,
    historyDays: inputs.historyDays,
    historyStart: inputs.historyStart,
    attendanceRows,
    recentReservations,
    siteOfBranch,
  });

  for (const w of result.warnings) console.warn(`  ⚠️ ${w}`);

  const saved = await saveCrmMessages(result.messages, { dryRun });
  const dorm = await saveDormant(result.dormant, { today, dryRun });

  await logRun({
    단계: 'crm',
    대상일자: targetDate,
    dryRun,
    요청건수: result.messages.length,
    반영건수: saved.length,
    미매칭: result.warnings.map((w) => ({ 경고: w })),
  });

  console.log(
    `[crm] 예약 ${result.stats.예약}건 → 멘트 ${result.messages.length}건` +
      (dryRun ? ' (dry-run · 저장 안 함)' : ` / 저장 ${saved.length}건`) +
      ` · 휴면 ${result.dormant.length}명` +
      (dryRun ? '' : ` (해제 ${dorm.cleared}명)`),
  );
  const detail = Object.entries(result.stats)
    .filter(([k]) => !['예약', '멘트', '휴면'].includes(k))
    .map(([k, v]) => `${k} ${v}`)
    .join(' · ');
  if (detail) console.log(`       규칙별: ${detail}`);

  return { rules, result, saved, historyDays: inputs.historyDays };
}

/* ----------------------------------------------------------------------
   2) 지점별 슬랙 발송
   · 슬랙발송=false 인 규칙(14일 미방문)은 제외한다 — 대시보드 전용이다.
   · 같은 날 재실행이면 crm_slack_posts 의 ts 로 chat.update 한다(새 메시지 X).
   · 0명인 지점은 기본적으로 보내지 않는다(매일 "0명"은 노이즈). SLACK_POST_EMPTY=true 로 켤 수 있다.
   ---------------------------------------------------------------------- */
export async function postCrmToSlack({ rules, messages, targetDate, dryRun }) {
  const slackRules = new Set(rules.filter((r) => r.슬랙발송).map((r) => r.id));
  const sendable = messages.filter((m) => slackRules.has(m.rule_id));

  const byBranch = new Map();
  for (const b of BRANCHES) byBranch.set(b.name, []);
  for (const m of sendable) {
    const key = byBranch.has(m.지점) ? m.지점 : '(미지정)';
    if (!byBranch.has(key)) byBranch.set(key, []);
    byBranch.get(key).push(m);
  }

  const failures = [];
  let sentBranches = 0;

  for (const [branchName, list] of byBranch) {
    const branch = BRANCHES.find((b) => b.name === branchName);

    if (!list.length && !env.SLACK_POST_EMPTY) {
      if (!dryRun) {
        await upsertSlackPost(
          { 대상일자: targetDate, 지점: branchName, 종류: 'daily',
            channel_id: branch?.slack || '', 건수: 0, 상태: 'skipped', 에러: null },
          { dryRun },
        ).catch(() => {});
      }
      continue;
    }
    if (!branch) {
      failures.push({ step: 'slack', branch: branchName, error: '지점을 알 수 없어 채널을 못 찾았습니다(수강권명에 지점 태그 누락?).' });
      continue;
    }
    if (!branch.slack && !dryRun) {
      failures.push({ step: 'slack', branch: branchName, error: 'SLACK_CHANNEL_* 미설정' });
      continue;
    }

    try {
      const existing = dryRun ? null : await getSlackPost({ targetDate, branch: branchName });
      const res = await postBranchDigest({
        branch: branchName,
        channel: branch.slack,
        targetDate,
        messages: list,
        rules,
        existing,
        dryRun,
      });

      if (dryRun) {
        printPreview(branchName, res.preview);
      } else {
        await upsertSlackPost(
          { 대상일자: targetDate, 지점: branchName, 종류: 'daily', channel_id: branch.slack,
            message_ts: res.ts, 건수: list.length, 상태: 'ok', 에러: null },
          { dryRun },
        );
        await markMessagesSent(list.map((m) => m.id).filter(Boolean), { ts: res.ts, dryRun });
      }
      sentBranches++;
      console.log(`[slack] ${branchName}: ${list.length}명${dryRun ? ' (dry-run)' : ' 발송'}`);
    } catch (err) {
      failures.push({ step: 'slack', branch: branchName, error: err.message });
      console.error(`[error] ${branchName} 슬랙 발송 실패: ${err.message}`);
      if (!dryRun) {
        await upsertSlackPost(
          { 대상일자: targetDate, 지점: branchName, 종류: 'daily', channel_id: branch.slack,
            건수: list.length, 상태: 'failed', 에러: String(err.message).slice(0, 500) },
          { dryRun },
        ).catch(() => {});
        await markMessagesSent(list.map((m) => m.id).filter(Boolean), {
          ts: null, error: err.message, dryRun,
        }).catch(() => {});
      }
    }
  }

  await logRun({
    단계: 'slack',
    대상일자: targetDate,
    dryRun,
    요청건수: sendable.length,
    반영건수: sentBranches,
    미매칭: failures.map((f) => ({ 지점: f.branch, 오류: f.error })),
  }).catch(() => {});

  return { failures, sentBranches, sendable: sendable.length };
}

export { notifyOps };
