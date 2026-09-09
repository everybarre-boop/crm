/* ============================================================================
   shared/crm-rules.mjs 의 타입 선언 (손으로 유지)
   ============================================================================ */
import type { Rec } from './crm-core.mjs';

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
};

export type CrmMessageDraft = {
  대상일자: string;
  지점: string;
  person_key: string;
  이름: string;
  연락처: string;
  수업시간: string;
  수업명: string;
  강사: string;
  수강권명: string;
  rule_id: string;
  규칙키: string;
  멘트: string;
  예시멘트: string;
  근거: Record<string, unknown>;
};

export type DormantDraft = {
  person_key: string;
  이름: string;
  연락처: string;
  마지막출석일: string | null;
  마지막지점: string;
  경과일: number;
  경과일추정: boolean;
  잔여합: number;
  보유수강권: Array<{ 수강권명: string; 잔여횟수: number; 수강권종료일: string }>;
  멘트?: string;
};

export type SentHistoryRow = {
  person_key: string;
  rule_id: string;
  규칙키?: string | null;
  대상일자: string;
};

export type BuildCrmInput = {
  memberRows?: readonly Rec[];
  rosterRows?: readonly Rec[];
  lastAttendance?: readonly Rec[];
  sentHistory?: readonly SentHistoryRow[];
  rules?: readonly CrmRule[];
  today: string;
  targetDate: string;
  historyDays?: number;
};

export type BuildCrmResult = {
  messages: CrmMessageDraft[];
  dormant: DormantDraft[];
  stats: Record<string, number>;
  warnings: string[];
};

export const DEFAULT_RULES: CrmRule[];
export function buildCrm(input: BuildCrmInput): BuildCrmResult;
export function groupMessagesByBranch(
  messages: readonly CrmMessageDraft[],
): Map<string, CrmMessageDraft[]>;
/** 만료 임박 안내에서 뺄 회원 판정 — 그 만료일 이후까지 유효한 다른 등록건이 있는가 */
export function hasRenewalTicket(memberRows: readonly Rec[], ticket: Rec): boolean;
export function personKey(rec: Rec): string;
export function ymdNum(dateStr: unknown): number | null;
