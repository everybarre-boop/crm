/* ======================================================================
   기간 필터 — 년 / 반기 / 분기 / 월 (그리고 선택적으로 전체 기간)
   대시보드·지점별 비용 집계가 공통으로 쓰는 기간 선택 모델.
   비교 대상은 모두 'YYYY-MM' 문자열(등록일/결제일시/연월)이라 inPeriod 하나로 거른다.
   ====================================================================== */
export type PeriodMode = 'all' | 'year' | 'half' | 'quarter' | 'month';

export type Period = {
  mode: PeriodMode;
  year: number;
  unit: number; // month 1-12 / quarter 1-4 / half 1-2 (year·all 에선 무시)
};

export function currentYear(d: Date = new Date()): number {
  return d.getFullYear();
}

// 기본 선택: 이번 달
export function defaultPeriod(d: Date = new Date()): Period {
  return { mode: 'month', year: d.getFullYear(), unit: d.getMonth() + 1 };
}

// 'YYYY-MM'(또는 그 접두어를 가진 날짜문자열)이 선택 기간에 드는지
export function inPeriod(ym: unknown, p: Period): boolean {
  const s = String(ym ?? '');
  if (p.mode === 'all') return !!s;
  const mt = /^(\d{4})-(\d{1,2})/.exec(s);
  if (!mt) return false;
  const y = Number(mt[1]);
  const m = Number(mt[2]);
  if (y !== p.year) return false;
  switch (p.mode) {
    case 'year':
      return true;
    case 'half':
      return p.unit === 1 ? m <= 6 : m >= 7;
    case 'quarter':
      return Math.ceil(m / 3) === p.unit;
    case 'month':
      return m === p.unit;
    default:
      return false;
  }
}

export function periodLabel(p: Period): string {
  switch (p.mode) {
    case 'all':
      return '전체 기간';
    case 'year':
      return `${p.year}년`;
    case 'half':
      return `${p.year}년 ${p.unit === 1 ? '상반기' : '하반기'}`;
    case 'quarter':
      return `${p.year}년 ${p.unit}분기`;
    case 'month':
      return `${p.year}-${String(p.unit).padStart(2, '0')}`;
    default:
      return '';
  }
}
