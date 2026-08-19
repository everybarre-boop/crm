import { dateKST, addDays } from '@/shared/crm-core.mjs';
import type { Period } from '@/lib/period';

/* ======================================================================
   CRM 화면용 상수 · 타입 · 헬퍼
   ---------------------------------------------------------------------
   데이터는 전부 야간 자동화(GitHub Actions, 매일 21:00 KST)가 만들어 둔다.
   화면은 crm_messages / crm_dormant / daily_runs 를 **읽고, 피드백만 쓴다.**

   ⚠️ 슬랙은 발송 전용이다. 서버가 없어 슬랙 버튼 응답을 받을 엔드포인트를 만들 수
      없으므로(정적 export 유지), 강사 피드백은 오직 이 화면에서만 쌓인다.
   ⚠️ reservations 는 하루 300~800행씩 쌓인다 — 화면에서 전량 스캔 금지.
      필요한 경우 반드시 .gte/.lte('예약일자') 로 끊을 것.
   ====================================================================== */

export const CRM_MSG_TABLE = 'crm_messages';
export const CRM_RULE_TABLE = 'crm_rules';
export const CRM_DORMANT_TABLE = 'crm_dormant';
export const CRM_POST_TABLE = 'crm_slack_posts';
export const RUNS_TABLE = 'daily_runs';
export const RESV_TABLE = 'reservations';
export const HISTORY_VIEW = 'crm_history_depth';

/** 슬랙 없이 관리자 명단으로만 다루는 규칙 */
export const DORMANT_RULE = 'dormant-14';

export const REACTIONS = ['좋음', '보통', '무반응', '부정'] as const;
export type Reaction = (typeof REACTIONS)[number];

/** 피드백 미입력 건에도 항상 필요한 컬럼들 */
export const MSG_SELECT =
  'id,대상일자,지점,rule_id,규칙키,person_key,이름,연락처,수업시간,수업명,강사,수강권명,' +
  '멘트,예시멘트,근거,발송여부,발송시각,발송오류,실행여부,반응,메모,피드백작성자,피드백시각';

export type CrmRule = {
  id: string;
  라벨: string;
  이모지: string;
  활성: boolean;
  슬랙발송: boolean;
  정렬순서: number;
  재발송억제일수: number;
  파라미터: Record<string, unknown>;
  템플릿: string;
  예시멘트: string;
  updated_at?: string;
};

export type CrmMessage = {
  id: number;
  대상일자: string;
  지점: string;
  rule_id: string;
  규칙키: string;
  person_key: string;
  이름: string;
  연락처: string;
  수업시간: string;
  수업명: string;
  강사: string;
  수강권명: string;
  멘트: string;
  예시멘트: string;
  근거: Record<string, unknown>;
  발송여부: boolean;
  발송시각: string | null;
  발송오류: string | null;
  실행여부: boolean | null;
  반응: Reaction | null;
  메모: string | null;
  피드백작성자: string | null;
  피드백시각: string | null;
};

export type CrmDormant = {
  person_key: string;
  이름: string;
  연락처: string;
  마지막출석일: string | null;
  마지막지점: string;
  경과일: number;
  잔여합: number;
  보유수강권: Array<{ 수강권명: string; 잔여횟수: number; 수강권종료일: string }>;
  최초감지일: string;
  갱신일: string;
  조치여부: boolean | null;
  조치메모: string | null;
  조치작성자: string | null;
  조치시각: string | null;
};

export type DailyRun = {
  id: number;
  run_at: string;
  단계: string;
  대상일자: string | null;
  지점: string | null;
  dry_run: boolean;
  요청건수: number;
  반영건수: number;
  미매칭: Array<Record<string, unknown>>;
  created_by: string | null;
};

export type SlackPost = {
  id: number;
  대상일자: string;
  지점: string;
  종류: string;
  channel_id: string;
  message_ts: string | null;
  건수: number;
  상태: string;
  에러: string | null;
  updated_at: string;
};

export const STEP_LABEL: Record<string, string> = {
  attendance: '출석 반영',
  reservations: '예약 저장',
  crm: 'CRM 생성',
  slack: '슬랙 발송',
};

/** 오늘(KST). 브라우저 타임존이 뭐든 한국 날짜를 준다. */
export function todayStr(): string {
  return dateKST(0);
}

export { addDays };

/** 'YYYY-MM-DD' → '8/6(목)' */
export function shortDate(ymd: string): string {
  if (!ymd) return '';
  const [y, m, d] = ymd.split('-').map(Number);
  if (!y || !m || !d) return ymd;
  const w = ['일', '월', '화', '수', '목', '금', '토'][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${m}/${d}(${w})`;
}

/** timestamptz → '2시간 전' 같은 상대 표현 */
export function sinceText(iso: string | null | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (!isFinite(ms)) return '—';
  const min = Math.floor(ms / 60000);
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}시간 전`;
  return `${Math.floor(hr / 24)}일 전`;
}

/** timestamptz → 'HH:MM' (로컬) */
export function hhmm(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return isNaN(d.getTime())
    ? ''
    : `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/* ----------------------------------------------------------------------
   Period(년/반기/분기/월) → [from, to] 날짜 범위.
   crm_messages 를 **서버에서** 끊기 위한 것이다. inPeriod 는 'YYYY-MM' 접두 비교라
   클라이언트 필터로는 되지만, 그러려면 전량을 받아야 한다.
   ---------------------------------------------------------------------- */
export function periodRange(p: Period): [string, string] {
  const pad = (n: number) => String(n).padStart(2, '0');
  const y = p.year;
  const span = (m1: number, m2: number): [string, string] => [
    `${y}-${pad(m1)}-01`,
    addDays(`${m2 === 12 ? y + 1 : y}-${pad(m2 === 12 ? 1 : m2 + 1)}-01`, -1),
  ];
  switch (p.mode) {
    case 'all':
      return ['2000-01-01', '2999-12-31'];
    case 'year':
      return span(1, 12);
    case 'half':
      return p.unit === 1 ? span(1, 6) : span(7, 12);
    case 'quarter':
      return span((p.unit - 1) * 3 + 1, p.unit * 3);
    case 'month':
      return span(p.unit, p.unit);
    default:
      return ['2000-01-01', '2999-12-31'];
  }
}

/* ----------------------------------------------------------------------
   조회 실패 메시지를 사람이 고칠 수 있는 문장으로 바꾼다.
   가장 흔한 원인은 "SQL 을 아직 안 돌렸다" 인데, PostgREST 원문은 그걸 알려주지 않는다.
   ---------------------------------------------------------------------- */
export function crmErrorHint(msg: string): string {
  const m = String(msg || '');
  if (/does not exist|schema cache|PGRST205|relation .* not found/i.test(m)) {
    return `${m}\n\n→ Supabase SQL Editor 에서 sql/2026-08_apply_attendance_v2.sql → sql/2026-08_crm.sql 을 실행했는지 확인하세요.`;
  }
  return m;
}

/** 근거(jsonb)에서 화면에 보여줄 칩 문자열들을 뽑는다. */
export function evidenceChips(m: Pick<CrmMessage, 'rule_id' | '근거'>): string[] {
  const e = (m.근거 || {}) as Record<string, unknown>;
  const n = (k: string) => (e[k] == null ? null : String(e[k]));
  switch (m.rule_id) {
    case 'milestone':
      return [
        `누적 ${n('누적횟수') ?? '?'}회`,
        `${n('마일스톤') ?? '?'}회차`,
        // 회차는 사실 단언이라 예약 스냅샷의 실제 출석 수와 대조한 뒤 보낸다(verifyMilestone).
        // 그 대조값을 같이 보여 준다 — 현장에서 "이 숫자 맞아?" 를 되짚을 수 있어야 한다.
        e.관측출석 == null ? '' : `출석기록 ${n('관측출석')}회`,
        e.행수 != null && e.등록건수 != null && Number(e.행수) !== Number(e.등록건수)
          ? `중복행 ${Number(e.행수) - Number(e.등록건수)}건 접음`
          : '',
        e.소급 ? '소급' : '',
      ].filter(Boolean);
    case 'expiring':
      return [
        `잔여 ${n('잔여횟수') ?? '?'}/${n('전체횟수') ?? '?'}`,
        `${n('수강권종료일') ?? ''} 만료`,
        `${n('남은일') ?? '?'}일 남음`,
      ].filter(Boolean);
    case 'first-paid':
      return [`전체 ${n('전체횟수') ?? '?'}회`, e.체험이력 ? '체험 이력 있음' : ''].filter(Boolean);
    case 'trial':
      return [`체험 누적 ${n('체험누적') ?? '0'}건`];
    default:
      return Object.entries(e)
        .filter(([k]) => k !== '그날회차')
        .slice(0, 3)
        .map(([k, v]) => `${k} ${v}`);
  }
}
