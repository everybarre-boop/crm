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
   백필 SQL 로 맞춰야 한다. (CLAUDE.md "dedup_key 불변식" 참고) */
export const KEY_COLS = [
  '이름', '연락처', '수강권명', '수강권시작일',
  '결제구분', '결제금액', '결제일시', '결제방법', '할부개월수',
] as const;

export const KEY_SEP = String.fromCharCode(31); // Unit Separator

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

/* ----------------------------------------------------------------------
   지점 — 별도 컬럼이 아니라 수강권명 안에 들어있다. (예: "체험권(광교)")
   그래서 지점 필터는 수강권명 부분일치로 거른다: 서버는 .ilike, 클라이언트는
   matchesBranch(). dedup_key 는 이미 수강권명을 포함하므로 지점이 다르면
   자동으로 별개 행이 되고, 지점을 KEY_COLS 에 따로 넣을 필요가 없다.
   ---------------------------------------------------------------------- */
export const BRANCHES = ['청담', '옥수', '광교', '반포', '판교', '송파'] as const;
export const BRANCH_SRC_COL = '수강권명';

export function matchesBranch(rec: Record<string, unknown>, branch: string): boolean {
  if (!branch) return true;
  return String(rec[BRANCH_SRC_COL] ?? '').includes(branch);
}

/* ----------------------------------------------------------------------
   수강권 종류 = 수강권명에서 지점 꼬리표를 뗀 이름.
   (그룹/프라이빗/없음 으로 나누지 않고, 수강권명에 적힌 이름 자체로 종류를 구분한다.)
   예) "바레 그룹 40회 (광교)"  → "바레 그룹 40회"
       "얼리버드 바레그룹20회(광교)" → "얼리버드 바레그룹20회"
       "(광교) instructor course" → "instructor course"
   지점은 수강권명 안에 "(광교)"처럼 괄호로 들어있으므로, BRANCHES 이름을 담은
   괄호 구간을 제거하고 공백을 정리한다.
   ---------------------------------------------------------------------- */
export function ticketType(수강권명: unknown): string {
  let s = String(수강권명 ?? '');
  // 지점명을 포함한 괄호 묶음 제거: (광교), （광교） 등
  for (const b of BRANCHES) {
    s = s.replace(new RegExp('[（(][^（()）]*' + b + '[^（()）]*[)）]', 'g'), ' ');
  }
  return s.replace(/\s+/g, ' ').trim() || '(없음)';
}

// 체험 등록건: 수강권명에 "체험"이 들어있으면 체험으로 본다.
export function isTrial(rec: Record<string, unknown>): boolean {
  return String(rec[BRANCH_SRC_COL] ?? '').includes('체험');
}

/* ----------------------------------------------------------------------
   1인 식별 — 이름 + 연락처(숫자만). 스튜디오메이트 매칭·회원별 집계의 기준.
   연락처가 '010-1234-5678' 이든 '01012345678' 이든 같은 사람으로 묶인다.
   ---------------------------------------------------------------------- */
export function phoneDigits(v: unknown): string {
  return String(v ?? '').replace(/[^0-9]/g, '');
}

export function personKey(rec: Record<string, unknown>): string {
  return String(rec['이름'] ?? '').trim() + KEY_SEP + phoneDigits(rec['연락처']);
}

/* ----------------------------------------------------------------------
   동일인 판정 — 지점이 달라도 이름+연락처가 같으면 한 사람으로 합친다.
   (예: 판교 이가원 · 반포 이가원 · 옥수 이가원 → 010-9098-8696 한 사람으로 묶여
    사용횟수가 전 지점 합산된다.)

   personKey() 만 쓰면 **연락처가 빈 행이 별개 인물로 쪼개진다**(실측 385행 · 112명).
   그래서 전체 행을 한 번 훑어 이름별 연락처 목록을 만들고:
     · 연락처가 있으면      → 이름+연락처 (기존과 동일)
     · 연락처가 비어 있고, 그 이름의 연락처가 **딱 하나뿐**이면 → 그 사람으로 붙인다
     · 그 이름에 연락처가 **하나도 없으면** → 이름으로 묶는다(다른 사람이라는 근거가 없다)
     · 그 이름에 연락처가 **여럿이면(동명이인)** → 누구인지 판정 불가 → 행마다 따로 센다
   동명이인을 잘못 합치지 않기 위한 보수적 규칙이다. 실측상 '김민정'처럼 서로 다른
   연락처가 24개인 이름도 있어서, 이름만으로 합치는 것은 절대 안 된다.

   ⚠️ 마지막 규칙이 중요하다. 판정 불가 행을 전부 `이름+''` 하나로 보내면(예전 동작)
      **서로 다른 사람이 한 명으로 뭉친다** — 연락처 없는 '김민정' 5행이 각 30회면
      가짜 1명이 150회가 되어 "100회 이상" 필터에 걸리고, 총회원은 5명이 1명이 된다.
      그래서 행 단위로 쪼갠다. 쪼개는 기준은 dedup_key(같은 행이면 어느 조회에서 왔든
      같은 키) → 없으면 행 객체별 일련번호(같은 조회 안에서만 유효).
      집계용 조회에는 되도록 dedup_key 를 select 에 포함시킬 것.

   사용법:
     const keyOf = makePersonResolver(memberRows, salesRows);
     const k = keyOf(rec);   // members·sales 를 같은 기준으로 묶는다
   ---------------------------------------------------------------------- */
export function makePersonResolver(
  ...rowSets: Array<readonly Record<string, unknown>[] | null | undefined>
): (rec: Record<string, unknown>) => string {
  const phonesByName = new Map<string, Set<string>>();
  for (const rows of rowSets) {
    if (!rows) continue;
    for (const r of rows) {
      const name = String(r['이름'] ?? '').trim();
      if (!name) continue;
      const ph = phoneDigits(r['연락처']);
      if (!ph) continue;
      let set = phonesByName.get(name);
      if (!set) phonesByName.set(name, (set = new Set()));
      set.add(ph);
    }
  }
  // 판정 불가 행에 줄 일련번호(dedup_key 가 없을 때만). 행 객체 기준이라 같은 행을
  // 여러 번 물어봐도 같은 키가 나온다.
  const fallbackIds = new WeakMap<object, string>();
  let fallbackSeq = 0;
  return (rec) => {
    const name = String(rec['이름'] ?? '').trim();
    const ph = phoneDigits(rec['연락처']);
    if (ph) return name + KEY_SEP + ph;
    const set = phonesByName.get(name);
    if (set && set.size === 1) return name + KEY_SEP + [...set][0]; // 유일하니 그 사람으로
    if (!set) return name + KEY_SEP + ''; // 이 이름엔 연락처가 아예 없다 → 이름으로 묶는다
    // 동명이인 + 연락처 빈 행 — 누구인지 알 수 없으므로 다른 사람과 절대 합치지 않는다.
    const dk = String(rec['dedup_key'] ?? '');
    if (dk) return name + KEY_SEP + '?' + KEY_SEP + dk;
    let id = fallbackIds.get(rec);
    if (!id) fallbackIds.set(rec, (id = '#' + ++fallbackSeq));
    return name + KEY_SEP + '?' + KEY_SEP + id;
  };
}

/* ----------------------------------------------------------------------
   등록일 대체 — 예약사이트 내보내기에 `등록일` 컬럼이 없어(2026-07-21 이후) DB 전 행이
   빈 값이다. 기간별 집계(신규·체험 등)가 통째로 0이 되므로, 없으면 `수강권시작일`을 쓴다.
   ---------------------------------------------------------------------- */
export function regDate(rec: Record<string, unknown>): string {
  const v = String(rec['등록일'] ?? '').trim();
  return v || String(rec['수강권시작일'] ?? '').trim();
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

/* ----------------------------------------------------------------------
   텍스트 날짜에서 'YYYY-MM' 추출. 다양한 표기를 관대하게 처리한다:
   "2026-07-16", "2026. 7. 16.(목)", "2026/7/16 14:30" 모두 → "2026-07".
   못 뽑으면 '' 반환.
   ---------------------------------------------------------------------- */
export function ymKey(dateStr: unknown): string {
  const m = String(dateStr ?? '').match(/(\d{4})\D+(\d{1,2})/);
  if (!m) return '';
  return `${m[1]}-${m[2].padStart(2, '0')}`;
}

// 텍스트 날짜 → 비교용 정수 yyyymmdd (예: "2026-07-16" → 20260716). 일(day)까지 없으면 null.
export function ymdNum(dateStr: unknown): number | null {
  const m = String(dateStr ?? '').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return null;
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}

/* ----------------------------------------------------------------------
   "지금 사용 가능한 수강권" 판정 = 잔여횟수 > 0 이고, 수강권종료일이 있으면 아직 안 지남.
   (현재 회원 = 이런 수강권을 하나라도 가진 사람.)
   ---------------------------------------------------------------------- */
export function isUsableTicket(rec: Record<string, unknown>, today: Date = new Date()): boolean {
  if (toInt(rec['잔여횟수']) <= 0) return false;
  const end = ymdNum(rec['수강권종료일']);
  if (end !== null) {
    const todayNum = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();
    if (end < todayNum) return false;
  }
  return true;
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
   ---------------------------------------------------------------------
   ⚠️ 반드시 정렬을 걸고 페이징한다. Postgres 는 ORDER BY 없는 LIMIT/OFFSET 의
   행 순서를 보장하지 않아서, 페이지 사이에 같은 행이 두 번 나오거나 어떤 행이
   아예 빠질 수 있다(플랜이 바뀌거나 다른 탭에서 업로드가 도는 중에 실제로 발생).
   이 결과는 1인 합산 사용횟수의 "정확한 합계"로 쓰이므로, 한 행이 두 번 잡히면
   그 사람 총 사용횟수가 부풀고 "N회 이상" 필터의 포함/제외가 뒤집힌다.
   id 는 members·sales 둘 다 identity PK 라 안정적인 정렬 기준이다.
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
