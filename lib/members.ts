import { sb } from './supabase';

/* ======================================================================
   members 테이블 스키마 · 공통 상수
   (엑셀 헤더명 = DB 컬럼명. 컬럼 목록은 이 파일이 기준이다.)
   ---------------------------------------------------------------------
   ⚠️ 순수 함수(동일인 판정·횟수 계산·날짜 파싱 등)의 **구현은 여기 없다.**
      shared/crm-core.mjs 로 옮겨 두고 아래에서 re-export 한다.
      이유: automation/(.mjs)이 이 파일을 import 할 수 없기 때문이다
      (TS 이고, supabase 클라이언트가 딸려 온다). 같은 공식을 자동화 쪽에 다시
      구현하면 "코드가 만드는 값 ↔ DB 가 만드는 값"이 어긋난다 — dedup_key 로
      두 번 겪은 사고다(CLAUDE.md). 그래서 구현은 shared/ 한 곳에만 둔다.
      화면 코드는 지금까지처럼 `from '@/lib/members'` 로 그대로 쓰면 된다.
   ====================================================================== */
export {
  KEY_SEP,
  BRANCHES,
  BRANCH_SRC_COL,
  matchesBranch,
  branchOf,
  ticketType,
  isTrial,
  phoneDigits,
  personKey,
  makePersonResolver,
  regDate,
  toInt,
  usedCount,
  ymKey,
  ymdNum,
  ymdText,
  isUsableTicket,
  pickTicketRow,
  fmtNum,
} from '@/shared/crm-core.mjs';

import { KEY_SEP } from '@/shared/crm-core.mjs';

export const TABLE = 'members';

// 화면·수정에서 다루는 컬럼 (엑셀 헤더 = DB 컬럼)
export const COLUMNS = [
  '이름', '연락처', '성별', '등록일', '생년월일', '수강권명', '수강권종류',
  '결제구분', '결제금액', '결제방법', '결제일시', '할부개월수',
  '잔여횟수', '전체횟수', '예약가능횟수', '취소가능횟수',
  '수강권시작일', '수강권종료일',
] as const;

/* upsert 충돌 판단용 고유 키(중복 판정 기준) = "수강권 등록건 1건"을 식별하는 컬럼들.
   ----------------------------------------------------------------------------
   ⚠️ 2026-08 개정 — 이전 키(`이름·연락처·수강권명·등록일·전체횟수`)는 사용횟수를
      48% 누락시켰다. 예약사이트 내보내기에 `등록일` 컬럼이 없어 그 자리가 항상 빈 값이라,
      **같은 사람이 같은 수강권을 재등록한 건이 전부 1건으로 뭉개졌다.**
      (실측: 이가원 엑셀 55행 632회 → DB 23행 173회. 전체 124,839회 → 65,201회)
      대표 사례는 `언리미티드(판교) 전체 30회`를 19번 재등록한 건 — 19행이 1행이 됐다.

   그래서 키를 "결제 1건 = 등록 1건"으로 바꿨다. 재등록은 결제일시/시작일이 다르므로
   서로 다른 행으로 남는다. 실측 17,641행 중 17,617행이 고유(사용횟수 124,802/124,839).

   🔑 키 설계 원칙 — **재업로드 때 값이 바뀌는 컬럼은 절대 넣지 말 것.**
      키 컬럼이 바뀌면 upsert 가 "덮어쓰기"가 아니라 "새 행 추가"가 되어 중복이 쌓인다.
      · 넣으면 안 되는 것: 잔여/예약가능/취소가능 횟수(매일 변함), `전체횟수`(횟수 조정으로
        변함), `수강권종료일`(연장·홀드로 변함), `등록일`(파일에 없어 항상 빈 값).
      · 넣어도 되는 것(등록 시점에 확정되고 이후 안 변함): 아래 9개.
   KEY_COLS 를 바꾸면 dedup_key 값이 통째로 달라진다 — 기존 데이터는 초기화 후 재업로드하거나
   백필 SQL 로 맞춰야 한다. (CLAUDE.md "dedup_key 불변식" 참고)

   💡 재등록이 별개 행으로 남는 것의 부수 효과: 같은 사람+같은 수강권명이 members 에 여러 행
      존재한다. 그 중 "지금 쓰는 1행"을 고를 때는 pickTicketRow() 를 쓸 것(스튜디오메이트
      출석 반영 RPC 도 같은 규칙으로 고른다 — sql/2026-08_apply_attendance_v2.sql). */
export const KEY_COLS = [
  '이름', '연락처', '수강권명', '수강권시작일',
  '결제구분', '결제금액', '결제일시', '결제방법', '할부개월수',
] as const;

// 검색 대상 컬럼 (ilike) — 이름·연락처로 사람을 식별
export const SEARCH_COLS = ['이름', '연락처', '수강권명', '수강권종류', '성별'] as const;

// 필터 드롭다운으로 노출하는 저(低)카디널리티 컬럼
export const FILTER_COLS = ['성별', '수강권종류'] as const;

/* ----------------------------------------------------------------------
   엑셀 헤더 → 표준(DB) 컬럼명 해석.
   업로드는 "엑셀 헤더명 = DB 컬럼명"이 원칙이지만, 예약사이트마다 헤더 이름이
   조금씩 달라(특히 전화번호: 휴대폰/전화번호/핸드폰 …) 값이 통째로 누락되기 쉽다.
   그래서 공백 제거+소문자로 정규화한 헤더를 표준 컬럼명으로 매핑한다.
   - normHeader: 헤더 정규화(공백 제거·소문자). 한글은 대소문자 영향 없음.
   - COLUMN_ALIASES: 별칭(정규화된 키) → 표준 컬럼명. 여기 없으면 헤더 그대로 매칭.
   - canonicalColumn: 헤더 하나를 표준 컬럼명으로. 모르면 undefined(=무시할 컬럼).
   ---------------------------------------------------------------------- */
export function normHeader(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, '').trim().toLowerCase();
}

// 표준 컬럼(정규화) → 표준 컬럼명. 헤더가 표준명과 같으면 그대로 인식.
const COLUMN_BY_NORM: Record<string, string> = Object.fromEntries(
  COLUMNS.map((c) => [normHeader(c), c]),
);

// 별칭(정규화된 키) → 표준 컬럼명. 새 표기를 발견하면 여기에 추가만 하면 된다.
export const COLUMN_ALIASES: Record<string, string> = {
  // 전화번호 계열 → 연락처
  휴대폰: '연락처',
  휴대폰번호: '연락처',
  전화번호: '연락처',
  전화: '연락처',
  핸드폰: '연락처',
  핸드폰번호: '연락처',
  연락처번호: '연락처',
  연락처1: '연락처',
  phone: '연락처',
  mobile: '연락처',
  tel: '연락처',
};

export function canonicalColumn(header: unknown): string | undefined {
  const n = normHeader(header);
  return COLUMN_BY_NORM[n] ?? COLUMN_ALIASES[n];
}

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
   검색어 정제 (PostgREST .or() 필터 인젝션 방지)
   .or()는 문자열을 필터 구문으로 파싱하므로, 구문에 의미가 있는 특수문자를 제거한다.
   ====================================================================== */
export function sanitizeSearchTerm(q: string): string {
  return q.trim().replace(/[,.:()"'\\%*]/g, ' ').trim();
}

/* ======================================================================
   여러 컬럼만 골라 전체 행을 페이지 단위로 가져오기 (통계용)
   ---------------------------------------------------------------------
   ⚠️ 반드시 정렬을 걸고 페이징한다. Postgres 는 ORDER BY 없는 LIMIT/OFFSET 의
   행 순서를 보장하지 않아서, 페이지 사이에 같은 행이 두 번 나오거나 어떤 행이
   아예 빠질 수 있다(플랜이 바뀌거나 다른 탭에서 업로드가 도는 중에 실제로 발생).
   이 결과는 1인 합산 사용횟수의 "정확한 합계"로 쓰이므로, 한 행이 두 번 잡히면
   그 사람 총 사용횟수가 부풀고 "N회 이상" 필터의 포함/제외가 뒤집힌다.
   id 는 members·sales 둘 다 identity PK 라 안정적인 정렬 기준이다.

   ⛔️ reservations 에는 절대 쓰지 말 것 — 하루 300~800행씩 쌓여 1년이면 15~20만 행이다.
      예약 조회는 항상 .gte/.lte('예약일자') 로 날짜를 끊는다.
   ====================================================================== */
export const SCAN_ORDER_COL = 'id';

export async function fetchAllRows(
  select: string,
  cap = 50000,
  table: string = TABLE,
): Promise<MemberRecord[]> {
  const PAGE = 1000;
  let from = 0;
  let out: MemberRecord[] = [];
  while (from < cap) {
    const { data, error } = await sb
      .from(table)
      .select(select)
      .order(SCAN_ORDER_COL, { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    if (!data || !data.length) break;
    out = out.concat(data as unknown as MemberRecord[]);
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return out;
}
