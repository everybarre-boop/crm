'use client';

import { addDays, shortDate, todayStr } from '@/lib/crm';
import { btn } from '@/components/ui/styles';

/* ======================================================================
   일 단위 기준일 + 범위 선택기.
   PeriodPicker 는 월 단위(년/반기/분기/월)라 "내일 수업 명단" 화면에는 못 쓴다.
   CRM 실행 · 자동화 로그가 공유한다.
   ====================================================================== */

const SPANS = [
  { v: 1, label: '당일' },
  { v: 3, label: '최근 3일' },
  { v: 7, label: '최근 7일' },
];

export default function DayRangePicker({
  date,
  span,
  onDate,
  onSpan,
}: {
  date: string;
  span: number;
  onDate: (d: string) => void;
  onSpan: (n: number) => void;
}) {
  const today = todayStr();
  return (
    <div className="flex flex-wrap items-center gap-[10px]">
      <div className="flex items-center gap-1">
        <button className={btn.ghostSm} onClick={() => onDate(addDays(date, -1))} aria-label="하루 전">
          ◀
        </button>
        <input
          type="date"
          value={date}
          onChange={(e) => onDate(e.target.value || today)}
          className="rounded-[10px] border border-border px-3 py-[7px] text-[13px] outline-none focus:border-primary"
        />
        <button className={btn.ghostSm} onClick={() => onDate(addDays(date, 1))} aria-label="하루 뒤">
          ▶
        </button>
      </div>

      <span className="text-[13px] font-semibold text-muted">{shortDate(date)}</span>

      {date !== today && (
        <button className={btn.ghostSm} onClick={() => onDate(today)}>
          오늘
        </button>
      )}

      <div className="flex overflow-hidden rounded-[10px] border border-border">
        {SPANS.map((s) => (
          <button
            key={s.v}
            onClick={() => onSpan(s.v)}
            className={[
              'cursor-pointer border-none px-3 py-[7px] text-[13px] font-medium',
              span === s.v ? 'bg-primary text-white' : 'bg-transparent text-muted hover:bg-[#f1f3f7]',
            ].join(' ')}
          >
            {s.label}
          </button>
        ))}
      </div>
    </div>
  );
}
