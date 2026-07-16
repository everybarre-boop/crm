import { sb } from './supabase';

/* ======================================================================
   members 테이블 스키마 · 공통 상수
   (엑셀 헤더명 = DB 컬럼명. 컬럼 목록은 이 파일이 기준이다.)
   ====================================================================== */
export const TABLE = 'members';

// 화면·수정에서 다루는 컬럼 (엑셀 헤더 = DB 컬럼)
export const COLUMNS = [
  '이름', '연락처', '성별', '등록일', '생년월일', '수강권명', '수강권종류',
  '결제구분', '결제금액', '결제방법', '결제일시', '할부개월수',
  '잔여횟수', '전체횟수', '예약가능횟수', '취소가능횟수',
  '수강권시작일', '수강권종료일',
] as const;

// upsert 충돌 판단용 고유 키(중복 판정 기준). KEY_COLS 변경 시 DB unique 인덱스 기준(및
// dedup_key 백필 SQL 공식)도 함께 바꿀 것. 아래 5개가 모두 같으면 "같은 데이터"로 보고
// 재업로드 시 덮어쓴다: 이름 · 연락처 · 수강권명 · 등록일 · 전체횟수(수강권 등록 횟수).
// "변하는 값"(잔여/예약가능/취소가능 횟수, 결제금액 등)은 넣지 말 것 — 넣으면 중복 행이 생긴다.
export const KEY_COLS = [
  '이름', '연락처', '수강권명', '등록일', '전체횟수',
] as const;

export const KEY_SEP = String.fromCharCode(31); // Unit Separator

// 검색 대상 컬럼 (ilike) — 이름·연락처로 사람을 식별
export const SEARCH_COLS = ['이름', '연락처', '수강권명', '수강권종류', '성별'] as const;

// 필터 드롭다운으로 노출하는 저(低)카디널리티 컬럼
export const FILTER_COLS = ['성별', '수강권종류'] as const;

// used_count = 전체횟수 − 잔여횟수 (사용횟수). DB에는 members.used_count 생성 컬럼으로도 존재.
// 서버 필터는 그 컬럼(.gte/.lte)을, 대시보드 등 클라이언트 계산은 usedCount() 를 쓴다.
export const USED_COUNT = 'used_count';

// 잔여/예약가능/취소가능 횟수는 업로드로 갱신되는 "변하는 값"이라
// 수정 모달에서 손으로 못 바꾸게 읽기 전용으로 둔다. (나머지는 편집 가능)
export const READONLY = new Set<string>(['잔여횟수', '예약가능횟수', '취소가능횟수']);
export const EDITABLE = new Set<string>(COLUMNS.filter((c) => !READONLY.has(c)));

// 숫자 포맷팅 대상 컬럼
export const NUM_COLS = new Set<string>([
  '결제금액', '잔여횟수', '전체횟수', '예약가능횟수', '취소가능횟수', '할부개월수',
]);

// members 레코드: 한글 컬럼 문자열 + dedup_key
export type MemberRecord = {
  dedup_key?: string;
  [col: string]: string | null | undefined;
};

export function makeKey(
  rec: Record<string, unknown>,
  keyCols: readonly string[] = KEY_COLS,
): string {
  return keyCols.map((c) => (rec[c] == null ? '' : String(rec[c]))).join(KEY_SEP);
}

/* ======================================================================
   숫자 파싱 · 사용횟수 계산
   ---------------------------------------------------------------------
   "3", "3회", " 3 " 처럼 텍스트로 저장된 횟수에서 정수만 뽑는다. DB의
   used_count 생성 컬럼과 같은 규칙(숫자 외 문자 제거)을 클라이언트에서도 쓴다.
   ====================================================================== */
export function toInt(v: unknown): number {
  if (v == null) return 0;
  const n = parseInt(String(v).replace(/[^0-9-]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

// 사용횟수 = 전체횟수 − 잔여횟수. (대시보드 등 클라이언트 계산용)
export function usedCount(rec: Record<string, unknown>): number {
  return toInt(rec['전체횟수']) - toInt(rec['잔여횟수']);
}

/* ======================================================================
   숫자 포맷
   ====================================================================== */
export function fmtNum(n: unknown): string {
  if (n == null || n === '' || isNaN(Number(n))) return n == null ? '' : String(n);
  return Number(n).toLocaleString('ko-KR');
}

/* ======================================================================
   검색어 정제 (PostgREST .or() 필터 인젝션 방지)
   .or()는 문자열을 필터 구문으로 파싱하므로, 구문에 의미가 있는 특수문자를 제거한다.
   ====================================================================== */
export function sanitizeSearchTerm(q: string): string {
  return q.trim().replace(/[,.:()"'\\%*]/g, ' ').trim();
}

/* ======================================================================
   여러 컬럼만 골라 전체 행을 페이지 단위로 가져오기 (통계용)
   ====================================================================== */
export async function fetchAllRows(
  select: string,
  cap = 50000,
  table: string = TABLE,
): Promise<MemberRecord[]> {
  const PAGE = 1000;
  let from = 0;
  let out: MemberRecord[] = [];
  while (from < cap) {
    const { data, error } = await sb.from(table).select(select).range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    out = out.concat(data as unknown as MemberRecord[]);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}
