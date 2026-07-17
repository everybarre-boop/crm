/* ======================================================================
   branch_costs — 지점별·월별 비용 상수/헬퍼
   대시보드의 비용 총합·인건비 비율·임대료 비율 계산에 쓴다.
   보안 모델은 members/sales 와 동일(관리자 화이트리스트 RLS). SQL: sql/2026-07_branch_costs.sql
   ====================================================================== */
export const COSTS_TABLE = 'branch_costs';

// 입력 화면에서 다루는 숫자 비용 컬럼
export const COST_NUM_COLS = ['인건비', '임대료', '기타비용'] as const;

export type BranchCost = {
  id?: number;
  지점: string;
  연월: string; // 'YYYY-MM'
  인건비: number;
  임대료: number;
  기타비용: number;
  메모?: string | null;
};

// 이번 달 'YYYY-MM' (로컬 기준)
export function currentYearMonth(d: Date = new Date()): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// 최근 N개월 목록(내림차순). 비용 입력·대시보드 월 선택기 옵션.
export function recentMonths(n = 24, from: Date = new Date()): string[] {
  const out: string[] = [];
  const y = from.getFullYear();
  const m = from.getMonth();
  for (let i = 0; i < n; i++) {
    const d = new Date(y, m - i, 1);
    out.push(currentYearMonth(d));
  }
  return out;
}

export function costTotal(c: Pick<BranchCost, '인건비' | '임대료' | '기타비용'>): number {
  return (c.인건비 || 0) + (c.임대료 || 0) + (c.기타비용 || 0);
}
