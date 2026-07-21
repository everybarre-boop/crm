'use client';

import type { Period, PeriodMode } from '@/lib/period';
import { currentYear } from '@/lib/period';

/* ======================================================================
   PeriodPicker — 년/반기/분기/월(+선택적 전체) 기간 선택기.
   대시보드·지점별 비용 집계가 공유한다. 컨트롤드 컴포넌트.
   ====================================================================== */

const sel = 'rounded-[10px] border border-border bg-white px-3 py-[9px] text-sm text-text';

const MODES: { v: Exclude<PeriodMode, 'all'>; label: string }[] = [
  { v: 'year', label: '년' },
  { v: 'half', label: '반기' },
  { v: 'quarter', label: '분기' },
  { v: 'month', label: '월' },
];

function unitOptions(mode: PeriodMode): { v: number; label: string }[] {
  if (mode === 'half')
    return [
      { v: 1, label: '상반기' },
      { v: 2, label: '하반기' },
    ];
  if (mode === 'quarter') return [1, 2, 3, 4].map((q) => ({ v: q, label: `${q}분기` }));
  if (mode === 'month') return Array.from({ length: 12 }, (_, i) => ({ v: i + 1, label: `${i + 1}월` }));
  return [];
}

function unitCap(mode: PeriodMode): number {
  return mode === 'half' ? 2 : mode === 'quarter' ? 4 : mode === 'month' ? 12 : 0;
}

function defaultYears(): number[] {
  const y = currentYear();
  return [y, y - 1, y - 2, y - 3];
}

export default function PeriodPicker({
  value,
  onChange,
  years,
  allowAll = false,
}: {
  value: Period;
  onChange: (p: Period) => void;
  years?: number[];
  allowAll?: boolean;
}) {
  const yrs = years && years.length ? years : defaultYears();
  const modes: { v: PeriodMode; label: string }[] = allowAll
    ? [{ v: 'all', label: '전체' }, ...MODES]
    : MODES;
  const opts = unitOptions(value.mode);

  function setMode(mode: PeriodMode) {
    const cap = unitCap(mode);
    const unit = cap ? Math.min(Math.max(value.unit || 1, 1), cap) : value.unit;
    onChange({ ...value, mode, unit });
  }

  return (
    <div className="flex flex-wrap items-end gap-[10px]">
      <label className="flex flex-col gap-1 text-[12px] text-muted">
        기간 단위
        <select className={sel} value={value.mode} onChange={(e) => setMode(e.target.value as PeriodMode)}>
          {modes.map((m) => (
            <option key={m.v} value={m.v}>
              {m.label}
            </option>
          ))}
        </select>
      </label>

      {value.mode !== 'all' && (
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          연도
          <select
            className={sel}
            value={value.year}
            onChange={(e) => onChange({ ...value, year: Number(e.target.value) })}
          >
            {yrs.map((y) => (
              <option key={y} value={y}>
                {y}년
              </option>
            ))}
          </select>
        </label>
      )}

      {opts.length > 0 && (
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          {value.mode === 'half' ? '반기' : value.mode === 'quarter' ? '분기' : '월'}
          <select
            className={sel}
            value={value.unit}
            onChange={(e) => onChange({ ...value, unit: Number(e.target.value) })}
          >
            {opts.map((o) => (
              <option key={o.v} value={o.v}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}
