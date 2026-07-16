/* ======================================================================
   sales 테이블 스키마 · 공통 상수
   ---------------------------------------------------------------------
   매출(결제) 전용 테이블. 회원 엑셀 한 장에서 "결제 컬럼만" 분리해 여기에 넣는다.
   회원 정보(이름/생년월일 등)는 members 로, 결제 내역은 sales 로 나눠 저장한다.
   보안 모델은 members 와 동일 — 브라우저가 supabase-js(PostgREST+RLS)로만 접근하고,
   sales 에도 같은 관리자 화이트리스트 RLS 정책을 건다. (SQL: sql/ 폴더 참고)
   ====================================================================== */
import { makeKey, type MemberRecord } from './members';

export const SALES_TABLE = 'sales';

// sales 행 = "누가(이름/생년월일) · 무엇을(수강권명/종류) · 어떻게(결제구분/금액/일시/방법/할부)"
// 회원 엑셀 헤더 = 컬럼명 그대로 재사용한다.
export const SALES_COLUMNS = [
  '이름', '연락처', '생년월일', '수강권명', '수강권종류', '등록일',
  '결제구분', '결제금액', '결제일시', '결제방법', '할부개월수',
] as const;

// upsert 충돌 판단용 고유 키. 한 건의 결제를 유일하게 식별하는 필드만 넣는다.
// (같은 파일 재업로드 시 매출 행이 중복 생기지 않게 함) — 이름·연락처로 사람을 식별.
export const SALES_KEY_COLS = [
  '이름', '연락처', '생년월일', '수강권명',
  '결제구분', '결제금액', '결제일시', '결제방법', '할부개월수',
] as const;

// 숫자 포맷 대상
export const SALES_NUM_COLS = new Set<string>(['결제금액', '할부개월수']);

export type SalesRecord = MemberRecord;

// members 행(또는 엑셀 행)에서 결제 컬럼만 골라 sales 레코드로 만든다.
export function toSalesRecord(row: Record<string, unknown>): SalesRecord {
  const rec: SalesRecord = {};
  for (const c of SALES_COLUMNS) {
    const v = row[c];
    rec[c] = v === '' || v == null ? null : String(v);
  }
  rec.dedup_key = makeKey(rec, SALES_KEY_COLS);
  return rec;
}
