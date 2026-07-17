'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  fetchAllRows,
  fmtNum,
  ymKey,
  ticketType,
  isTrial,
  personKey,
  matchesBranch,
  BRANCHES,
  type MemberRecord,
} from '@/lib/members';
import { SALES_TABLE } from '@/lib/sales';
import { COSTS_TABLE, currentYearMonth, recentMonths, type BranchCost } from '@/lib/costs';
import { sb } from '@/lib/supabase';
import { card, spinner } from '@/components/ui/styles';

function money(v: unknown): number {
  return Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
}

function countBy(rows: MemberRecord[], keyFn: (r: MemberRecord) => string): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of rows) {
    const k = keyFn(r) || '(없음)';
    m[k] = (m[k] || 0) + 1;
  }
  return m;
}

function BarChart({ map }: { map: Record<string, number> }) {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return <div className="p-10 text-center text-sm text-muted">데이터 없음</div>;
  const max = entries[0][1];
  return (
    <>
      {entries.map(([k, v]) => (
        <div key={k} className="mb-[10px] flex items-center gap-3 text-[13px]">
          <div className="w-[160px] flex-shrink-0 truncate" title={k}>
            {k}
          </div>
          <div className="h-5 flex-1 overflow-hidden rounded-md bg-[#eef1f6]">
            <div className="h-full rounded-md bg-primary" style={{ width: `${((v / max) * 100).toFixed(1)}%` }} />
          </div>
          <div className="w-[70px] flex-shrink-0 text-right text-muted">{fmtNum(v)}</div>
        </div>
      ))}
    </>
  );
}

// 매출 대비 비율(%) — 매출 0 이면 '—'
function ratio(part: number, revenue: number): string {
  if (!revenue) return '—';
  return `${((part / revenue) * 100).toFixed(1)}%`;
}

type BranchStat = {
  지점: string;
  체험: number; // 해당 월 등록 체험 건
  신규: number; // 해당 월 등록 비체험 건
  총회원: number; // 전체 로스터 기준 고유 회원 수
  매출: number; // 해당 월 결제 합
  인건비: number;
  임대료: number;
  기타비용: number;
};

export default function Dashboard() {
  const [members, setMembers] = useState<MemberRecord[] | null>(null);
  const [sales, setSales] = useState<MemberRecord[]>([]);
  const [costs, setCosts] = useState<BranchCost[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [month, setMonth] = useState(currentYearMonth());
  const [chartBranch, setChartBranch] = useState('');

  // members·sales 는 한 번만, costs 는 월이 바뀔 때마다.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [m, s] = await Promise.all([
          fetchAllRows('이름,연락처,성별,수강권명,수강권종류,등록일,전체횟수,잔여횟수'),
          fetchAllRows('이름,연락처,수강권명,결제금액,결제일시', 50000, SALES_TABLE).catch(
            () => [] as MemberRecord[],
          ),
        ]);
        if (!alive) return;
        setMembers(m);
        setSales(s);
      } catch (err) {
        if (alive) setError((err as Error).message || String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const { data } = await sb.from(COSTS_TABLE).select('*').eq('연월', month);
      if (alive) setCosts((data as BranchCost[]) || []);
    })();
    return () => {
      alive = false;
    };
  }, [month]);

  // 지점별 지표
  const branchStats = useMemo<BranchStat[] | null>(() => {
    if (!members) return null;
    const costOf = (b: string) => costs.find((c) => c.지점 === b);
    return BRANCHES.map((b) => {
      const inBranch = members.filter((r) => matchesBranch(r, b));
      const monthRegs = inBranch.filter((r) => ymKey(r['등록일']) === month);
      const persons = new Set(inBranch.map((r) => personKey(r)));
      const rev = sales
        .filter((r) => matchesBranch(r, b) && ymKey(r['결제일시']) === month)
        .reduce((s, r) => s + money(r['결제금액']), 0);
      const c = costOf(b);
      return {
        지점: b,
        체험: monthRegs.filter((r) => isTrial(r)).length,
        신규: monthRegs.filter((r) => !isTrial(r)).length,
        총회원: persons.size,
        매출: rev,
        인건비: c?.인건비 ?? 0,
        임대료: c?.임대료 ?? 0,
        기타비용: c?.기타비용 ?? 0,
      };
    });
  }, [members, sales, costs, month]);

  const totalRow = useMemo(() => {
    if (!branchStats) return null;
    return branchStats.reduce(
      (a, s) => ({
        체험: a.체험 + s.체험,
        신규: a.신규 + s.신규,
        총회원: a.총회원 + s.총회원,
        매출: a.매출 + s.매출,
        인건비: a.인건비 + s.인건비,
        임대료: a.임대료 + s.임대료,
        기타비용: a.기타비용 + s.기타비용,
      }),
      { 체험: 0, 신규: 0, 총회원: 0, 매출: 0, 인건비: 0, 임대료: 0, 기타비용: 0 },
    );
  }, [branchStats]);

  // 분포 차트(전체 로스터, 지점 필터 적용) — 수강권 종류는 수강권명 기준(ticketType)
  const dist = useMemo(() => {
    if (!members) return null;
    const rows = chartBranch ? members.filter((r) => matchesBranch(r, chartBranch)) : members;
    return {
      byType: countBy(rows, (r) => ticketType(r['수강권명'])),
      byGender: countBy(rows, (r) => (r['성별'] as string) || '(없음)'),
    };
  }, [members, chartBranch]);

  return (
    <>
      <div className="mb-[22px]">
        <h2 className="m-0 mb-1 text-[22px]">대시보드</h2>
        <p className="m-0 text-[13px] text-muted">지점별 월간 운영 지표 · 매출 대비 비용 비율.</p>
      </div>

      {/* 월 선택 */}
      <div className="mb-[18px] flex flex-wrap items-end gap-[10px] rounded-xl border border-border bg-[#f7f8fa] px-[14px] py-3">
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          기준 월
          <select
            className="rounded-[10px] border border-border bg-white px-3 py-[9px] text-sm text-text"
            value={month}
            onChange={(e) => setMonth(e.target.value)}
          >
            {recentMonths(24).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>
        <p className="m-0 max-w-[420px] text-[12px] text-muted">
          체험·신규·매출·비용은 <strong>{month}</strong> 기준, 총 회원은 전체 로스터 기준입니다.
        </p>
      </div>

      {error ? (
        <div className="p-10 text-center text-sm text-muted">통계를 불러오지 못했습니다: {error}</div>
      ) : !branchStats || !totalRow || !dist ? (
        <div className="p-10 text-center text-sm text-muted">
          <span className={spinner} /> 통계를 불러오는 중…
        </div>
      ) : (
        <>
          {/* 지점별 표 */}
          <div className="mb-[18px] overflow-x-auto rounded-xl border border-border">
            <table className="w-full whitespace-nowrap border-collapse text-[13px]">
              <thead>
                <tr>
                  {['지점', '체험(월)', '신규등록(월)', '총 회원', '매출(월)', '비용(월)', '인건비율', '임대료율'].map(
                    (h) => (
                      <th
                        key={h}
                        className="border-b border-border bg-[#f7f8fa] px-3 py-[11px] text-right font-semibold first:text-left"
                      >
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {branchStats.map((s) => {
                  const 비용 = s.인건비 + s.임대료 + s.기타비용;
                  return (
                    <tr key={s.지점} className="hover:bg-[#fafbfc]">
                      <td className="border-b border-[#eef0f4] px-3 py-[10px] font-semibold">{s.지점}</td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px] text-right">{fmtNum(s.체험)}</td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px] text-right">{fmtNum(s.신규)}</td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px] text-right">{fmtNum(s.총회원)}</td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px] text-right">{fmtNum(s.매출)}</td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px] text-right">{fmtNum(비용)}</td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px] text-right">{ratio(s.인건비, s.매출)}</td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px] text-right">{ratio(s.임대료, s.매출)}</td>
                    </tr>
                  );
                })}
                <tr className="bg-[#f7f8fa] font-semibold">
                  <td className="px-3 py-[11px]">합계</td>
                  <td className="px-3 py-[11px] text-right">{fmtNum(totalRow.체험)}</td>
                  <td className="px-3 py-[11px] text-right">{fmtNum(totalRow.신규)}</td>
                  <td className="px-3 py-[11px] text-right">{fmtNum(totalRow.총회원)}</td>
                  <td className="px-3 py-[11px] text-right">{fmtNum(totalRow.매출)}</td>
                  <td className="px-3 py-[11px] text-right">
                    {fmtNum(totalRow.인건비 + totalRow.임대료 + totalRow.기타비용)}
                  </td>
                  <td className="px-3 py-[11px] text-right">{ratio(totalRow.인건비, totalRow.매출)}</td>
                  <td className="px-3 py-[11px] text-right">{ratio(totalRow.임대료, totalRow.매출)}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mb-[18px] text-xs text-muted">
            ※ 비율 = 매출 대비. 매출이 0이면 ‘—’. 비용은 비용 업로드 탭에서 엑셀로 넣습니다.
          </p>

          {/* 분포 차트 */}
          <div className="mb-[14px] flex items-end gap-[10px]">
            <label className="flex flex-col gap-1 text-[12px] text-muted">
              분포 지점 필터
              <select
                className="rounded-[10px] border border-border bg-white px-3 py-[9px] text-sm text-text"
                value={chartBranch}
                onChange={(e) => setChartBranch(e.target.value)}
              >
                <option value="">전체</option>
                {BRANCHES.map((b) => (
                  <option key={b} value={b}>
                    {b}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className={card}>
            <h3 className="m-0 mb-[14px] text-[15px]">수강권 종류별 분포 (수강권명 기준)</h3>
            <BarChart map={dist.byType} />
          </div>
          <div className={card}>
            <h3 className="m-0 mb-[14px] text-[15px]">성별 분포</h3>
            <BarChart map={dist.byGender} />
          </div>
          <p className="text-xs text-muted">※ 분포는 전체 로스터(최근 최대 50,000행) 기준입니다.</p>
        </>
      )}
    </>
  );
}
