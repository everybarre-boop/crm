'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { sb } from '@/lib/supabase';
import { BRANCHES, fmtNum } from '@/lib/members';
import {
  CRM_MSG_TABLE,
  RESV_TABLE,
  RUNS_TABLE,
  STEP_LABEL,
  addDays,
  crmErrorHint,
  hhmm,
  shortDate,
  sinceText,
  todayStr,
  type DailyRun,
} from '@/lib/crm';
import { Modal } from '@/components/ui/Modal';
import { btn, spinner } from '@/components/ui/styles';

/* ======================================================================
   자동화 로그 — 매일 21:00(KST) GitHub Actions 실행 결과를 본다.
   ---------------------------------------------------------------------
   이 화면이 필요한 이유: 지점 하나만 스크랩이 실패해도 워크플로는 초록불로 끝날 수
   있다. 그러면 그 지점 강사만 CRM 이 조용히 끊긴다. 지점 × 날짜 매트릭스가 그걸 잡는다.

   ⚠️ reservations 는 매일 수백 행씩 쌓이므로 **반드시 최근 7일로 끊어서** 읽는다.
      (컬럼도 2개만 — 지점×일자 카운트에 그 이상은 필요 없다)
   ⚠️ 미매칭 명단은 회원 실명이라 CSV 내보내기 버튼을 두지 않는다.
   ====================================================================== */

const DAYS = 7;

type Fail = { 대상일자: string; 지점: string; 이름: string; rule_id: string; 발송오류: string };

export default function Automation() {
  const [runs, setRuns] = useState<DailyRun[] | null>(null);
  const [cells, setCells] = useState<Map<string, number> | null>(null);
  const [fails, setFails] = useState<Fail[] | null>(null);
  const [sentToday, setSentToday] = useState<{ 발송: number; 실패: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [detail, setDetail] = useState<DailyRun | null>(null);

  const today = todayStr();
  const from = useMemo(() => addDays(today, -(DAYS - 1)), [today]);
  const days = useMemo(
    () => Array.from({ length: DAYS }, (_, i) => addDays(today, -i)),
    [today],
  );

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [r, v, f, s] = await Promise.all([
        sb.from(RUNS_TABLE).select('*').order('run_at', { ascending: false }).limit(120),
        // 지점×일자 카운트 전용 — 날짜로 끊고 컬럼도 2개만
        sb.from(RESV_TABLE).select('예약일자,지점').gte('예약일자', from).lte('예약일자', addDays(today, 1)),
        sb
          .from(CRM_MSG_TABLE)
          .select('대상일자,지점,이름,rule_id,발송오류')
          .not('발송오류', 'is', null)
          .gte('대상일자', addDays(today, -30))
          .order('대상일자', { ascending: false })
          .limit(200),
        sb
          .from(CRM_MSG_TABLE)
          .select('발송여부,발송오류')
          .gte('대상일자', today)
          .lte('대상일자', addDays(today, 1)),
      ]);
      if (r.error) throw r.error;
      if (v.error) throw v.error;
      if (f.error) throw f.error;
      if (s.error) throw s.error;

      setRuns((r.data as DailyRun[]) || []);

      const map = new Map<string, number>();
      for (const row of (v.data as unknown as { 예약일자: string; 지점: string }[]) || []) {
        const k = `${row.지점}|${row.예약일자}`;
        map.set(k, (map.get(k) ?? 0) + 1);
      }
      setCells(map);
      setFails((f.data as unknown as Fail[]) || []);

      const rows = (s.data as unknown as { 발송여부: boolean; 발송오류: string | null }[]) || [];
      setSentToday({
        발송: rows.filter((x) => x.발송여부 && !x.발송오류).length,
        실패: rows.filter((x) => x.발송오류).length,
      });
      setError(null);
    } catch (err) {
      setError(crmErrorHint((err as Error).message || String(err)));
    } finally {
      setRefreshing(false);
    }
  }, [from, today]);

  useEffect(() => {
    load();
  }, [load]);

  const lastRun = runs?.[0]?.run_at ?? null;
  const stale = lastRun ? Date.now() - new Date(lastRun).getTime() > 24 * 3600 * 1000 : true;

  const 오늘수집 = useMemo(() => {
    if (!cells) return 0;
    let n = 0;
    for (const [k, v] of cells) if (k.endsWith(`|${today}`) || k.endsWith(`|${addDays(today, 1)}`)) n += v;
    return n;
  }, [cells, today]);

  const 미매칭7일 = useMemo(
    () =>
      (runs || [])
        .filter((r) => r.단계 === 'attendance' && r.run_at >= from)
        .reduce((s, r) => s + (Array.isArray(r.미매칭) ? r.미매칭.length : 0), 0),
    [runs, from],
  );

  const cardCls = 'rounded-[14px] border border-border bg-card p-[18px]';

  return (
    <>
      <div className="mb-[22px]">
        <h2 className="m-0 mb-1 text-[22px]">자동화 로그</h2>
        <p className="m-0 text-[13px] text-muted">
          매일 21:00(KST) GitHub Actions 실행 결과입니다. 지점 하나가 조용히 실패하고 있지 않은지
          확인하세요.
        </p>
      </div>

      <div className="mb-[18px] flex flex-wrap items-end gap-[14px] rounded-xl border border-border bg-[#f7f8fa] px-[14px] py-3">
        <button className={btn.ghostSm} onClick={load} disabled={refreshing}>
          {refreshing ? '새로고침 중…' : '↻ 새로고침'}
        </button>
        <p className="m-0 text-[12px] text-muted">최근 {DAYS}일 수집 현황과 최근 실행 이력입니다.</p>
      </div>

      {error ? (
        <div className="whitespace-pre-line p-10 text-center text-sm text-muted">
          자동화 로그를 불러오지 못했습니다: {error}
        </div>
      ) : !runs || !cells ? (
        <div className="p-10 text-center text-sm text-muted">
          <span className={spinner} /> 불러오는 중…
        </div>
      ) : (
        <>
          {/* 요약 카드 */}
          <div className="mb-[18px] grid grid-cols-2 gap-[14px] sm:grid-cols-4">
            <div className={stale ? `${cardCls} border-danger bg-danger-soft` : cardCls}>
              <div className="text-[12px] text-muted">마지막 실행</div>
              <div className={`mt-1 text-[22px] font-bold ${stale ? 'text-danger' : ''}`}>
                {sinceText(lastRun)}
              </div>
              {stale && <div className="mt-1 text-[11px] text-danger">24시간 넘게 안 돌았습니다</div>}
            </div>
            <div className={cardCls}>
              <div className="text-[12px] text-muted">오늘·내일 수집 예약</div>
              <div className="mt-1 text-[22px] font-bold">{fmtNum(오늘수집)}</div>
            </div>
            <div className={cardCls}>
              <div className="text-[12px] text-muted">오늘 슬랙 발송</div>
              <div className="mt-1 text-[22px] font-bold">
                {fmtNum(sentToday?.발송 ?? 0)}
                {(sentToday?.실패 ?? 0) > 0 && (
                  <span className="ml-2 text-[13px] font-semibold text-danger">
                    실패 {sentToday?.실패}
                  </span>
                )}
              </div>
            </div>
            <div className={cardCls}>
              <div className="text-[12px] text-muted">최근 {DAYS}일 미매칭</div>
              <div className="mt-1 text-[22px] font-bold">{fmtNum(미매칭7일)}</div>
            </div>
          </div>

          {/* 지점 × 최근 7일 수집 매트릭스 — 조용한 실패를 잡는 핵심 */}
          <h3 className="mb-2 mt-6 text-[15px] font-semibold">지점별 수집 현황</h3>
          <div className="mb-[10px] overflow-x-auto rounded-xl border border-border">
            <table className="w-full whitespace-nowrap border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className="border-b border-border bg-[#f7f8fa] px-3 py-[11px] text-left font-semibold">
                    지점
                  </th>
                  {days.map((d) => (
                    <th
                      key={d}
                      className="border-b border-border bg-[#f7f8fa] px-3 py-[11px] text-right font-semibold"
                    >
                      {shortDate(d)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {BRANCHES.map((b) => (
                  <tr key={b} className="hover:bg-[#fafbfc]">
                    <td className="border-b border-[#eef0f4] px-3 py-[10px] font-semibold">{b}</td>
                    {days.map((d) => {
                      const n = cells.get(`${b}|${d}`) ?? 0;
                      return (
                        <td
                          key={d}
                          className={[
                            'border-b border-[#eef0f4] px-3 py-[10px] text-right',
                            n === 0 ? 'bg-danger-soft text-danger' : '',
                          ].join(' ')}
                        >
                          {n === 0 ? '—' : fmtNum(n)}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mb-6 text-xs text-muted">
            ※ 빨간 칸은 그날 그 지점에서 예약을 한 건도 못 가져왔다는 뜻입니다. 휴무일이면 정상이지만,
            평일에 연속으로 비어 있으면 그 지점 스크랩이 실패하고 있는 것입니다.
          </p>

          {/* 최근 실행 (daily_runs) */}
          <h3 className="mb-2 text-[15px] font-semibold">최근 실행</h3>
          <div className="mb-6 overflow-x-auto rounded-xl border border-border">
            <table className="w-full whitespace-nowrap border-collapse text-[13px]">
              <thead>
                <tr>
                  {['실행시각', '단계', '대상일자', '지점', '모드', '요청', '반영', '미매칭'].map((h) => (
                    <th
                      key={h}
                      className="border-b border-border bg-[#f7f8fa] px-3 py-[11px] text-right font-semibold first:text-left [&:nth-child(2)]:text-left [&:nth-child(4)]:text-left"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {runs.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-3 py-10 text-center text-muted">
                      아직 실행 기록이 없습니다. GitHub Actions 의 <code>daily-update</code> 워크플로를
                      수동 실행해 보세요.
                    </td>
                  </tr>
                ) : (
                  runs.slice(0, 40).map((r) => (
                    <tr
                      key={r.id}
                      className="cursor-pointer hover:bg-[#fafbfc]"
                      onClick={() => setDetail(r)}
                    >
                      <td className="border-b border-[#eef0f4] px-3 py-[10px]">
                        {r.run_at?.slice(5, 10)} {hhmm(r.run_at)}
                      </td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px]">
                        {STEP_LABEL[r.단계] ?? r.단계}
                      </td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px] text-right text-muted">
                        {r.대상일자 ?? '—'}
                      </td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px]">{r.지점 ?? '—'}</td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px] text-right">
                        {r.dry_run ? (
                          <span className="rounded-[6px] bg-[#eef1f6] px-[6px] py-[2px] text-[11px] text-muted">
                            dry-run
                          </span>
                        ) : (
                          <span className="rounded-[6px] bg-success-soft px-[6px] py-[2px] text-[11px] text-success">
                            반영
                          </span>
                        )}
                      </td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px] text-right">
                        {fmtNum(r.요청건수)}
                      </td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px] text-right">
                        {fmtNum(r.반영건수)}
                      </td>
                      <td
                        className={[
                          'border-b border-[#eef0f4] px-3 py-[10px] text-right',
                          (r.미매칭?.length ?? 0) > 0 ? 'font-semibold text-danger' : 'text-muted',
                        ].join(' ')}
                      >
                        {r.미매칭?.length ?? 0}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {/* 슬랙 발송 실패 */}
          <h3 className="mb-2 text-[15px] font-semibold">슬랙 발송 실패 (최근 30일)</h3>
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full whitespace-nowrap border-collapse text-[13px]">
              <thead>
                <tr>
                  {['대상일자', '지점', '회원', '규칙', '오류'].map((h) => (
                    <th
                      key={h}
                      className="border-b border-border bg-[#f7f8fa] px-3 py-[11px] text-left font-semibold"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!fails || fails.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-10 text-center text-muted">
                      발송 실패가 없습니다.
                    </td>
                  </tr>
                ) : (
                  fails.map((f, i) => (
                    <tr key={i} className="hover:bg-[#fafbfc]">
                      <td className="border-b border-[#eef0f4] px-3 py-[10px]">{f.대상일자}</td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px]">{f.지점}</td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px]">{f.이름}</td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px] text-muted">{f.rule_id}</td>
                      <td className="max-w-[360px] truncate border-b border-[#eef0f4] px-3 py-[10px] text-danger">
                        {f.발송오류}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* 미매칭 상세 */}
      <Modal open={!!detail} onClose={() => setDetail(null)}>
        <h3 className="m-0 mb-1 text-[17px]">
          {STEP_LABEL[detail?.단계 ?? ''] ?? detail?.단계} · {detail?.지점 ?? '전체'}
        </h3>
        <p className="m-0 mb-4 text-[12px] text-muted">
          {detail?.run_at?.slice(0, 16).replace('T', ' ')} · 요청 {detail?.요청건수} / 반영{' '}
          {detail?.반영건수} · {detail?.dry_run ? 'dry-run' : '반영됨'}
        </p>
        {!detail?.미매칭?.length ? (
          <p className="text-sm text-muted">미매칭 없음.</p>
        ) : (
          <div className="max-h-[50vh] overflow-auto rounded-xl border border-border">
            <table className="w-full border-collapse text-[13px]">
              <tbody>
                {detail.미매칭.map((u, i) => (
                  <tr key={i}>
                    <td className="border-b border-[#eef0f4] px-3 py-2">
                      {Object.entries(u)
                        .map(([k, v]) => `${k}: ${v ?? '—'}`)
                        .join(' · ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-muted">
          ※ 미매칭 = 스튜디오메이트에는 있는데 members 에서 이름·연락처·수강권명이 안 맞는 건입니다.
          주간 엑셀 재업로드로 대부분 해소됩니다.
        </p>
        <div className="mt-4 text-right">
          <button className={btn.ghost} onClick={() => setDetail(null)}>
            닫기
          </button>
        </div>
      </Modal>
    </>
  );
}
