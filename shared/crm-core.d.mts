/* ============================================================================
   shared/crm-core.mjs 의 타입 선언 (손으로 유지)
   ----------------------------------------------------------------------------
   tsconfig 의 allowJs:false 를 유지하면서 .mjs 를 타입 있는 채로 쓰기 위한 파일이다.
   moduleResolution:"bundler" 가 `@/shared/crm-core.mjs` import 를 이 .d.mts 로 해석한다.
   ⚠️ crm-core.mjs 에 export 를 추가하면 여기도 같이 추가할 것.
   ============================================================================ */

/** members/sales 레코드 — 한글 컬럼 문자열 + dedup_key */
export type Rec = Record<string, unknown>;

export const KEY_SEP: string;

export const BRANCHES: readonly ['청담', '옥수', '광교', '반포', '판교', '송파'];
export const BRANCH_SRC_COL: '수강권명';

export function matchesBranch(rec: Rec, branch: string): boolean;
export function branchOf(수강권명: unknown): string;
export function ticketType(수강권명: unknown): string;
export function isTrial(rec: Rec): boolean;

export function phoneDigits(v: unknown): string;
/** 이름의 임시 표식('미수금' 등) 제거. SQL 짝은 public.norm_person_name(). */
export function normPersonName(name: unknown): string;
export function personKey(rec: Rec): string;
export function makePersonResolver(
  ...rowSets: Array<readonly Rec[] | null | undefined>
): (rec: Rec) => string;

export function regDate(rec: Rec): string;

export function toInt(v: unknown): number;
export function usedCount(rec: Rec): number;

export function ymKey(dateStr: unknown): string;
export function ymdNum(dateStr: unknown): number | null;
export function ymdText(n: number | null | undefined): string;

export function dateKST(offsetDays?: number, base?: Date): string;
export function addDays(ymd: unknown, n: number): string;
export function daysBetween(a: unknown, b: unknown): number | null;

export function isUsableTicket(rec: Rec, today?: Date | string): boolean;
export function pickTicketRow<T extends Rec>(rows: readonly T[] | null | undefined): T | null;

export function fmtNum(n: unknown): string;
export function renderTemplate(
  tpl: unknown,
  vars: Record<string, unknown> | null | undefined,
): string;
export function slackEscape(s: unknown): string;
