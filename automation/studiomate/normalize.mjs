// ============================================================================
// 스튜디오메이트 화면에서 긁은 원문 문자열 → DB 에 넣을 형태로 정규화
// ----------------------------------------------------------------------------
// 셀렉터와 무관한 순수 변환만 둔다. 화면 구조가 바뀌어도 이 파일은 안 바뀐다.
// (바뀌는 건 selectors.mjs 뿐이다.)
//
// 스튜디오메이트는 여러 값을 한 줄에 가운뎃점(·)으로 이어 붙여 보여준다:
//   "박진화 · 010-3850-9069"
//   "바레 그룹 40회(판교) · 12회 남음 · 2026. 5. 8.~2026. 11. 3."
//   "2026년 8월 11일 화요일 · 09:30 ~ 10:20"
// 그래서 파서가 여기 모여 있다.
// ============================================================================
import { branchOf, normPersonName, ymdNum, ymdText } from '../../shared/crm-core.mjs';

/** 공백 정리. nbsp 같은 것도 평범한 공백으로. */
export function normText(s) {
  return String(s ?? '')
    .replace(/[ ​]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 가운뎃점 계열 구분자로 쪼갠다. */
function splitDot(s) {
  return normText(s)
    .split(/\s*[·・|]\s*/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** '오전 10:00', '10:00~10:50', '10시 00분' → 'HH:MM'. 못 뽑으면 ''. */
export function normTime(s) {
  const t = normText(s);
  const m = t.match(/(\d{1,2})\s*[:시]\s*(\d{1,2})/);
  if (!m) return '';
  let h = Number(m[1]);
  const min = Number(m[2]);
  if (/오후|PM/i.test(t) && h < 12) h += 12;
  if (/오전|AM/i.test(t) && h === 12) h = 0;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/** 어떤 표기든 'YYYY-MM-DD' 로. 못 읽으면 ''. */
export function normDate(s) {
  return ymdText(ymdNum(s));
}

/* 예약 상태 라벨 → 표준값.
   실측 어휘 (2026-08-12, 청담·판교 27개 수업 전수 확인):
     과거 수업   출석 / 결석
     미래 수업   예약 / "예약 확정" / "예약 대기 (1)" "예약 대기 (2)" …  ← 대기는 순번이 붙는다
     드롭다운    취소 / 결석 / 노쇼 / 출석
   ⚠️ 순서가 중요하다. '예약취소'는 '취소'와 '예약'을, '미출석'은 '출석'을,
      '예약대기'는 '예약'을 포함한다 — 더 구체적인 것을 먼저 본다.
   🔥 '예약대기'를 '예약'으로 접지 말 것. 접으면 만석 수업의 대기자가 예약자로 둔갑해
      CRM 멘트가 그대로 나간다. shared/crm-rules.mjs 의 NOT_ATTENDING 과 짝이다.

   ✅ 대기 → 출석 전이는 스스로 검증된다. 대기자와 확정자는 res_key
      (지점⋮예약일자⋮수업시간⋮수업명⋮이름⋮숫자연락처)가 **같으므로**, 대기가 승인돼
      수업에 들어가면 다음날 D-1 출석 스크랩이 **같은 행을 '예약대기' → '출석'으로 덮는다.**
      즉 "어제 대기였는데 오늘 출석으로 안 바뀐 사람"은 실제로 못 들어간 사람이다.
      (그래서 save_reservations 는 '예약대기'를 확정 상태로 취급하면 안 된다 —
       sql/2026-08_crm.sql 의 on conflict 분기 참고) */
const STATUS_RULES = [
  ['취소', '취소'],
  ['노쇼', '노쇼'],
  ['no-show', '노쇼'],
  ['미출석', '결석'],
  ['결석', '결석'],
  ['출석', '출석'],
  ['참석', '출석'],
  ['예약대기', '예약대기'],
  ['대기', '예약대기'],
  ['예약', '예약'], // "예약 확정" 포함
];

/** 예약대기 표준값 — 스크래퍼·규칙·SQL 이 같은 문자열을 쓰도록 한 곳에 둔다. */
export const WAITLIST = '예약대기';

export function normStatus(s, fallback = '예약') {
  /* ⚠️ 공백을 **지우고** 비교한다. 화면 값이 "예약 대기 (1)" 처럼 띄어 쓰여 있어서
        normText(공백을 1칸으로 축약)만으로는 '예약대기'가 매칭되지 않는다. */
  const t = normText(s).replace(/\s+/g, '').toLowerCase();
  if (!t) return fallback;
  for (const [needle, value] of STATUS_RULES) {
    if (t.includes(needle.toLowerCase())) return value;
  }
  return '기타';
}

/** '20회', ' 18 ', '12회 남음' → '18'(문자열). DB 컬럼이 text 라 문자열로 둔다. 못 뽑으면 ''. */
export function normCount(s) {
  const m = normText(s).match(/-?\d+/);
  return m ? m[0] : '';
}

/** 연락처 — 표기는 그대로 두되 공백만 정리한다. 숫자 비교는 phoneDigits 가 한다. */
export function normPhone(s) {
  return normText(s).replace(/\s/g, '');
}

/* ==========================================================================
   한 줄에 뭉쳐 있는 값 쪼개기
   ========================================================================== */

/** "박진화 · 010-3850-9069" → { 이름, 연락처 }.  연락처가 없으면 이름만. */
export function parseMemberLine(s) {
  const parts = splitDot(s);
  if (!parts.length) return { 이름: '', 연락처: '' };
  const last = parts[parts.length - 1];
  // 마지막 조각이 전화번호처럼 생겼을 때만 연락처로 본다
  // (이름에 '·'가 들어가는 경우가 있어도 이름 쪽으로 남는다)
  if (/^[\d\-+() ]{7,}$/.test(last)) {
    return { 이름: parts.slice(0, -1).join(' · ').trim(), 연락처: normPhone(last) };
  }
  return { 이름: parts.join(' · ').trim(), 연락처: '' };
}

/**
 * "바레 그룹 40회(판교) · 12회 남음 · 2026. 5. 8.~2026. 11. 3."
 *   → { 수강권명, 잔여횟수, 수강권시작일, 수강권종료일 }
 * ⚠️ 전체횟수는 화면에 없다. 수강권명의 "40회"는 명목값이라 실제 전체횟수와 다를 수 있으므로
 *    (횟수 조정·서비스 추가) 여기서 뽑지 않는다. members DB 값을 그대로 쓴다.
 * 뒤에서부터 파싱한다 — 수강권명에 '·'가 들어가도 안전하다.
 */
export function parseTicketLine(s) {
  const parts = splitDot(s);
  const out = { 수강권명: '', 잔여횟수: '', 수강권시작일: '', 수강권종료일: '' };
  if (!parts.length) return out;

  const rest = [...parts];

  // 마지막: 기간 "2026. 5. 8.~2026. 11. 3."
  const periodIdx = rest.findIndex((p) => /~/.test(p) && ymdNum(p.split('~')[0]) !== null);
  if (periodIdx >= 0) {
    const [a, b] = rest[periodIdx].split('~');
    out.수강권시작일 = normDate(a);
    out.수강권종료일 = normDate(b);
    rest.splice(periodIdx, 1);
  }

  // "12회 남음"
  const remainIdx = rest.findIndex((p) => /남음|잔여/.test(p));
  if (remainIdx >= 0) {
    out.잔여횟수 = normCount(rest[remainIdx]);
    rest.splice(remainIdx, 1);
  }

  out.수강권명 = rest.join(' · ').trim();
  return out;
}

/** "2026년 8월 11일 화요일 · 09:30 ~ 10:20" → { 예약일자, 수업시간 } */
export function parseLectureDateTime(s) {
  const t = normText(s);
  return {
    예약일자: normDate(t),
    // 첫 번째 시각만(시작 시각). "09:30 ~ 10:20" → "09:30"
    수업시간: normTime((t.split(/[·・]/)[1] ?? t).split('~')[0]),
  };
}

/* ==========================================================================
   레코드 조립
   ========================================================================== */

/**
 * 스크랩 원시 행 → reservations 레코드
 * 지점은 **수강권명에서 뽑는다**(CLAUDE.md: 지점은 수강권명 안에 있다).
 * everybarre 사이트는 청담·판교 두 지점이 한 화면에 섞이므로 이게 유일하게 정확한 기준이다.
 * 수강권명에 지점 태그가 없으면(예: "체험 후 1회권") 사이트 기본 지점으로 폴백한다.
 */
export function toReservationRecord(raw, { branch, date }) {
  const 수강권명 = normText(raw.수강권명);
  return {
    지점: branchOf(수강권명) || branch || '',
    예약일자: normDate(raw.예약일자 || date),
    수업시간: normTime(raw.수업시간),
    수업명: normText(raw.수업명),
    강사: normText(raw.강사),
    /* '미수금' 같은 임시 표식을 여기서 뗀다(경계에서 한 번만).
       안 떼면 결제 전후로 res_key 가 갈려 같은 예약이 두 행이 되고,
       person_key 도 갈려 누적 횟수가 쪼개진다. crm-core 의 normPersonName 참고. */
    이름: normPersonName(normText(raw.이름)),
    연락처: normPhone(raw.연락처),
    수강권명,
    예약상태: normStatus(raw.예약상태),
    전체횟수: normCount(raw.전체횟수), // 화면에 없으므로 보통 ''
    잔여횟수: normCount(raw.잔여횟수),
    수강권시작일: normDate(raw.수강권시작일),
    수강권종료일: normDate(raw.수강권종료일),
    /* 스튜디오메이트 회원 id — 회원 상세(`/users/detail?id=`)를 열어 **실제 출석 수**를
       읽는 데 쓴다(docs/NEXT-attendance-count.md). 예약자 행의 컴포넌트 상태에서 나온다
       (그 `a` 의 href 는 null 이다 — selectors.mjs 의 MEMBER_ID_VUE_PATH 참고).
       ⚠️ `reservations` 컬럼이 아니다. save_reservations RPC 는 키를 명시적으로 골라 쓰므로
          이 키는 무시된다(raw 에만 남는다). 여기 두는 이유는 예약행과 회원 id 가 **같은
          한 번의 읽기**에서 나오기 때문이다 — 따로 들고 다니면 짝이 어긋난다. */
    회원id: normText(raw.회원id),
  };
}

/* ----------------------------------------------------------------------
   reservations 레코드 → apply_attendance 가 받는 축약 형태.
   ⚠️ 전체횟수는 빈 값으로 보낸다 — 화면에 없기 때문이다. RPC(v2)가 coalesce 로
      DB 기존 값을 유지한다. 여기서 수강권명의 "40회" 같은 명목값을 억지로 넣으면
      횟수 조정된 회원의 used_count 가 틀어진다.
   수강권시작일을 함께 보내면 RPC 가 "재등록 여러 행 중 어느 행인지"를 정확히 고른다.
   잔여횟수를 못 읽은 행은 반영 대상이 아니다(넣으면 0 으로 덮인다).

   ℹ️ 예약대기 행도 그대로 넣는다. 화면의 잔여횟수는 "그 수업에 들어갔는가"와 무관하게
      **그 회원의 현재 실제 잔여횟수**라서 반영해도 값이 달라지지 않는다.
      (대기자를 CRM 대상에서 빼는 것은 crm-rules.mjs 의 NOT_ATTENDING 이 한다 — 여기가 아니다.)
   ---------------------------------------------------------------------- */
export function toAttendanceRecords(rows) {
  return rows
    .filter((r) => r.이름 && r.잔여횟수 !== '')
    .map((r) => ({
      이름: r.이름,
      연락처: r.연락처,
      수강권명: r.수강권명,
      전체횟수: r.전체횟수 || '', // 대개 '' → RPC 가 DB 값 유지
      잔여횟수: r.잔여횟수,
      수강권시작일: r.수강권시작일 || '',
    }));
}
