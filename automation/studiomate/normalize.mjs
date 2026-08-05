// ============================================================================
// 스튜디오메이트 화면에서 긁은 원문 문자열 → DB 에 넣을 형태로 정규화
// ----------------------------------------------------------------------------
// 셀렉터와 무관한 순수 변환만 둔다. 화면 구조가 바뀌어도 이 파일은 안 바뀐다.
// (바뀌는 건 selectors.mjs 뿐이다.)
// ============================================================================
import { ymdNum, ymdText } from '../../shared/crm-core.mjs';

/** 공백 정리.  (nbsp) 같은 것도 평범한 공백으로. */
export function normText(s) {
  return String(s ?? '')
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
   ⚠️ 순서가 중요하다. '예약취소' 는 '취소'와 '예약'을 둘 다 포함하고,
      '미출석' 은 '출석'을 포함한다 — 더 구체적인 것을 먼저 본다.
   실제 스튜디오메이트 라벨을 라이브 세션에서 확인하고 여기 추가할 것. */
const STATUS_RULES = [
  ['취소', '취소'],
  ['노쇼', '노쇼'],
  ['no-show', '노쇼'],
  ['미출석', '결석'],
  ['결석', '결석'],
  ['출석', '출석'],
  ['참석', '출석'],
  ['완료', '출석'],
  ['예약', '예약'],
  ['대기', '예약'],
];

export function normStatus(s, fallback = '예약') {
  const t = normText(s).toLowerCase();
  if (!t) return fallback;
  for (const [needle, value] of STATUS_RULES) {
    if (t.includes(needle.toLowerCase())) return value;
  }
  return '기타';
}

/** '20회', ' 18 ', '잔여 18회' → '18'(문자열). DB 컬럼이 text 라 문자열로 둔다. 못 뽑으면 ''. */
export function normCount(s) {
  const m = normText(s).match(/-?\d+/);
  return m ? m[0] : '';
}

/** 연락처 — 표기는 그대로 두되 공백만 정리한다. 숫자 비교는 phoneDigits 가 한다. */
export function normPhone(s) {
  return normText(s).replace(/\s/g, '');
}

/* ----------------------------------------------------------------------
   스크랩 원시 행 → reservations 레코드
   지점은 인자로 받는다(수강권명 추론에 기대지 않는다 — 지점 태그가 빠진 수강권명이 있다).
   ---------------------------------------------------------------------- */
export function toReservationRecord(raw, { branch, date }) {
  return {
    지점: branch,
    예약일자: normDate(raw.예약일자 || date),
    수업시간: normTime(raw.수업시간),
    수업명: normText(raw.수업명),
    강사: normText(raw.강사),
    이름: normText(raw.이름),
    연락처: normPhone(raw.연락처),
    수강권명: normText(raw.수강권명),
    예약상태: normStatus(raw.예약상태),
    전체횟수: normCount(raw.전체횟수),
    잔여횟수: normCount(raw.잔여횟수),
    수강권시작일: normDate(raw.수강권시작일),
    수강권종료일: normDate(raw.수강권종료일),
  };
}

/* ----------------------------------------------------------------------
   reservations 레코드 → apply_attendance 가 받는 축약 형태.
   ⚠️ 기존 RPC 계약({이름,연락처,수강권명,전체횟수,잔여횟수})을 바꾸지 않기 위한 어댑터다.
      수강권시작일은 v2 RPC 가 "여러 재등록 행 중 어느 행인지" 정확히 고르는 데 쓴다
      (없으면 가장 최근 등록건으로 폴백).
   전체/잔여를 못 읽은 행은 반영 대상이 아니다(덮어쓰면 0 이 들어간다).
   ---------------------------------------------------------------------- */
export function toAttendanceRecords(rows) {
  return rows
    .filter((r) => r.전체횟수 !== '' && r.잔여횟수 !== '' && r.이름)
    .map((r) => ({
      이름: r.이름,
      연락처: r.연락처,
      수강권명: r.수강권명,
      전체횟수: r.전체횟수,
      잔여횟수: r.잔여횟수,
      수강권시작일: r.수강권시작일 || '',
    }));
}
