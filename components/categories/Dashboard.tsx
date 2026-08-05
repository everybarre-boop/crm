'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  fetchAllRows,
  fmtNum,
  ymKey,
  ticketType,
  isTrial,
  makePersonResolver,
  regDate,
  matchesBranch,
  BRANCHES,
  type MemberRecord,
} from '@/lib/members';
import { SALES_TABLE } from '@/lib/sales';
import { COSTS_TABLE, type BranchCost } from '@/lib/costs';
import { defaultPeriod, inPeriod, periodLabel, type Period } from '@/lib/period';
import PeriodPicker from '@/components/ui/PeriodPicker';
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

  const [period, setPeriod] = useState<Period>(defaultPeriod());
  const [chartBranch, setChartBranch] = useState('');

  // members·sales·costs 를 한 번씩 모두 읽어 두고(비용 테이블은 작다) 기간 필터는 클라이언트에서.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [m, s, c] = await Promise.all([
          // 수강권시작일 = 등록일이 빈 경우의 대체 기준(regDate). 둘 다 받아야 한다.
          // dedup_key: makePersonResolver 가 "동명이인 + 연락처 빈 행"을 행 단위로 구분하는 기준.
          fetchAllRows(
            'dedup_key,이름,연락처,성별,수강권명,수강권종류,등록일,수강권시작일,전체횟수,잔여횟수',
          ),
          fetchAllRows('dedup_key,이름,연락처,수강권명,결제금액,결제일시', 50000, SALES_TABLE).catch(
            () => [] as MemberRecord[],
          ),
          (async () => {
            const { data } = await sb.from(COSTS_TABLE).select('*');
            return (data as BranchCost[]) || [];
          })().catch(() => [] as BranchCost[]),
        ]);
        if (!alive) return;
        setMembers(m);
        setSales(s);
        setCosts(c);
      } catch (err) {
        if (alive) setError((err as Error).message || String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 선택 기간에 포함되는 연도 목록(데이터 기준, 없으면 PeriodPicker 기본값)
  const years = useMemo(() => {
    const set = new Set<number>();
    const add = (v: unknown) => {
      const mt = /^(\d{4})/.exec(String(v ?? ''));
      if (mt) set.add(Number(mt[1]));
    };
    members?.forEach((r) => add(regDate(r)));
    sales.forEach((r) => add(r['결제일시']));
    costs.forEach((c) => add(c.연월));
    return Array.from(set).sort((a, b) => b - a);
  }, [members, sales, costs]);

  /* 동일인 판정기 — members+sales 전 행을 훑어 이름별 연락처 목록을 만드는 O(n) 작업이라
     기간(period)이 바뀔 때마다 다시 만들면 안 된다(기간 피커 드래그마다 3만 행 재스캔). */
  const personKeyOf = useMemo(() => makePersonResolver(members ?? [], sales), [members, sales]);

  // 지점별 지표
  const branchStats = useMemo<BranchStat[] | null>(() => {
    if (!members) return null;
    // 지점이 달라도 이름+연락처가 같으면 한 사람 — 지점별 "총회원"은 그 지점에 등록건이
    // 있는 사람 수를 센다(전 지점 공통 기준으로 묶은 뒤 세므로 사람 단위가 일관된다).
    const keyOf = personKeyOf;
    return BRANCHES.map((b) => {
      const inBranch = members.filter((r) => matchesBranch(r, b));
      const periodRegs = inBranch.filter((r) => inPeriod(ymKey(regDate(r)), period));
      const persons = new Set(inBranch.map((r) => keyOf(r)));
      const rev = sales
        .filter((r) => matchesBranch(r, b) && inPeriod(ymKey(r['결제일시']), period))
        .reduce((s, r) => s + money(r['결제금액']), 0);
      const c = costs
        .filter((c) => c.지점 === b && inPeriod(c.연월, period))
        .reduce(
          (a, r) => ({
            인건비: a.인건비 + (r.인건비 || 0),
            임대료: a.임대료 + (r.임대료 || 0),
            기타비용: a.기타비용 + (r.기타비용 || 0),
          }),
          { 인건비: 0, 임대료: 0, 기타비용: 0 },
        );
      return {
        지점: b,
        체험: periodRegs.filter((r) => isTrial(r)).length,
        신규: periodRegs.filter((r) => !isTrial(r)).length,
        총회원: persons.size,
        매출: rev,
        인건비: c.인건비,
        임대료: c.임대료,
        기타비용: c.기타비용,
      };
    });
  }, [members, sales, costs, period, personKeyOf]);

  const totalRow = useMemo(() => {
    if (!branchStats || !members) return null;
    const sum = branchStats.reduce(
      (a, s) => ({
        체험: a.체험 + s.체험,
        신규: a.신규 + s.신규,
        매출: a.매출 + s.매출,
        인건비: a.인건비 + s.인건비,
        임대료: a.임대료 + s.임대료,
        기타비용: a.기타비용 + s.기타비용,
      }),
      { 체험: 0, 신규: 0, 매출: 0, 인건비: 0, 임대료: 0, 기타비용: 0 },
    );
    /* 총회원만은 지점별 값을 더하면 안 된다 — 판교·반포·옥수에 등록건이 있는 이가원이
       세 지점 Set 에 각각 들어가 3명으로 세어진다. "지점이 사람을 나누지 않는다"는
       이 앱의 기본 규칙과 어긋나고, 회원 관리 화면의 "총 회원" 칩과도 숫자가 달라진다.
       그래서 전 회원을 한 번에 중복 제거해서 센다. */
    const 총회원 = new Set(members.map((r) => personKeyOf(r))).size;
    return { ...sum, 총회원 };
  }, [branchStats, members, personKeyOf]);

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

      {/* 기간 선택 (년/반기/분기/월) */}
      <div className="mb-[18px] flex flex-wrap items-end gap-[14px] rounded-xl border border-border bg-[#f7f8fa] px-[14px] py-3">
        <PeriodPicker value={period} onChange={setPeriod} years={years} />
        <p className="m-0 max-w-[420px] text-[12px] text-muted">
          체험·신규·매출·비용은 <strong>{periodLabel(period)}</strong> 기준, 총 회원은 전체 로스터 기준입니다.
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
                  {['지점', '체험', '신규등록', '총 회원', '매출', '비용', '인건비율', '임대료율'].map(
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
