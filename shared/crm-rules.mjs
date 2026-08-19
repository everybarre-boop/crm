/* ============================================================================
   CRM 규칙 엔진 — "누구에게 어떤 멘트인가"를 결정하는 두뇌
   ----------------------------------------------------------------------------
   ⛔️ 이 파일도 import 는 crm-core.mjs 하나뿐이다. DB·네트워크·파일 접근 금지.
      순수 함수라서 `node --test` 로 경계값을 그대로 검증할 수 있고, 앱 화면에서
      "규칙을 이렇게 바꾸면 내일 몇 명이 잡히나" 시뮬레이션에도 같은 함수를 쓴다.

   왜 SQL 이 아니라 JS 인가 — makePersonResolver 의 "연락처 빈 행 / 동명이인" 처리를
   SQL 로 재구현하면 "코드가 만드는 값 ↔ DB 가 만드는 값"이 어긋난다. 이 저장소가
   dedup_key 로 두 번 겪은 사고와 같은 구조다(CLAUDE.md). 그래서 판정 로직은 여기에만 둔다.
   SQL 이 맡는 건 ① 멱등 저장 ② 값싼 사전 집계(마지막 출석일 max) ③ 권한 검증뿐이다.
   ============================================================================ */
import {
  addDays,
  daysBetween,
  dedupeTicketRows,
  isTrial,
  isUsableTicket,
  makePersonResolver,
  normPersonName,
  personKey,
  pickTicketRow,
  renderTemplate,
  toInt,
  usageAudit,
  usedCount,
  ymdNum,
} from './crm-core.mjs';

/* crm_rules 테이블이 비었을 때의 기본값.
   ⚠️ sql/2026-08_crm.sql 의 seed 와 같은 값을 유지할 것(둘 다 고칠 것). */
export const DEFAULT_RULES = [
  {
    id: 'milestone', 라벨: '마일스톤', 이모지: '🎉', 활성: true, 슬랙발송: true,
    정렬순서: 10, 재발송억제일수: -1,
    /* 소급허용=false — 정확히 마일스톤 회차일 때만 보낸다.
       true 로 두면 "이미 지난 마일스톤"을 뒤늦게 축하하는데, 문구가 "오늘로 N번째
       수업이에요"라 **사실과 다른 말**이 된다(실측: 누적 51회 회원에게 "50번째 수업").
       특히 도입 첫날은 발송 이력이 없어 과거 마일스톤이 전부 소급으로 터진다.
       대신 스크랩이 하루 빠지면 그 회차는 놓친다(월 1회 수준). */
    /* 교차검증=true — 회차는 **사실 단언**이라 members 값 하나만 믿고 보내지 않는다.
       예약 스냅샷(reservations)의 실제 출석 수와 대조해 모순이면 보류한다. 아래 verifyMilestone 참고.
       끄면 members 값만으로 발송한다(스크랩이 오래 멈춰 보류가 쌓일 때의 탈출구). */
    파라미터: {
      마일스톤: [10, 30, 50, 100, 150, 200, 300, 500], 소급허용: false, 소급한도: 10,
      교차검증: true,
    },
    템플릿: '*{{마일스톤}}회차!* (누적 {{누적횟수}}회)',
    예시멘트: '{{이름}}님, 오늘로 {{마일스톤}}번째 수업이에요! 꾸준히 나오시는 게 정말 대단해요 👏',
  },
  {
    id: 'trial', 라벨: '체험', 이모지: '🌱', 활성: true, 슬랙발송: true,
    // 제외키워드: "체험 후 1회권" 처럼 체험을 마치고 산 유료 수강권을 체험으로 세지 않는다
    // 정렬순서 40 — 가장 이른 단계라 우선순위가 가장 낮다(아래 "1인 1건" 설명 참고)
    정렬순서: 40, 재발송억제일수: 0, 파라미터: { 제외키워드: ['체험 후'] },
    템플릿: '체험 수업 · {{수강권명}}',
    예시멘트: '{{이름}}님, 처음 오셨죠? 동작이 어려우면 언제든 편하게 말씀해 주세요. 끝나고 궁금한 점도 여쭤볼게요!',
  },
  {
    id: 'first-paid', 라벨: '신규 등록 첫 수업', 이모지: '✨', 활성: true, 슬랙발송: true,
    /* 최대누적 — "이 수강권을 처음 쓴다"만 보면 **재등록한 기존 회원이 전부 걸린다**
       (실측: 누적 51회 회원이 '신규 등록 첫 수업'으로 잡혔다). 체험 직후의 진짜 신규만
       잡으려면 전 지점 합산 누적도 함께 봐야 한다.

       🔥 언리밋 계열은 멘트를 따로 쓴다. 기본 문구는 "앞으로 {{전체횟수}}회" 인데,
          반포 '바레 그룹 언리밋권'·송파 '언리밋티드' 는 전체횟수가 **비어 있어서**
          "앞으로 **0회** 같이 만들어가요" 로 나갔다(2026-08-13 dry-run 실측 2건).
          언리밋키워드는 수강권명 기준이다 — 운영에서 "언리밋이라고 적힌 수강권"이
          곧 30일권을 뜻하기 때문이다(전체횟수는 30이거나 비어 있다). */
    정렬순서: 30, 재발송억제일수: -1,
    파라미터: {
      체험이력필수: true,
      최대누적: 3,
      언리밋키워드: ['언리밋', '언리미티드', '언리밋티드', 'Unlimited', 'unlimited'],
      언리밋멘트: '{{이름}}님, 언리밋 등록 대박이에요! 멋있어요! 앞으로 더 자주 뵐게요 😊',
    },
    템플릿: '체험 후 등록하고 첫 수업 · {{수강권명}}',
    예시멘트: '{{이름}}님, 등록해 주셔서 정말 반가워요! 앞으로 {{전체횟수}}회 같이 만들어가요 😊',
  },
  {
    id: 'expiring', 라벨: '만료 임박', 이모지: '⏳', 활성: true, 슬랙발송: true,
    정렬순서: 20, 재발송억제일수: 7, 파라미터: { 만료임박일: 7, 잔여비율: 0.3 },
    템플릿: '잔여 {{잔여횟수}}/{{전체횟수}}회 · {{수강권종료일}} 만료({{남은일}}일 남음)',
    예시멘트: '{{이름}}님, 수강권이 {{수강권종료일}}에 끝나는데 아직 {{잔여횟수}}회 남으셨어요. 추가 등록하시면 남은 횟수는 그대로 이월돼요!',
  },
  {
    id: 'dormant-14', 라벨: '14일 미방문', 이모지: '🕰️', 활성: true, 슬랙발송: false,
    정렬순서: 50, 재발송억제일수: 0, 파라미터: { 휴면일: 14 },
    템플릿: '마지막 출석 {{마지막출석일}} ({{경과일}}일 전) · 잔여 {{잔여합}}회',
    예시멘트: '',
  },
];

/* 내일 그 수업에 **실제로 오지 않는** 예약상태 — CRM 대상에서 뺀다.
   ⚠️ '예약대기'가 여기 있어야 한다. 만석 수업의 대기자는 아직 자리가 없는데,
      빼지 않으면 "내일 봬요" 계열 멘트가 그대로 나간다(실측: 판교 19:00 대기 3명).
      과거엔 스크래퍼가 "예약 대기 (1)"을 '예약'으로 정규화해서 이 필터로도 못 걸렀다
      — normalize.mjs 의 STATUS_RULES 와 짝이다. 둘 중 하나만 고치면 새는 자리다. */
const NOT_ATTENDING = new Set(['취소', '노쇼', '예약대기']);

/* ----------------------------------------------------------------------
   "진짜 체험권"인가.
   ⚠️ isTrial() 은 수강권명에 '체험'이 들어가면 참인데, 실제 데이터에는
      **"체험 후 1회권 (판교)"** 처럼 *체험을 마치고 산 유료 수강권*이 있다.
      이걸 체험으로 보면 ① 체험 멘트가 잘못 나가고 ② 신규 등록 첫 수업(first-paid)이
      영영 안 걸린다. 그래서 제외 키워드로 걸러낸다.
   isTrial 자체는 건드리지 않는다 — 대시보드의 체험 집계가 과거와 달라지면 안 된다.
   제외 키워드는 crm_rules.파라미터 라 화면에서 고칠 수 있다.
   ---------------------------------------------------------------------- */
function isTrialTicket(수강권명, excludes) {
  const name = String(수강권명 ?? '');
  if (!isTrial({ 수강권명: name })) return false;
  return !(excludes || []).some((k) => k && name.includes(k));
}

/* ⚠️ DB(crm_rules)에 **없는 파라미터 키**는 코드 기본값으로 채운다.
      규칙 행은 화면에서 편집되므로, 새 파라미터를 코드에 추가해도 이미 저장된 행에는
      그 키가 없다. 채워 주지 않으면 새 기능이 조용히 꺼진 채로 배포된다.
      값이 **있는** 키는 DB 가 이긴다(빈 배열 `[]` 도 값이다 — 되살리지 않는다). */
function ruleMap(rules) {
  const src = rules && rules.length ? rules : DEFAULT_RULES;
  const byId = new Map(DEFAULT_RULES.map((d) => [d.id, d]));
  const m = new Map();
  for (const r of src) {
    const d = byId.get(r.id);
    m.set(r.id, {
      ...(d || {}),
      ...r,
      파라미터: { ...((d && d.파라미터) || {}), ...(r.파라미터 || {}) },
    });
  }
  // 테이블에 없는 규칙은 기본값으로 채운다(SQL seed 를 아직 안 돌린 경우)
  for (const d of DEFAULT_RULES) if (!m.has(d.id)) m.set(d.id, d);
  return m;
}

/* "언리밋 계열" 판정 — 수강권명 기준.
   운영 정의(2026-08-13): "언리밋이라고 적힌 수강권"은 **30일 동안 30회**가 발행되고
   기간이 지나면 잔여가 소멸한다. 즉 이름이 곧 상품 종류다.
   실측: 이름에 언리밋이 든 1,147행 중 1,100행은 전체횟수 30 · 47행은 전체횟수 없음. */
function isUnlimitedTicket(수강권명, keywords) {
  const name = String(수강권명 ?? '');
  return (keywords || []).some((k) => k && name.includes(k));
}

/* ----------------------------------------------------------------------
   마일스톤 교차검증 — "N회차예요"는 **사실 단언**이다. 틀리면 현장에서 회원에게
   다른 사실로 응대하게 되고, 그건 안 보내느니만 못하다.

   members(엑셀 업로드 + 야간 apply_attendance)와 reservations(매일 스크랩한 실제 출석)는
   서로 독립적인 두 기록이다. 둘이 **모순**이면 어느 쪽이 맞는지 알 수 없으므로 보내지 않는다.
   반환값 = 보류 사유(문자열) / 이상 없으면 null.

     ① 전체횟수 결손        "몇 회짜리 수강권인지"를 모르면 사용횟수(전체−잔여)도 모른다.
     ② 시작일 결손          등록건을 구분할 수 없다 → 중복 행을 접었는지 보장 못 한다.
     ③ 출석기록 > 누적      members 가 뒤처졌다(매칭 실패·업로드 지연). 회차를 **낮게** 부른다.
     ④ 전 이력 관측 + 불일치
        회원의 첫 수강권시작일이 예약 스냅샷 시작일 이후면, 그 사람이 다닌 모든 수업이
        스냅샷 안에 있어야 한다. 그런데 수가 다르면 스크랩 누락이거나 members 가 부풀려진
        것이다 — 어느 쪽이든 회차를 단언할 근거가 없다.
        (실측 2026-08-19: 전 이력 관측 188명 중 167명 일치 · 21명 불일치)

   ⛔️ "관측이 적으니 관측 쪽을 쓰자"로 가지 말 것. 스크랩이 하루 빠지면 관측도 낮아진다.
      둘 다 못 믿을 때 지어낸 숫자를 보내는 것이 이 규칙이 막으려는 바로 그 사고다.
   ---------------------------------------------------------------------- */
export function verifyMilestone({ audit, 관측출석 = 0, 관측시작 = null }) {
  if (audit.결손) return '전체횟수가 빈 수강권이 있어 사용횟수를 확정할 수 없습니다';
  if (audit.시작일결손) return '수강권시작일이 없어 중복 등록건을 구분할 수 없습니다';
  if (관측출석 > audit.누적)
    return `출석 기록(${관측출석}회)이 회원 데이터(${audit.누적}회)보다 많습니다 — 회원 데이터가 뒤처졌습니다`;
  const 전이력관측 =
    관측시작 !== null && audit.최초시작일 !== null && audit.최초시작일 >= 관측시작;
  if (전이력관측 && 관측출석 !== audit.누적)
    return `전 이력이 관측 구간 안인데 출석 기록(${관측출석}회)과 회원 데이터(${audit.누적}회)가 다릅니다`;
  return null;
}

/* ----------------------------------------------------------------------
   재발송 억제.
   ⚠️ `대상일자 !== targetDate` 조건이 핵심이다. 이게 없으면 같은 날 재실행할 때
      1차 실행에서 발송된 **자기 자신**이 억제 근거가 되어 메시지가 통째로 사라진다.
      (21:00 실패 → 22:00 재실행이 안전해야 한다)
   재발송억제일수: 0=억제 없음 / -1=평생 1회 / n=최근 n일 안에 보냈으면 억제
   ---------------------------------------------------------------------- */
function makeSuppressor(sentHistory, targetDate) {
  const byKey = new Map(); // `${person}\u0000${rule}\u0000${규칙키}` → [대상일자...]
  for (const s of sentHistory || []) {
    const k = `${s.person_key}\u0000${s.rule_id}\u0000${s.규칙키 ?? ''}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(s.대상일자);
  }
  return (person, ruleId, 규칙키, 억제일수) => {
    if (!억제일수) return false; // 0 → 억제 없음
    const dates = byKey.get(`${person}\u0000${ruleId}\u0000${규칙키 ?? ''}`);
    if (!dates) return false;
    for (const d of dates) {
      if (d === targetDate) continue; // 같은 날 재실행분은 억제 근거가 아니다
      if (억제일수 < 0) return true; // 평생 1회
      const gap = daysBetween(d, targetDate);
      if (gap !== null && gap >= 0 && gap <= 억제일수) return true;
    }
    return false;
  };
}

/* ----------------------------------------------------------------------
   buildCrm — 내일(targetDate) 예약자에게 붙일 멘트와 휴면 명단을 만든다.

   입력
     memberRows      members 전량 (dedup_key·이름·연락처·수강권명·전체횟수·잔여횟수·
                     수강권시작일·수강권종료일·결제일시)
     rosterRows      targetDate 예약자 (reservations 레코드 형태)
     lastAttendance  crm_last_attendance 뷰 행
     sentHistory     crm_messages 중 발송된 것 [{person_key, rule_id, 규칙키, 대상일자}]
     rules           crm_rules 행 (비면 DEFAULT_RULES)
     today           'YYYY-MM-DD' (KST). 만료 임박·휴면 계산의 기준
     targetDate      'YYYY-MM-DD' = D+1
     historyDays     예약 스냅샷 관측 일수 (crm_history_depth.관측일수)
     historyStart    예약 스냅샷 최초일 'YYYY-MM-DD' (crm_history_depth.이력시작일).
                     이 날짜 이후에 등록한 회원은 **전 이력이 관측 안에 있다** → 마일스톤
                     회차를 실제 출석 기록과 정확히 대조할 수 있다.

   출력 { messages, dormant, stats, warnings }
   ---------------------------------------------------------------------- */
export function buildCrm({
  memberRows = [],
  rosterRows = [],
  lastAttendance = [],
  sentHistory = [],
  rules = [],
  today,
  targetDate,
  historyDays = 0,
  historyStart = '',
}) {
  const R = ruleMap(rules);
  const warnings = [];
  const messages = [];
  const suppressed = makeSuppressor(sentHistory, targetDate);

  /* 동일인 판정 — 세 데이터셋을 한 resolver 에 넣어야 같은 기준으로 묶인다.
     (판교 이가원 · 반포 이가원이 한 사람이 되는 자리) */
  const keyOf = makePersonResolver(memberRows, rosterRows, lastAttendance);

  // 사람별 members 행
  const memByPerson = new Map();
  for (const m of memberRows) {
    const k = keyOf(m);
    if (!memByPerson.has(k)) memByPerson.set(k, []);
    memByPerson.get(k).push(m);
  }

  /* 전 지점 합산 누적 사용횟수 — ⛔️ 행을 그냥 더하지 않는다.
     같은 수강권 한 장이 이름 표식('구태희' / '구태희 미수금')과 결제 분할 때문에 여러 행으로
     남고, 그 행들이 **같은 잔여횟수를 각자 들고 있다**. 행 합은 한 번 나온 수업을 2~3번 센다
     (실측 2026-08-14: 구태희 9회 → 실제 4회, 583명이 부풀려져 있었다).
     공식은 crm-core 의 usageAudit 한 곳에만 둔다 — 화면(회원 관리·회원 요약)도 같은 함수를 쓴다. */
  const auditByPerson = new Map();
  for (const [k, rows] of memByPerson) auditByPerson.set(k, usageAudit(rows));

  // 사람별 마지막 출석 + 관측된 실제 출석 수(마일스톤 교차검증의 근거)
  const lastByPerson = new Map();
  const 관측출석By = new Map();
  for (const a of lastAttendance) {
    const k = keyOf(a);
    const prev = lastByPerson.get(k);
    if (!prev || String(a.마지막출석일) > String(prev.마지막출석일)) lastByPerson.set(k, a);
    /* 뷰(crm_last_attendance)는 **표식이 붙은 이름을 따로** 묶으므로 한 사람이 여러 행일 수
       있다. 각 행의 예약 집합은 서로 겹치지 않으니 더해도 이중 계수가 아니다. */
    관측출석By.set(k, (관측출석By.get(k) ?? 0) + toInt(a.출석횟수));
  }
  const 관측시작 = ymdNum(historyStart);

  /* ── 예약자 정리 ────────────────────────────────────────────────────
     취소/노쇼/예약대기는 대상이 아니다. 같은 사람이 내일 여러 수업이면 시간 순으로 세어
     "그날 몇 번째 수업"을 만든다(마일스톤 회차 계산). */
  const roster = rosterRows
    .filter((r) => !NOT_ATTENDING.has(String(r.예약상태 ?? '')))
    .map((r, i) => ({ ...r, _i: i }))
    .sort((a, b) => String(a.수업시간).localeCompare(String(b.수업시간)) || a._i - b._i);

  const seq = new Map(); // person → 그날 몇 번째
  let noPhone = 0;
  let noMember = 0;
  const 보류 = []; // 교차검증에서 걸린 마일스톤 — 보내지 않고 경고로 남긴다
  let 결손 = 0; // 전체횟수가 없는데 언리밋도 아닌 신규 등록 — 멘트를 보내지 않는다

  for (const r of roster) {
    const k = keyOf(r);
    const nth = (seq.get(k) ?? 0) + 1;
    seq.set(k, nth);

    const mem = memByPerson.get(k) || [];
    if (!mem.length) noMember++;

    /* 연락처는 반드시 채운다 — crm_messages 에는 dedup_key 가 없어서, 비어 있으면
       CRM 성과 화면의 sales 조인(makePersonResolver)이 이 행을 아무와도 못 붙인다. */
    const 연락처 =
      String(r.연락처 ?? '').trim() ||
      String(mem.find((m) => String(m.연락처 ?? '').trim())?.연락처 ?? '');
    if (!연락처) noPhone++;

    const base = {
      대상일자: targetDate,
      지점: r.지점 || '',
      person_key: k,
      // 표시용 이름도 표식을 뗀다 — 슬랙에 "손정미 미수금님, …" 으로 나가면 안 된다
      이름: normPersonName(r.이름),
      연락처,
      수업시간: r.수업시간 || '',
      수업명: r.수업명 || '',
      강사: r.강사 || '',
      수강권명: r.수강권명 || '',
    };

    /* 이 예약의 수강권에 해당하는 members 행 1개.
       ⚠️ 먼저 등록건별로 접는다(dedupeTicketRows) — 같은 등록건의 중복 행 중 **옛 잔여를 든
          행**이 뽑히면 '신규 등록 첫 수업'(사용횟수 0 조건)이 이미 다닌 회원에게 나간다. */
    const ticket = pickTicketRow(dedupeTicketRows(mem.filter((m) => m.수강권명 === r.수강권명)));
    const audit = auditByPerson.get(k) || usageAudit([]);
    const 누적횟수 = audit.누적;

    const vars = {
      이름: base.이름,
      지점: base.지점,
      수업시간: base.수업시간,
      수업명: base.수업명,
      수강권명: base.수강권명,
      누적횟수,
      전체횟수: ticket ? toInt(ticket.전체횟수) : '',
      잔여횟수: ticket ? toInt(ticket.잔여횟수) : '',
      수강권종료일: ticket ? ticket.수강권종료일 ?? '' : '',
    };

    /* 예시멘트대체 — 같은 규칙 안에서 상황에 따라 문구를 바꿔야 할 때만 쓴다
       (지금은 first-paid 의 언리밋 분기 하나뿐). 비우면 규칙의 예시멘트를 그대로 쓴다. */
    const push = (ruleId, 규칙키, extraVars, 근거, 예시멘트대체) => {
      const rule = R.get(ruleId);
      if (!rule || !rule.활성) return;
      if (suppressed(k, ruleId, 규칙키, rule.재발송억제일수)) return;
      const v = { ...vars, ...extraVars };
      messages.push({
        ...base,
        rule_id: ruleId,
        규칙키: String(규칙키 ?? ''),
        멘트: renderTemplate(rule.템플릿, v),
        예시멘트: renderTemplate(예시멘트대체 || rule.예시멘트, v),
        근거: { ...근거, 그날회차: nth },
      });
    };

    // ── ① 마일스톤 (전 지점 합산 누적) ─────────────────────────────
    if (nth === 1 && mem.length) {
      // 내일 여러 수업이어도 가장 이른 수업 하나에만 붙인다
      const p = R.get('milestone').파라미터 || {};
      const list = (p.마일스톤 || []).slice().sort((a, b) => a - b);
      const 예정회차 = 누적횟수 + 1;
      let hit = list.includes(예정회차) ? 예정회차 : null;
      if (hit === null && p.소급허용) {
        // 스크랩 누락으로 정확히 100 을 못 밟은 경우를 위한 소급 보정
        const 한도 = toInt(p.소급한도) || 0;
        const past = list.filter((mM) => mM < 예정회차 && 예정회차 - mM <= 한도);
        const cand = past.length ? past[past.length - 1] : null;
        if (cand !== null && !suppressed(k, 'milestone', String(cand), -1)) hit = cand;
      }
      if (hit !== null) {
        const 관측출석 = 관측출석By.get(k) ?? 0;
        const 검증 =
          p.교차검증 === false
            ? null
            : verifyMilestone({ audit, 관측출석, 관측시작 });
        if (검증) {
          보류.push({ 이름: normPersonName(r.이름), 회차: hit, 사유: 검증, 누적횟수, 관측출석 });
        } else {
          push('milestone', String(hit), { 마일스톤: hit, 누적횟수: 예정회차 }, {
            누적횟수: 누적횟수,
            예정회차,
            마일스톤: hit,
            소급: hit !== 예정회차,
            // 산출 근거를 남긴다 — 화면에서 "왜 이 숫자인가"를 되짚을 수 있어야 한다
            관측출석,
            등록건수: audit.등록건수,
            행수: audit.행수,
          });
        }
      }
    }

    // ── ② 체험 ─────────────────────────────────────────────────────
    // members 에 없어도(오늘 막 등록한 체험자) 발동해야 한다
    const 제외 = (R.get('trial').파라미터 || {}).제외키워드 || [];
    const 체험수업 = isTrialTicket(r.수강권명, 제외);
    if (체험수업) {
      push('trial', '', {}, {
        체험누적: mem.filter((m) => isTrialTicket(m.수강권명, 제외)).length,
      });
    }

    // ── ③ 신규 등록 첫 수업 (체험 후 횟수권 구매 → 첫 사용) ────────────
    if (!체험수업 && ticket) {
      const p = R.get('first-paid').파라미터 || {};
      const 체험이력 = mem.some((m) => isTrialTicket(m.수강권명, 제외));
      // 최대누적: 재등록한 기존 회원을 "신규"로 부르지 않기 위한 상한(전 지점 합산 기준)
      const 상한 = p.최대누적 == null ? Infinity : toInt(p.최대누적);
      if ((!p.체험이력필수 || 체험이력) && usedCount(ticket) === 0 && 누적횟수 <= 상한) {
        const 무제한 = isUnlimitedTicket(r.수강권명, p.언리밋키워드);
        const 전체 = toInt(ticket.전체횟수);
        const 근거 = {
          체험이력,
          누적횟수,
          전체횟수: 전체,
          수강권시작일: ticket.수강권시작일 ?? '',
          언리밋: 무제한,
        };
        if (무제한) {
          // 언리밋은 횟수를 말하지 않는다 — 전체횟수가 30 이든 비어 있든 문구가 같다
          push('first-paid', r.수강권명, {}, 근거, p.언리밋멘트);
        } else if (전체 > 0) {
          push('first-paid', r.수강권명, {}, 근거);
        } else {
          /* 🔥 전체횟수가 없는데 언리밋도 아니다 = **데이터 결손**이다.
             실측(2026-08-13): '바레 그룹 10회(청담)' 전체횟수 0 이 13행, 수강권명 자체가
             빈 행이 110행. 여기서 기본 문구를 쓰면 "앞으로 0회 같이 만들어가요" 가 나가고,
             언리밋 문구를 쓰면 10회권 회원에게 "언리밋 등록 대박이에요" 가 나간다.
             둘 다 틀린 말이라 **보내지 않는다**(운영 판단 2026-08-13). 사유는 아래 경고로. */
          결손++;
        }
      }
    }

    // ── ④ 만료 임박 (기한 7일 이내 + 잔여 30% 이상 → "이월 가능" 안내) ──
    if (ticket) {
      const p = R.get('expiring').파라미터 || {};
      const 만료임박일 = toInt(p.만료임박일) || 7;
      const 잔여비율 = Number(p.잔여비율 ?? 0.3);
      const 남은일 = daysBetween(today, ticket.수강권종료일);
      const 전체 = toInt(ticket.전체횟수);
      const 잔여 = toInt(ticket.잔여횟수);
      if (
        남은일 !== null && 남은일 >= 0 && 남은일 <= 만료임박일 &&
        전체 > 0 && 잔여 / 전체 >= 잔여비율
      ) {
        push('expiring', r.수강권명, { 남은일 }, {
          잔여횟수: 잔여, 전체횟수: 전체, 잔여비율: Math.round((잔여 / 전체) * 100) / 100,
          수강권종료일: ticket.수강권종료일 ?? '', 남은일,
        });
      }
    }
  }

  /* ── 1인 1건 ────────────────────────────────────────────────────────
     한 사람에게 여러 규칙이 걸리면 **가장 나중 단계 하나만** 보낸다.
     200회 다닌 회원에게 "신규 등록 첫 수업"이나 체험 멘트가 같이 나가면 안 되고,
     슬랙에 같은 사람이 섹션마다 반복되면 강사가 헷갈린다.
     우선순위 = crm_rules.정렬순서(작을수록 우선) → 화면에서 순서를 바꾸면 우선순위도 바뀐다.
       기본: 마일스톤(10) > 만료임박(20) > 신규(30) > 체험(40)
     같은 순위면 더 이른 수업을 남긴다. */
  const order = (id) => toInt(R.get(id)?.정렬순서 ?? 999);
  const bestByPerson = new Map();
  const dropped = [];
  for (const m of messages) {
    const prev = bestByPerson.get(m.person_key);
    const better =
      !prev ||
      order(m.rule_id) < order(prev.rule_id) ||
      (order(m.rule_id) === order(prev.rule_id) &&
        String(m.수업시간) < String(prev.수업시간));
    if (better) {
      if (prev) dropped.push(prev);
      bestByPerson.set(m.person_key, m);
    } else {
      dropped.push(m);
    }
  }
  const picked = [...bestByPerson.values()];
  if (dropped.length) {
    warnings.push(
      `1인 1건 규칙으로 ${dropped.length}건을 접었습니다(같은 사람에게 더 나중 단계 멘트가 있음).`,
    );
  }

  if (결손)
    warnings.push(
      `신규 등록 멘트 ${결손}건을 건너뛰었습니다 — 전체횟수가 비었는데 언리밋도 아닙니다(데이터 결손). ` +
        `회원 엑셀에서 그 수강권의 전체횟수를 채우면 다음 실행부터 나갑니다.`,
    );
  if (보류.length) {
    /* 🔐 경고는 운영 채널(슬랙)로도 나갈 수 있다 — 실명을 넣지 않는다(PII 는 건수까지). */
    const 사유별 = new Map();
    for (const b of 보류) 사유별.set(b.사유, (사유별.get(b.사유) ?? 0) + 1);
    warnings.push(
      `마일스톤 ${보류.length}건 보류 — 회차를 확정할 수 없어 보내지 않았습니다. ` +
        [...사유별].map(([사유, n]) => `${사유} ${n}건`).join(' · ') +
        `. CRM 실행 화면에서 회원 데이터를 확인하세요.`,
    );
  }
  if (noPhone) warnings.push(`연락처를 못 채운 예약 ${noPhone}건 — 결제 전환 집계에서 빠집니다.`);
  if (noMember) warnings.push(`members 에서 못 찾은 예약자 ${noMember}건 — 누적 횟수 기반 규칙이 적용되지 않습니다.`);

  /* ── ⑤ 14일 미방문 (슬랙 발송 X · 관리자 대시보드 명단만) ──────────────
     ⚠️ 예약 스냅샷 이력이 짧으면 전원이 "미방문"으로 잡힌다 → 규칙 자체를 잠근다.
        UI 는 crm_history_depth 로 같은 판단을 해서 배너를 띄운다. */
  const dormant = [];
  const dRule = R.get('dormant-14');
  const 휴면일 = toInt((dRule.파라미터 || {}).휴면일) || 14;
  if (!dRule.활성) {
    // 꺼져 있으면 아무것도 안 한다
  } else if (historyDays < 휴면일) {
    warnings.push(
      `14일 미방문 규칙 잠금 — 예약 스냅샷 관측 ${historyDays}일차(${휴면일}일부터 산출). ` +
        `${addDays(today, 휴면일 - historyDays)} 부터 명단이 나옵니다.`,
    );
  } else {
    for (const [k, rows] of memByPerson) {
      /* 등록건별로 접고 센다 — 접지 않으면 중복 행 때문에 잔여합이 부풀어
         "잔여 53회 남았는데 안 오심"처럼 사실과 다른 명단이 뜬다(실제 17회). */
      const usable = dedupeTicketRows(rows).filter((m) => isUsableTicket(m, today));
      if (!usable.length) continue; // 잔여>0 + 기간 남음인 수강권이 하나도 없으면 대상 아님
      const la = lastByPerson.get(k);
      const 마지막출석일 = la ? String(la.마지막출석일 ?? '') : '';
      const 경과일 = 마지막출석일 ? daysBetween(마지막출석일, today) : historyDays;
      if (경과일 === null || 경과일 < 휴면일) continue;

      const first = rows.find((m) => String(m.이름 ?? '').trim()) || rows[0];
      dormant.push({
        person_key: k,
        이름: normPersonName(first.이름),
        연락처: String(rows.find((m) => String(m.연락처 ?? '').trim())?.연락처 ?? ''),
        마지막출석일: 마지막출석일 || null,
        마지막지점: la ? la.마지막지점 ?? '' : '',
        경과일,
        // 관측 이력이 없어 "정확히 며칠"인지 모르는 경우 — UI 는 '≥N일'로 표기한다
        경과일추정: !마지막출석일,
        잔여합: usable.reduce((s, m) => s + toInt(m.잔여횟수), 0),
        보유수강권: usable.map((m) => ({
          수강권명: m.수강권명 ?? '',
          잔여횟수: toInt(m.잔여횟수),
          수강권종료일: m.수강권종료일 ?? '',
        })),
      });
    }
    dormant.sort((a, b) => b.경과일 - a.경과일);
  }

  // 휴면은 슬랙에 안 나가지만 화면에서 같은 표로 보고 조치를 체크한다 → 멘트도 렌더해 둔다
  for (const d of dormant) {
    d.멘트 = renderTemplate(dRule.템플릿, {
      이름: d.이름,
      마지막출석일: d.마지막출석일 ?? '기록 없음',
      경과일: d.경과일추정 ? `≥${d.경과일}` : d.경과일,
      잔여합: d.잔여합,
    });
  }

  const stats = { 예약: roster.length, 멘트: picked.length, 휴면: dormant.length };
  if (보류.length) stats.마일스톤보류 = 보류.length;
  for (const m of picked) stats[m.rule_id] = (stats[m.rule_id] ?? 0) + 1;

  return { messages: picked, dormant, stats, warnings, 보류 };
}

/** 지점별로 묶기 — 슬랙 발송 단위. */
export function groupMessagesByBranch(messages) {
  const map = new Map();
  for (const m of messages) {
    const b = m.지점 || '(미지정)';
    if (!map.has(b)) map.set(b, []);
    map.get(b).push(m);
  }
  return map;
}

// personKey 를 쓰는 곳이 없더라도 규칙 모듈의 공개 API 로 남겨 둔다(테스트·시뮬레이션용)
export { personKey, ymdNum };
