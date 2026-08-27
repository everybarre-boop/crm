// ============================================================================
// CRM 자동화의 DB 접근층 (PostgREST + RLS. service_role 미사용)
// ----------------------------------------------------------------------------
// 관리자 계정으로 로그인한 JWT 로만 접근한다 — 앱과 완전히 같은 보안 모델이다.
//
// RPC 는 save_reservations 하나만 쓴다. res_key 공식이 코드와 DB 로 갈라지면
// "전량 중복"이 나기 때문에(dedup_key 로 두 번 겪은 사고), 그 계산만 DB 안에 둔다.
// 나머지 crm_* 테이블은 평범한 upsert 로 충분하다.
// ============================================================================
import { getAdminClient } from './apply.mjs';
import { env } from './config.mjs';

export const T = {
  members: 'members',
  reservations: 'reservations',
  rules: 'crm_rules',
  messages: 'crm_messages',
  dormant: 'crm_dormant',
  posts: 'crm_slack_posts',
  runs: 'daily_runs',
  lastAttendance: 'crm_last_attendance',
  attendance: 'crm_attendance',
  historyDepth: 'crm_history_depth',
};

const PAGE = 1000;
const CHUNK = 500; // upsert 1회당 행 수

/* ----------------------------------------------------------------------
   전체 스캔 페이징.
   ⚠️ 반드시 정렬을 건다. ORDER BY 없는 LIMIT/OFFSET 은 페이지 사이에 같은 행이 두 번
      나오거나 빠질 수 있고, 그러면 1인 합산 누적 횟수가 조용히 부풀어 마일스톤이 틀린다.
      (lib/members.ts 의 fetchAllRows 와 같은 이유·같은 규칙)
   ---------------------------------------------------------------------- */
async function fetchAll(sb, table, select, { orderBy = ['id'], cap = 60000 } = {}) {
  let from = 0;
  const out = [];
  while (from < cap) {
    let q = sb.from(table).select(select);
    for (const col of orderBy) q = q.order(col, { ascending: true });
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} 조회 실패: ${error.message}`);
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

function chunk(arr, n = CHUNK) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/* ==========================================================================
   예약 스냅샷
   ========================================================================== */
export async function saveReservations(records, { branch, targetDate, dryRun }) {
  const sb = await getAdminClient();
  const { data, error } = await sb.rpc('save_reservations', {
    records,
    branch,
    target_date: targetDate,
    dry_run: dryRun,
  });
  if (error) throw new Error(`save_reservations 실패(${branch}): ${error.message}`);
  return data; // { requested, usable, saved, skipped, dry_run, branch, target_date }
}

/* ==========================================================================
   CRM 규칙 엔진의 입력 모으기
   ========================================================================== */
export async function fetchRules() {
  const sb = await getAdminClient();
  const { data, error } = await sb.from(T.rules).select('*').order('정렬순서', { ascending: true });
  if (error) throw new Error(`crm_rules 조회 실패: ${error.message}`);
  return data || [];
}

export async function fetchCrmInputs() {
  const sb = await getAdminClient();

  const [memberRows, lastAttendance, sentHistory, depth] = await Promise.all([
    // dedup_key 는 동명이인+연락처 빈 행을 행 단위로 쪼개는 데 필요하다(빼면 서로 다른
    // 사람이 한 명으로 뭉친다). 반드시 select 에 포함할 것.
    fetchAll(
      sb,
      T.members,
      'dedup_key,이름,연락처,수강권명,전체횟수,잔여횟수,수강권시작일,수강권종료일,결제일시',
    ),
    fetchAll(sb, T.lastAttendance, '이름,연락처,마지막출석일,출석횟수,마지막지점', {
      orderBy: ['이름', 'phone_digits'],
    }),
    // 억제 판정용 — 마일스톤은 "평생 1회"라 전 기간이 필요하다. 컬럼 4개뿐이라 가볍다.
    fetchAll(sb, T.messages, 'person_key,rule_id,규칙키,대상일자', { orderBy: ['id'] }),
    sb.from(T.historyDepth).select('*').maybeSingle(),
  ]);

  if (depth.error) throw new Error(`crm_history_depth 조회 실패: ${depth.error.message}`);

  return {
    memberRows,
    lastAttendance,
    sentHistory,
    historyDays: Number(depth.data?.관측일수 ?? 0),
    // 마일스톤 교차검증용 — 이 날짜 이후 등록자는 전 이력이 예약 스냅샷 안에 있다
    historyStart: String(depth.data?.이력시작일 ?? '').slice(0, 10),
  };
}

/* ==========================================================================
   CRM 멘트 저장
   ---------------------------------------------------------------------------
   ⚠️ payload 에 발송여부/발송시각/slack_ts/실행여부(피드백) 를 **넣지 않는다.**
      PostgREST 의 upsert 는 "payload 에 있는 컬럼만" SET 하므로, 빼 두면
      · insert 시 → 기본값
      · update 시 → 기존 값 유지
      가 된다. 즉 재실행해도 이미 보낸 표시와 강사 피드백이 날아가지 않는다.
   ========================================================================== */
export async function saveCrmMessages(messages, { dryRun }) {
  if (dryRun || !messages.length) return [];
  const sb = await getAdminClient();
  const now = new Date().toISOString();
  const rows = messages.map((m) => ({
    대상일자: m.대상일자,
    지점: m.지점 || '',
    rule_id: m.rule_id,
    규칙키: m.규칙키 || '',
    person_key: m.person_key,
    이름: m.이름 || '',
    연락처: m.연락처 || '',
    수업시간: m.수업시간 || '',
    수업명: m.수업명 || '',
    강사: m.강사 || '',
    수강권명: m.수강권명 || '',
    멘트: m.멘트 || '',
    예시멘트: m.예시멘트 || '',
    근거: m.근거 || {},
    updated_at: now,
  }));

  const saved = [];
  for (const part of chunk(rows)) {
    const { data, error } = await sb
      .from(T.messages)
      .upsert(part, { onConflict: '대상일자,지점,person_key,rule_id,규칙키' })
      .select('id,대상일자,지점,rule_id,규칙키,person_key,이름,수업시간,수업명,수강권명,멘트,예시멘트,근거,발송여부');
    if (error) throw new Error(`crm_messages 저장 실패: ${error.message}`);
    saved.push(...(data || []));
  }
  return saved;
}

/** 휴면 명단 — 사람당 1행. 오늘 안 잡힌 사람은 지운다(= 휴면 해제). */
export async function saveDormant(rows, { today, dryRun }) {
  if (dryRun) return { saved: 0, cleared: 0 };
  const sb = await getAdminClient();
  const now = new Date().toISOString();

  /* ⚠️ "최초감지일"을 payload 에 넣지 않는 것이 핵심이다 — 넣으면 매일 오늘 날짜로
        덮여서 "얼마나 오래 휴면인지"를 잃는다. 빼면 insert 시에만 default 가 박힌다. */
  const payload = rows.map((d) => ({
    person_key: d.person_key,
    이름: d.이름 || '',
    연락처: d.연락처 || '',
    마지막출석일: d.마지막출석일 || null,
    마지막지점: d.마지막지점 || '',
    경과일: d.경과일 ?? 0,
    잔여합: d.잔여합 ?? 0,
    보유수강권: d.보유수강권 || [],
    갱신일: today,
    updated_at: now,
  }));

  let saved = 0;
  for (const part of chunk(payload)) {
    const { data, error } = await sb
      .from(T.dormant)
      .upsert(part, { onConflict: 'person_key' })
      .select('person_key');
    if (error) throw new Error(`crm_dormant 저장 실패: ${error.message}`);
    saved += data?.length ?? 0;
  }

  const { data: gone, error: delErr } = await sb
    .from(T.dormant)
    .delete()
    .lt('갱신일', today)
    .select('person_key');
  if (delErr) throw new Error(`crm_dormant 정리 실패: ${delErr.message}`);

  return { saved, cleared: gone?.length ?? 0 };
}

/* ==========================================================================
   슬랙 발송 결과 반영
   ========================================================================== */
export async function markMessagesSent(ids, { ts, error = null, dryRun }) {
  if (dryRun || !ids.length) return 0;
  const sb = await getAdminClient();
  let n = 0;
  for (const part of chunk(ids, 200)) {
    const { data, error: e } = await sb
      .from(T.messages)
      .update({
        발송여부: !error,
        발송시각: new Date().toISOString(),
        slack_ts: ts || null,
        발송오류: error ? String(error).slice(0, 500) : null,
        updated_at: new Date().toISOString(),
      })
      .in('id', part)
      .select('id');
    if (e) throw new Error(`crm_messages 발송상태 갱신 실패: ${e.message}`);
    n += data?.length ?? 0;
  }
  return n;
}

/** 지점·일자별 슬랙 메시지 1건. 이미 있으면 그 ts 로 chat.update 한다. */
export async function getSlackPost({ targetDate, branch, kind = 'daily' }) {
  const sb = await getAdminClient();
  const { data, error } = await sb
    .from(T.posts)
    .select('*')
    .eq('대상일자', targetDate)
    .eq('지점', branch)
    .eq('종류', kind)
    .maybeSingle();
  if (error) throw new Error(`crm_slack_posts 조회 실패: ${error.message}`);
  return data;
}

export async function upsertSlackPost(row, { dryRun }) {
  if (dryRun) return null;
  const sb = await getAdminClient();
  const { data, error } = await sb
    .from(T.posts)
    .upsert({ ...row, updated_at: new Date().toISOString() }, { onConflict: '대상일자,지점,종류' })
    .select('*')
    .maybeSingle();
  if (error) throw new Error(`crm_slack_posts 저장 실패: ${error.message}`);
  return data;
}

/* ==========================================================================
   실행 로그 (apply_attendance / save_reservations 는 RPC 안에서 스스로 남긴다.
   crm·slack 단계는 여기서 남긴다 → 자동화 로그 화면이 파이프라인 전체를 한 표로 본다)
   ========================================================================== */
export async function logRun({
  단계,
  대상일자 = null,
  지점 = null,
  dryRun,
  요청건수 = 0,
  반영건수 = 0,
  미매칭 = [],
}) {
  const sb = await getAdminClient();
  const { error } = await sb.from(T.runs).insert({
    단계,
    대상일자,
    지점,
    dry_run: dryRun,
    요청건수,
    반영건수,
    미매칭,
    created_by: env.ADMIN_EMAIL || null,
  });
  if (error) throw new Error(`daily_runs 기록 실패: ${error.message}`);
}

/* ==========================================================================
   출석 수 — 스튜디오메이트 회원 페이지가 직접 센 값 (회차·마일스톤의 근거)
   --------------------------------------------------------------------------
   `전체횟수 − 잔여횟수`(차감된 횟수)를 대체한다. 배경: docs/NEXT-attendance-count.md
   ⚠️ **사이트별**이다(지점=사이트). 사람 값은 사이트별 행을 더해서 낸다.
   ========================================================================== */

/** 오늘 이미 읽은 (site, 회원id) — 재실행 때 다시 읽지 않기 위한 것.
    21:00 실패 후 22:30 재실행이 120명을 또 읽으면 그만큼 늦어진다(멱등성 + 비용). */
export async function fetchAttendanceFresh(today) {
  const sb = await getAdminClient();
  const { data, error } = await sb
    .from(T.attendance)
    .select('site,회원id')
    .eq('기준일', today);
  if (error) throw new Error(`crm_attendance 조회 실패: ${error.message}`);
  return new Set((data || []).map((r) => `${r.site}\u0000${r.회원id}`));
}

/** 규칙 평가에 넘길 행 전체. 사람×사이트 1행이라 members 보다 훨씬 작다. */
export async function fetchAttendanceRows() {
  const sb = await getAdminClient();
  return fetchAll(sb, T.attendance, 'person_key,site,회원id,이름,기준일,출석수,결석수', {
    orderBy: ['id'],
  });
}

/* 기준일 이후 보정용 예약 행.
   ⚠️ reservations 는 하루 300~800행씩 쌓인다 — 전량 스캔 금지(CLAUDE.md).
      반드시 from 이후로 끊는다. from 이 없으면 아예 읽지 않는다. */
export async function fetchReservationsSince(from) {
  if (!from) return [];
  const sb = await getAdminClient();
  const out = [];
  let start = 0;
  while (start < 60000) {
    const { data, error } = await sb
      .from(T.reservations)
      .select('person_key,이름,연락처,지점,예약일자,예약상태')
      .gte('예약일자', from)
      .order('id', { ascending: true })
      .range(start, start + PAGE - 1);
    if (error) throw new Error(`reservations 조회 실패: ${error.message}`);
    if (!data || !data.length) break;
    out.push(...data);
    if (data.length < PAGE) break;
    start += PAGE;
  }
  return out;
}

/**
 * 읽어 온 출석 수를 저장한다. (site, 회원id) 하나당 1행 — 매일 최신값으로 덮는다.
 * ⚠️ person_key·이름도 같이 덮는다: 회원이 개명하거나 연락처를 바꾸면 우리 쪽 조인 키가
 *    바뀌는데, 스튜디오메이트 회원 id 는 그대로다. id 를 기준으로 최신 이름을 따라간다.
 */
export async function saveAttendance(rows, { dryRun }) {
  if (dryRun || !rows.length) return 0;
  const sb = await getAdminClient();
  const now = new Date().toISOString();
  const payload = rows.map((r) => ({
    site: r.site,
    회원id: String(r.회원id),
    person_key: r.person_key || '',
    이름: r.이름 || '',
    기준일: r.기준일,
    출석수: r.출석 ?? 0,
    결석수: r.결석 ?? 0,
    노쇼수: r.노쇼 ?? 0,
    취소수: r.취소 ?? 0,
    예약수: r.예약 ?? 0,
    전체수: r.전체 ?? 0,
    읽은시각: now,
  }));
  let n = 0;
  for (const part of chunk(payload)) {
    const { data, error } = await sb
      .from(T.attendance)
      .upsert(part, { onConflict: 'site,회원id' })
      .select('id');
    if (error) throw new Error(`crm_attendance 저장 실패: ${error.message}`);
    n += (data || []).length;
  }
  return n;
}
