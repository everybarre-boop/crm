'use client';

import { useEffect, useState } from 'react';
import { sb } from '@/lib/supabase';
import { TABLE, fetchAllRows, fmtNum, type MemberRecord } from '@/lib/members';
import { card, spinner } from '@/components/ui/styles';

function countBy(rows: MemberRecord[], col: string): Record<string, number> {
  const m: Record<string, number> = {};
  for (const r of rows) {
    const k = (r[col] as string) || '(없음)';
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
          <div className="w-[140px] flex-shrink-0 truncate" title={k}>
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

type Stats = {
  total: number;
  uniqueMembers: number;
  paySum: number;
  byType: Record<string, number>;
  byGender: Record<string, number>;
};

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { count, error: cErr } = await sb.from(TABLE).select('*', { count: 'exact', head: true });
        if (cErr) throw cErr;
        const rows = await fetchAllRows('이름,생년월일,성별,수강권종류,결제금액,등록일');
        if (!alive) return;

        const memberSet = new Set(rows.map((r) => (r['이름'] || '') + '|' + (r['생년월일'] || '')));
        const paySum = rows.reduce(
          (s, r) => s + (Number(String(r['결제금액'] ?? '').replace(/[^0-9.-]/g, '')) || 0),
          0,
        );
        setStats({
          total: count || 0,
          uniqueMembers: memberSet.size,
          paySum,
          byType: countBy(rows, '수강권종류'),
          byGender: countBy(rows, '성별'),
        });
      } catch (err) {
        if (alive) setError((err as Error).message || String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  return (
    <>
      <div className="mb-[22px]">
        <h2 className="m-0 mb-1 text-[22px]">대시보드</h2>
        <p className="m-0 text-[13px] text-muted">회원 데이터 요약 통계</p>
      </div>

      {error ? (
        <div className="p-10 text-center text-sm text-muted">통계를 불러오지 못했습니다: {error}</div>
      ) : !stats ? (
        <div className="p-10 text-center text-sm text-muted">
          <span className={spinner} /> 통계를 불러오는 중…
        </div>
      ) : (
        <>
          <div className="mb-[18px] grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-[14px]">
            <Stat label="전체 레코드" value={fmtNum(stats.total)} />
            <Stat label="고유 회원 수" value={fmtNum(stats.uniqueMembers)} />
            <Stat label="결제금액 합계" value={`${fmtNum(stats.paySum)}원`} small />
            <Stat label="수강권 종류" value={fmtNum(Object.keys(stats.byType).length)} />
          </div>
          <div className={card}>
            <h3 className="m-0 mb-[14px] text-[15px]">수강권 종류별 분포</h3>
            <BarChart map={stats.byType} />
          </div>
          <div className={card}>
            <h3 className="m-0 mb-[14px] text-[15px]">성별 분포</h3>
            <BarChart map={stats.byGender} />
          </div>
          <p className="text-xs text-muted">※ 분포·합계는 최근 최대 50,000행 기준입니다.</p>
        </>
      )}
    </>
  );
}

function Stat({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className="rounded-[14px] border border-border bg-card px-5 py-[18px]">
      <div className="text-[13px] text-muted">{label}</div>
      <div className={`mt-[6px] font-bold ${small ? 'text-[22px]' : 'text-[28px]'}`}>{value}</div>
    </div>
  );
}
