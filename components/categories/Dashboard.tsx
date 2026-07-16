'use client';

import { useEffect, useMemo, useState } from 'react';
import { fetchAllRows, fmtNum, usedCount, FILTER_COLS, type MemberRecord } from '@/lib/members';
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

export default function Dashboard() {
  const [rows, setRows] = useState<MemberRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 회원 관리와 동일한 필터 (성별·수강권종류 + 사용횟수 범위). 대시보드는 이미 전체 행을
  // 가져오므로, 필터는 클라이언트에서 적용해 통계를 다시 계산한다.
  const [filters, setFilters] = useState<Record<string, string>>({});
  const [usedMin, setUsedMin] = useState('');
  const [usedMax, setUsedMax] = useState('');

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const data = await fetchAllRows('이름,생년월일,성별,수강권종류,결제금액,등록일,전체횟수,잔여횟수');
        if (alive) setRows(data);
      } catch (err) {
        if (alive) setError((err as Error).message || String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 드롭다운 옵션(성별·수강권종류)
  const options = useMemo(() => {
    const opt: Record<string, string[]> = {};
    for (const c of FILTER_COLS) {
      opt[c] = rows
        ? [...new Set(rows.map((r) => (r[c] as string) || '').filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ko'))
        : [];
    }
    return opt;
  }, [rows]);

  // 필터 적용 후 통계 산출
  const stats = useMemo(() => {
    if (!rows) return null;
    const min = usedMin !== '' && !isNaN(Number(usedMin)) ? Number(usedMin) : null;
    const max = usedMax !== '' && !isNaN(Number(usedMax)) ? Number(usedMax) : null;
    const filtered = rows.filter((r) => {
      for (const c of FILTER_COLS) {
        if (filters[c] && ((r[c] as string) || '') !== filters[c]) return false;
      }
      if (min !== null || max !== null) {
        const u = usedCount(r);
        if (min !== null && u < min) return false;
        if (max !== null && u > max) return false;
      }
      return true;
    });
    const memberSet = new Set(filtered.map((r) => (r['이름'] || '') + '|' + (r['생년월일'] || '')));
    const paySum = filtered.reduce(
      (s, r) => s + (Number(String(r['결제금액'] ?? '').replace(/[^0-9.-]/g, '')) || 0),
      0,
    );
    return {
      total: filtered.length,
      uniqueMembers: memberSet.size,
      paySum,
      byType: countBy(filtered, '수강권종류'),
      byGender: countBy(filtered, '성별'),
    };
  }, [rows, filters, usedMin, usedMax]);

  const filtered = !!(filters['성별'] || filters['수강권종류'] || usedMin !== '' || usedMax !== '');

  return (
    <>
      <div className="mb-[22px]">
        <h2 className="m-0 mb-1 text-[22px]">대시보드</h2>
        <p className="m-0 text-[13px] text-muted">회원 데이터 요약 통계 · 필터로 좁혀 볼 수 있습니다.</p>
      </div>

      {/* 필터 바 (회원 관리와 동일) */}
      <div className="mb-[18px] flex flex-wrap items-end gap-x-[10px] gap-y-3 rounded-xl border border-border bg-[#f7f8fa] px-[14px] py-3">
        {FILTER_COLS.map((c) => (
          <label key={c} className="flex flex-col gap-1 text-[12px] text-muted">
            {c}
            <select
              className="rounded-[10px] border border-border bg-white px-3 py-[9px] text-sm text-text"
              value={filters[c] ?? ''}
              disabled={!rows}
              onChange={(e) => setFilters((s) => ({ ...s, [c]: e.target.value }))}
            >
              <option value="">전체</option>
              {(options[c] ?? []).map((v) => (
                <option key={v} value={v}>
                  {v}
                </option>
              ))}
            </select>
          </label>
        ))}

        <label className="flex flex-col gap-1 text-[12px] text-muted">
          사용횟수(전체−잔여)
          <div className="flex items-center gap-[6px]">
            <input
              type="number"
              min={0}
              inputMode="numeric"
              className="w-[84px] rounded-[10px] border border-border bg-white px-3 py-[9px] text-sm"
              placeholder="최소"
              value={usedMin}
              onChange={(e) => setUsedMin(e.target.value)}
            />
            <span className="text-muted">~</span>
            <input
              type="number"
              min={0}
              inputMode="numeric"
              className="w-[84px] rounded-[10px] border border-border bg-white px-3 py-[9px] text-sm"
              placeholder="최대"
              value={usedMax}
              onChange={(e) => setUsedMax(e.target.value)}
            />
          </div>
        </label>

        <button
          className="rounded-[10px] border border-border bg-white px-3 py-[9px] text-[13px] font-semibold hover:bg-[#f1f3f7]"
          onClick={() => {
            setFilters({});
            setUsedMin('');
            setUsedMax('');
          }}
        >
          필터 초기화
        </button>
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
            <Stat label={filtered ? '조건 레코드' : '전체 레코드'} value={fmtNum(stats.total)} />
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
