'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { fmtNum, BRANCHES } from '@/lib/members';
import { COSTS_TABLE, COST_NUM_COLS, costTotal, type BranchCost } from '@/lib/costs';
import { currentYear, inPeriod, periodLabel, type Period } from '@/lib/period';
import PeriodPicker from '@/components/ui/PeriodPicker';
import { sb } from '@/lib/supabase';
import { btn, spinner } from '@/components/ui/styles';

/* ======================================================================
   지점별 비용 집계 — branch_costs 를 읽어 지점별 비용 내역과
   비용 카테고리(인건비·임대료·기타비용)별 총합을 보여준다(읽기 전용).
   입력은 "비용 업로드" 탭에서 하고, 여기서는 집계만 본다.
   ====================================================================== */

// 여러 비용 레코드를 카테고리별로 합산
function sumCols(rows: BranchCost[]): { 인건비: number; 임대료: number; 기타비용: number } {
  return rows.reduce(
    (a, r) => ({
      인건비: a.인건비 + (r.인건비 || 0),
      임대료: a.임대료 + (r.임대료 || 0),
      기타비용: a.기타비용 + (r.기타비용 || 0),
    }),
    { 인건비: 0, 임대료: 0, 기타비용: 0 },
  );
}

type Row = {
  지점: string;
  인건비: number;
  임대료: number;
  기타비용: number;
  합계: number;
  메모: string; // 전체 기간이면 월별 메모를 합쳐 보여준다
};

export default function BranchCosts() {
  const [costs, setCosts] = useState<BranchCost[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [period, setPeriod] = useState<Period>({ mode: 'all', year: currentYear(), unit: 1 });

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const { data, error } = await sb
        .from(COSTS_TABLE)
        .select('*')
        .order('연월', { ascending: false });
      if (error) throw error;
      setCosts((data as BranchCost[]) || []);
      setError(null);
    } catch (err) {
      setError((err as Error).message || String(err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  // 최초 진입 + 창에 다시 포커스될 때(업로드 후 돌아온 경우) 자동 재조회
  useEffect(() => {
    load();
    const onFocus = () => load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load]);

  // 데이터에 존재하는 연도 목록(내림차순)
  const years = useMemo(() => {
    if (!costs) return [];
    const set = new Set<number>();
    for (const c of costs) {
      const mt = /^(\d{4})/.exec(String(c.연월 ?? ''));
      if (mt) set.add(Number(mt[1]));
    }
    return Array.from(set).sort((a, b) => b - a);
  }, [costs]);

  // 선택 기간으로 거른 레코드
  const filtered = useMemo(() => {
    if (!costs) return [];
    return costs.filter((c) => inPeriod(c.연월, period));
  }, [costs, period]);

  // 지점별 집계 행(비용 있는 지점만, BRANCHES 순서 유지)
  const rows = useMemo<Row[]>(() => {
    return BRANCHES.map((b) => {
      const rs = filtered.filter((c) => c.지점 === b);
      const s = sumCols(rs);
      const multi = period.mode !== 'month';
      const memo = Array.from(
        new Set(
          rs
            .filter((r) => r.메모 && String(r.메모).trim())
            .map((r) => (multi ? `${r.연월} ${r.메모}` : String(r.메모))),
        ),
      ).join(' · ');
      return { 지점: b, ...s, 합계: costTotal(s), 메모: memo };
    }).filter((r) => r.합계 !== 0 || filtered.some((c) => c.지점 === r.지점));
  }, [filtered, period]);

  const totals = useMemo(() => {
    const s = sumCols(filtered);
    return { ...s, 합계: costTotal(s) };
  }, [filtered]);

  return (
    <>
      <div className="mb-[22px]">
        <h2 className="m-0 mb-1 text-[22px]">지점별 비용 집계</h2>
        <p className="m-0 text-[13px] text-muted">
          지점별 비용 내역과 비용 카테고리별 총합. 입력은 “비용 업로드” 탭에서 합니다.
        </p>
      </div>

      {/* 기간 선택 (전체/년/반기/분기/월) */}
      <div className="mb-[18px] flex flex-wrap items-end gap-[14px] rounded-xl border border-border bg-[#f7f8fa] px-[14px] py-3">
        <PeriodPicker value={period} onChange={setPeriod} years={years} allowAll />
        <button className={btn.ghostSm} onClick={load} disabled={refreshing}>
          {refreshing ? '새로고침 중…' : '↻ 새로고침'}
        </button>
        <p className="m-0 max-w-[420px] text-[12px] text-muted">
          <strong>{periodLabel(period)}</strong> 기준 비용 집계입니다.
        </p>
      </div>

      {error ? (
        <div className="p-10 text-center text-sm text-muted">비용을 불러오지 못했습니다: {error}</div>
      ) : !costs ? (
        <div className="p-10 text-center text-sm text-muted">
          <span className={spinner} /> 비용을 불러오는 중…
        </div>
      ) : (
        <>
          {/* 비용 카테고리별 총합 카드 */}
          <div className="mb-[18px] grid grid-cols-2 gap-[14px] sm:grid-cols-4">
            {COST_NUM_COLS.map((col) => (
              <div key={col} className="rounded-[14px] border border-border bg-card p-[18px]">
                <div className="text-[12px] text-muted">{col}</div>
                <div className="mt-1 text-[22px] font-bold">{fmtNum(totals[col])}</div>
              </div>
            ))}
            <div className="rounded-[14px] border border-border bg-primary-soft p-[18px]">
              <div className="text-[12px] text-muted">총 비용</div>
              <div className="mt-1 text-[22px] font-bold text-primary">{fmtNum(totals.합계)}</div>
            </div>
          </div>

          {/* 지점별 비용 내역 표 */}
          <div className="mb-[10px] overflow-x-auto rounded-xl border border-border">
            <table className="w-full whitespace-nowrap border-collapse text-[13px]">
              <thead>
                <tr>
                  {['지점', '인건비', '임대료', '기타비용', '합계', '메모'].map((h) => (
                    <th
                      key={h}
                      className="border-b border-border bg-[#f7f8fa] px-3 py-[11px] text-right font-semibold first:text-left last:text-left"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-10 text-center text-muted">
                      해당 기간의 비용 데이터가 없습니다.
                    </td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.지점} className="hover:bg-[#fafbfc]">
                      <td className="border-b border-[#eef0f4] px-3 py-[10px] font-semibold">{r.지점}</td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px] text-right">{fmtNum(r.인건비)}</td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px] text-right">{fmtNum(r.임대료)}</td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px] text-right">{fmtNum(r.기타비용)}</td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px] text-right font-semibold">
                        {fmtNum(r.합계)}
                      </td>
                      <td className="max-w-[280px] truncate border-b border-[#eef0f4] px-3 py-[10px] text-muted" title={r.메모}>
                        {r.메모 || '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {rows.length > 0 && (
                <tfoot>
                  <tr className="bg-[#f7f8fa] font-semibold">
                    <td className="px-3 py-[11px]">합계</td>
                    <td className="px-3 py-[11px] text-right">{fmtNum(totals.인건비)}</td>
                    <td className="px-3 py-[11px] text-right">{fmtNum(totals.임대료)}</td>
                    <td className="px-3 py-[11px] text-right">{fmtNum(totals.기타비용)}</td>
                    <td className="px-3 py-[11px] text-right">{fmtNum(totals.합계)}</td>
                    <td className="px-3 py-[11px]" />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <p className="text-xs text-muted">
            ※ ‘전체 기간’은 업로드된 모든 월의 비용을 지점별로 합산한 값입니다.
          </p>
        </>
      )}
    </>
  );
}
