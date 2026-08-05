'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { sb } from '@/lib/supabase';
import { BRANCHES, fmtNum } from '@/lib/members';
import {
  CRM_DORMANT_TABLE,
  CRM_MSG_TABLE,
  CRM_RULE_TABLE,
  HISTORY_VIEW,
  MSG_SELECT,
  REACTIONS,
  addDays,
  crmErrorHint,
  evidenceChips,
  hhmm,
  shortDate,
  todayStr,
  type CrmDormant,
  type CrmMessage,
  type CrmRule,
  type Reaction,
} from '@/lib/crm';
import { Modal } from '@/components/ui/Modal';
import DayRangePicker from '@/components/ui/DayRangePicker';
import { useToast } from '@/components/ui/Toast';
import { btn, input, spinner } from '@/components/ui/styles';

/* ======================================================================
   CRM 실행 — 야간 자동화가 만들어 둔 멘트 명단을 보고, 실제로 멘트했는지 체크한다.
   ---------------------------------------------------------------------
   ⚠️ 슬랙은 발송 전용이다(서버가 없어 버튼 응답을 받을 엔드포인트를 못 만든다).
      그래서 강사 피드백은 **오직 이 화면에서만** 쌓인다. 입력률이 곧 CRM 성과 지표의
      신뢰도이므로, 마찰을 줄이는 것(일괄 체크·낙관적 업데이트)이 기능이 아니라 생존 조건이다.

   ⚠️ RLS 아래에서는 **0행 UPDATE 도 error 없이 성공**한다. 그래서 저장 후 .select('id')
      로 되받은 행 수를 세어 요청한 개수와 다르면 롤백한다.

   이 화면은 reservations 를 읽지 않는다 — 야간 잡이 crm_messages 에 결과를 미리 써 두기
   때문이다. 그래서 매일 여는 화면인데도 무겁지 않다.
   ====================================================================== */

type Preset = 'slack' | 'dormant';
type Status = '전체' | '미입력' | '함' | '못함';
const CHUNK = 200; // .in('id', …) URL 길이 방어

export default function Crm() {
  const toast = useToast();

  const [rules, setRules] = useState<CrmRule[] | null>(null);
  const [rows, setRows] = useState<CrmMessage[] | null>(null);
  const [dormant, setDormant] = useState<CrmDormant[] | null>(null);
  const [historyDays, setHistoryDays] = useState<number | null>(null);
  const [historyStart, setHistoryStart] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [preset, setPreset] = useState<Preset>('slack');
  const [date, setDate] = useState(todayStr());
  const [span, setSpan] = useState(1);
  const [branch, setBranch] = useState('');
  const [ruleId, setRuleId] = useState('');
  const [status, setStatus] = useState<Status>('전체');
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [memoOf, setMemoOf] = useState<CrmMessage | null>(null);
  const [memoText, setMemoText] = useState('');

  // 슬랙 메시지의 딥링크(#crm?date=2026-08-06)로 들어온 경우 기준일을 맞춰 준다
  useEffect(() => {
    const q = new URLSearchParams(location.hash.split('?')[1] ?? '');
    const d = q.get('date');
    if (d && /^\d{4}-\d{2}-\d{2}$/.test(d)) setDate(d);
  }, []);

  const from = useMemo(() => addDays(date, -(span - 1)), [date, span]);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [r, m, d, h] = await Promise.all([
        sb.from(CRM_RULE_TABLE).select('*').order('정렬순서', { ascending: true }),
        // ⚠️ 날짜는 반드시 서버에서 끊는다. crm_messages 는 연 2만 행까지 자란다.
        sb
          .from(CRM_MSG_TABLE)
          .select(MSG_SELECT)
          .gte('대상일자', from)
          .lte('대상일자', date)
          .order('대상일자', { ascending: false })
          .order('수업시간', { ascending: true })
          .order('id', { ascending: true }),
        sb.from(CRM_DORMANT_TABLE).select('*').order('경과일', { ascending: false }),
        sb.from(HISTORY_VIEW).select('*').maybeSingle(),
      ]);
      if (r.error) throw r.error;
      if (m.error) throw m.error;
      if (d.error) throw d.error;
      if (h.error) throw h.error;

      setRules((r.data as CrmRule[]) || []);
      setRows((m.data as unknown as CrmMessage[]) || []);
      setDormant((d.data as CrmDormant[]) || []);
      setHistoryDays(Number((h.data as { 관측일수?: number } | null)?.관측일수 ?? 0));
      setHistoryStart(((h.data as { 이력시작일?: string } | null)?.이력시작일) ?? null);
      setSel(new Set());
      setError(null);
    } catch (err) {
      setError(crmErrorHint((err as Error).message || String(err)));
    } finally {
      setRefreshing(false);
    }
  }, [from, date]);

  useEffect(() => {
    load();
  }, [load]);

  const ruleById = useMemo(() => new Map((rules ?? []).map((r) => [r.id, r])), [rules]);
  const slackRules = useMemo(() => (rules ?? []).filter((r) => r.슬랙발송), [rules]);

  const filtered = useMemo(() => {
    if (!rows) return null;
    return rows.filter((r) => {
      const rule = ruleById.get(r.rule_id);
      if (rule && !rule.슬랙발송) return false; // 휴면은 별도 프리셋에서 본다
      if (branch && r.지점 !== branch) return false;
      if (ruleId && r.rule_id !== ruleId) return false;
      if (status === '미입력' && r.실행여부 !== null) return false;
      if (status === '함' && r.실행여부 !== true) return false;
      if (status === '못함' && r.실행여부 !== false) return false;
      return true;
    });
  }, [rows, ruleById, branch, ruleId, status]);

  const dormantView = useMemo(() => {
    if (!dormant) return null;
    return dormant.filter((d) => {
      if (branch && d.마지막지점 !== branch) return false;
      if (status === '미입력' && d.조치여부 !== null) return false;
      if (status === '함' && d.조치여부 !== true) return false;
      if (status === '못함' && d.조치여부 !== false) return false;
      return true;
    });
  }, [dormant, branch, status]);

  const chips = useMemo(() => {
    if (!filtered) return null;
    const 입력 = filtered.filter((r) => r.실행여부 !== null).length;
    return {
      대상: filtered.length,
      성공: filtered.filter((r) => r.발송여부 && !r.발송오류).length,
      실패: filtered.filter((r) => !!r.발송오류).length,
      입력,
      입력률: filtered.length ? Math.round((입력 / filtered.length) * 100) : 0,
      함: filtered.filter((r) => r.실행여부 === true).length,
      못함: filtered.filter((r) => r.실행여부 === false).length,
    };
  }, [filtered]);

  /* ── 피드백 저장 (낙관적 업데이트 + 실패 롤백) ─────────────────────────── */
  const applyFeedback = useCallback(
    async (ids: number[], patch: Partial<Pick<CrmMessage, '실행여부' | '반응' | '메모'>>) => {
      if (!ids.length || !rows) return;
      const before = rows;
      const email = (await sb.auth.getUser()).data.user?.email ?? null;
      const stamp = { 피드백시각: new Date().toISOString(), 피드백작성자: email };
      const idset = new Set(ids);
      setRows(rows.map((r) => (idset.has(r.id) ? { ...r, ...patch, ...stamp } : r)));

      try {
        let saved = 0;
        for (let i = 0; i < ids.length; i += CHUNK) {
          const { data, error } = await sb
            .from(CRM_MSG_TABLE)
            .update({ ...patch, ...stamp, updated_at: new Date().toISOString() })
            .in('id', ids.slice(i, i + CHUNK))
            .select('id');
          if (error) throw error;
          saved += data?.length ?? 0;
        }
        // RLS 아래에선 0행 갱신도 성공으로 보인다 → 반영 행 수를 직접 확인한다
        if (saved !== ids.length) {
          throw new Error(
            `${ids.length}건 중 ${saved}건만 저장됐습니다. 관리자 계정으로 로그인했는지(RLS) 확인하세요.`,
          );
        }
        toast(ids.length > 1 ? `${ids.length}건 저장했습니다.` : '저장했습니다.');
        setSel(new Set());
      } catch (err) {
        setRows(before);
        toast('저장 실패: ' + ((err as Error).message || String(err)), 'err');
      }
    },
    [rows, toast],
  );

  const applyDormant = useCallback(
    async (keys: string[], patch: Partial<Pick<CrmDormant, '조치여부' | '조치메모'>>) => {
      if (!keys.length || !dormant) return;
      const before = dormant;
      const email = (await sb.auth.getUser()).data.user?.email ?? null;
      const stamp = { 조치시각: new Date().toISOString(), 조치작성자: email };
      const kset = new Set(keys);
      setDormant(dormant.map((d) => (kset.has(d.person_key) ? { ...d, ...patch, ...stamp } : d)));
      try {
        const { data, error } = await sb
          .from(CRM_DORMANT_TABLE)
          .update({ ...patch, ...stamp, updated_at: new Date().toISOString() })
          .in('person_key', keys)
          .select('person_key');
        if (error) throw error;
        if ((data?.length ?? 0) !== keys.length) throw new Error('일부만 저장됐습니다(RLS 확인).');
        toast('저장했습니다.');
      } catch (err) {
        setDormant(before);
        toast('저장 실패: ' + ((err as Error).message || String(err)), 'err');
      }
    },
    [dormant, toast],
  );

  const 휴면일 = Number((ruleById.get('dormant-14')?.파라미터 as { 휴면일?: number })?.휴면일 ?? 14);
  const 관측부족 = historyDays !== null && historyDays < 휴면일;

  const toggle = (id: number) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const th =
    'border-b border-border bg-[#f7f8fa] px-3 py-[11px] text-left font-semibold';
  const td = 'border-b border-[#eef0f4] px-3 py-[10px] align-top';

  return (
    <>
      <div className="mb-[22px]">
        <h2 className="m-0 mb-1 text-[22px]">CRM 실행</h2>
        <p className="m-0 text-[13px] text-muted">
          매일 21:00 자동으로 만들어 지점 슬랙에 보낸 멘트 명단입니다. 수업 후 실제로 멘트했는지
          여기서 체크하세요 — 슬랙 버튼 응답은 받을 수 없어(서버 없는 구조) 피드백은 이 화면에만
          쌓입니다.
        </p>
      </div>

      {/* 프리셋 */}
      <div className="mb-3 flex overflow-hidden rounded-[10px] border border-border">
        {(
          [
            ['slack', `슬랙 발송분${chips ? ` (${chips.대상})` : ''}`],
            ['dormant', `관리 필요 · ${휴면일}일 미방문${dormantView ? ` (${dormantView.length})` : ''}`],
          ] as [Preset, string][]
        ).map(([v, label]) => (
          <button
            key={v}
            onClick={() => {
              setPreset(v);
              setSel(new Set());
            }}
            className={[
              'cursor-pointer border-none px-4 py-[9px] text-[13px] font-semibold',
              preset === v ? 'bg-primary text-white' : 'bg-transparent text-muted hover:bg-[#f1f3f7]',
            ].join(' ')}
          >
            {label}
          </button>
        ))}
      </div>

      {/* 필터바 */}
      <div className="mb-[18px] flex flex-wrap items-center gap-[14px] rounded-xl border border-border bg-[#f7f8fa] px-[14px] py-3">
        {preset === 'slack' && (
          <DayRangePicker date={date} span={span} onDate={setDate} onSpan={setSpan} />
        )}
        <select
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          className="rounded-[10px] border border-border px-3 py-[7px] text-[13px] outline-none focus:border-primary"
        >
          <option value="">전체 지점</option>
          {BRANCHES.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        {preset === 'slack' && (
          <select
            value={ruleId}
            onChange={(e) => setRuleId(e.target.value)}
            className="rounded-[10px] border border-border px-3 py-[7px] text-[13px] outline-none focus:border-primary"
          >
            <option value="">전체 규칙</option>
            {slackRules.map((r) => (
              <option key={r.id} value={r.id}>
                {r.이모지} {r.라벨}
              </option>
            ))}
          </select>
        )}
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as Status)}
          className="rounded-[10px] border border-border px-3 py-[7px] text-[13px] outline-none focus:border-primary"
        >
          <option value="전체">전체 상태</option>
          <option value="미입력">미입력만</option>
          <option value="함">{preset === 'slack' ? '멘트함' : '연락함'}</option>
          <option value="못함">못함</option>
        </select>
        <button className={btn.ghostSm} onClick={load} disabled={refreshing}>
          {refreshing ? '새로고침 중…' : '↻ 새로고침'}
        </button>
      </div>

      {error ? (
        <div className="whitespace-pre-line p-10 text-center text-sm text-muted">
          CRM 데이터를 불러오지 못했습니다: {error}
        </div>
      ) : !rows || !rules || !dormant ? (
        <div className="p-10 text-center text-sm text-muted">
          <span className={spinner} /> 불러오는 중…
        </div>
      ) : preset === 'slack' ? (
        <>
          {/* 요약 칩 */}
          {chips && (
            <div className="mb-[14px] flex flex-wrap gap-2 text-[12px]">
              <Chip label="대상" value={chips.대상} />
              <Chip label="발송 성공" value={chips.성공} />
              {chips.실패 > 0 && <Chip label="발송 실패" value={chips.실패} danger />}
              <Chip label="피드백" value={`${chips.입력} (${chips.입력률}%)`} />
              <Chip label="멘트함" value={chips.함} />
              <Chip label="못함" value={chips.못함} />
            </div>
          )}

          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={`${th} w-[36px]`}>
                    <input
                      type="checkbox"
                      checked={!!filtered?.length && sel.size === filtered.length}
                      onChange={(e) =>
                        setSel(e.target.checked ? new Set((filtered ?? []).map((r) => r.id)) : new Set())
                      }
                    />
                  </th>
                  {['회원', '지점', '규칙', '멘트', '근거', '발송', '피드백'].map((h) => (
                    <th key={h} className={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!filtered?.length ? (
                  <tr>
                    <td colSpan={8} className="px-3 py-10 text-center text-muted">
                      {rows.length === 0 ? (
                        <>
                          아직 생성된 CRM 멘트가 없습니다.
                          <br />
                          <button
                            className={`${btn.ghostSm} mt-3`}
                            onClick={() => {
                              location.hash = 'automation';
                            }}
                          >
                            자동화 로그 보기
                          </button>
                        </>
                      ) : (
                        '조건에 맞는 건이 없습니다.'
                      )}
                    </td>
                  </tr>
                ) : (
                  filtered.map((r) => {
                    const rule = ruleById.get(r.rule_id);
                    return (
                      <tr
                        key={r.id}
                        className={[
                          'hover:bg-[#fafbfc]',
                          r.실행여부 === null ? 'border-l-2 border-l-primary' : '',
                        ].join(' ')}
                      >
                        <td className={td}>
                          <input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} />
                        </td>
                        <td className={td}>
                          <div className="font-semibold">{r.이름}</div>
                          <div className="text-[12px] text-muted">
                            {[r.수업시간, r.수업명].filter(Boolean).join(' ')}
                          </div>
                        </td>
                        <td className={`${td} text-muted`}>
                          {r.지점}
                          {span > 1 && (
                            <div className="text-[11px]">{shortDate(r.대상일자)}</div>
                          )}
                        </td>
                        <td className={td}>
                          <span className="whitespace-nowrap rounded-[6px] bg-primary-soft px-[6px] py-[2px] text-[11px] text-primary">
                            {rule?.이모지} {rule?.라벨 ?? r.rule_id}
                          </span>
                        </td>
                        <td className={`${td} max-w-[320px]`}>
                          <div className="truncate" title={r.멘트}>
                            {r.멘트}
                          </div>
                          {r.예시멘트 && (
                            <div className="mt-[2px] truncate text-[12px] text-muted" title={r.예시멘트}>
                              ↳ {r.예시멘트}
                            </div>
                          )}
                        </td>
                        <td className={td}>
                          <div className="flex flex-wrap gap-1">
                            {evidenceChips(r).map((c) => (
                              <span
                                key={c}
                                className="whitespace-nowrap rounded-[6px] bg-[#eef1f6] px-[6px] py-[2px] text-[11px] text-muted"
                              >
                                {c}
                              </span>
                            ))}
                          </div>
                        </td>
                        <td className={td}>
                          {r.발송오류 ? (
                            <span className="text-danger" title={r.발송오류}>
                              ⚠ 실패
                            </span>
                          ) : r.발송여부 ? (
                            <span className="text-success">✅ {hhmm(r.발송시각)}</span>
                          ) : (
                            <span className="text-muted">—</span>
                          )}
                        </td>
                        <td className={td}>
                          <FeedbackCell
                            row={r}
                            onApply={(patch) => applyFeedback([r.id], patch)}
                            onMemo={() => {
                              setMemoOf(r);
                              setMemoText(r.메모 ?? '');
                            }}
                          />
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-muted">
            ※ “못함”도 성실하게 눌러 주세요. CRM 성과 화면은 <strong>멘트함 vs 못함</strong>의 결제 전환율
            차이(리프트)로 효과를 재기 때문에, “못함”이 유일한 대조군입니다.
          </p>
        </>
      ) : (
        /* ───────────────── 관리 필요 · 14일 미방문 ───────────────── */
        <>
          {관측부족 && (
            <div className="mb-[14px] rounded-xl bg-primary-soft px-4 py-3 text-[13px]">
              예약 스냅샷은 <strong>{historyStart ?? '아직'}</strong>부터 수집 중입니다(관측{' '}
              <strong>{historyDays}일차</strong>). “마지막 출석 후 {휴면일}일”은{' '}
              <strong>{historyStart ? addDays(historyStart, 휴면일) : '—'}</strong>부터 정확해집니다. 그
              전까지 이 명단은 <strong>참고용</strong>이며, 아직 한 번도 관측되지 않은 회원은
              “미방문”이 아니라 <strong>“모름”</strong>입니다.
            </div>
          )}

          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full whitespace-nowrap border-collapse text-[13px]">
              <thead>
                <tr>
                  {['회원', '마지막 출석', '미방문', '잔여합', '보유 수강권', '조치'].map((h) => (
                    <th key={h} className={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!dormantView?.length ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-10 text-center text-muted">
                      {관측부족
                        ? `관측 이력이 ${휴면일}일에 못 미쳐 아직 명단을 내지 않습니다.`
                        : '해당 조건의 미방문 회원이 없습니다.'}
                    </td>
                  </tr>
                ) : (
                  dormantView.map((d) => (
                    <tr key={d.person_key} className="hover:bg-[#fafbfc]">
                      <td className={td}>
                        <div className="font-semibold">{d.이름}</div>
                        <div className="text-[12px] text-muted">
                          {d.마지막지점 || '—'} · {d.연락처 || '연락처 없음'}
                        </div>
                      </td>
                      <td className={`${td} ${d.마지막출석일 ? '' : 'text-muted'}`}>
                        {d.마지막출석일 ?? '— (관측 시작 전)'}
                      </td>
                      <td className={`${td} font-semibold`}>
                        {d.마지막출석일 ? `${d.경과일}일` : `≥${d.경과일}일`}
                      </td>
                      <td className={td}>{fmtNum(d.잔여합)}회</td>
                      <td className={`${td} max-w-[280px] whitespace-normal text-[12px] text-muted`}>
                        {(d.보유수강권 || [])
                          .map((t) => `${t.수강권명} ${t.잔여횟수}회 (~${t.수강권종료일 || '?'})`)
                          .join(' · ') || '—'}
                      </td>
                      <td className={td}>
                        <div className="flex gap-[6px]">
                          <SegBtn on={d.조치여부 === true} onClick={() => applyDormant([d.person_key], { 조치여부: true })}>
                            연락함
                          </SegBtn>
                          <SegBtn on={d.조치여부 === false} onClick={() => applyDormant([d.person_key], { 조치여부: false })}>
                            안함
                          </SegBtn>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-muted">
            ※ 출석 = 예약상태가 ‘출석’인 건. 강사가 출석 체크를 누락하면 ‘예약’으로 남으므로, 지난 날짜의
            ‘예약’도 출석으로 봅니다. ‘취소’·‘노쇼’·‘결석’은 출석이 아닙니다.
            <br />※ 대상 = 마지막 출석 후 {휴면일}일 이상 + 잔여횟수 &gt; 0 + 수강권 기간이 남은 회원.
            슬랙으로는 보내지 않습니다.
          </p>
        </>
      )}

      {/* 선택 액션바 */}
      {preset === 'slack' && sel.size > 0 && (
        <div className="sticky bottom-4 mt-4 flex flex-wrap items-center gap-2 rounded-[14px] border border-border bg-card p-3 shadow-lg">
          <span className="text-[13px] font-semibold">{sel.size}건 선택</span>
          <button className={btn.ghostSm} onClick={() => applyFeedback([...sel], { 실행여부: true })}>
            멘트함
          </button>
          <button
            className={btn.ghostSm}
            onClick={() => applyFeedback([...sel], { 실행여부: false, 반응: null })}
          >
            못함
          </button>
          <button
            className={btn.ghostSm}
            onClick={() => applyFeedback([...sel], { 실행여부: true, 반응: '좋음' })}
          >
            반응 좋음
          </button>
          <button className={btn.ghostSm} onClick={() => setSel(new Set())}>
            선택 해제
          </button>
        </div>
      )}

      {/* 메모 */}
      <Modal open={!!memoOf} onClose={() => setMemoOf(null)}>
        <h3 className="m-0 mb-1 text-[17px]">{memoOf?.이름} · 메모</h3>
        <p className="m-0 mb-4 text-[12px] text-muted">{memoOf?.멘트}</p>
        <textarea
          className={`${input} min-h-[120px]`}
          value={memoText}
          onChange={(e) => setMemoText(e.target.value)}
          placeholder="반응이 어땠는지, 다음에 뭘 챙기면 좋을지 적어 두세요."
        />
        <div className="mt-4 flex justify-end gap-2">
          <button className={btn.ghost} onClick={() => setMemoOf(null)}>
            취소
          </button>
          <button
            className={btn.primary}
            onClick={() => {
              if (memoOf) applyFeedback([memoOf.id], { 메모: memoText });
              setMemoOf(null);
            }}
          >
            저장
          </button>
        </div>
      </Modal>
    </>
  );
}

/* ---------------------------------------------------------------------- */

function Chip({ label, value, danger }: { label: string; value: number | string; danger?: boolean }) {
  return (
    <span
      className={[
        'rounded-[8px] border px-[10px] py-[5px]',
        danger ? 'border-danger bg-danger-soft text-danger' : 'border-border bg-card text-muted',
      ].join(' ')}
    >
      {label} <strong className={danger ? 'text-danger' : 'text-text'}>{value}</strong>
    </span>
  );
}

function SegBtn({
  on,
  onClick,
  children,
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={[
        'cursor-pointer whitespace-nowrap rounded-[8px] border px-[10px] py-[5px] text-[12px] font-semibold',
        on
          ? 'border-primary bg-primary text-white'
          : 'border-border bg-transparent text-muted hover:bg-[#f1f3f7]',
      ].join(' ')}
    >
      {children}
    </button>
  );
}

function FeedbackCell({
  row,
  onApply,
  onMemo,
}: {
  row: CrmMessage;
  onApply: (patch: Partial<Pick<CrmMessage, '실행여부' | '반응'>>) => void;
  onMemo: () => void;
}) {
  return (
    <div className="flex flex-col items-start gap-[6px]">
      <div className="flex gap-[6px]">
        <SegBtn on={row.실행여부 === true} onClick={() => onApply({ 실행여부: true })}>
          멘트함
        </SegBtn>
        <SegBtn on={row.실행여부 === false} onClick={() => onApply({ 실행여부: false, 반응: null })}>
          못함
        </SegBtn>
      </div>
      {row.실행여부 === true && (
        <div className="flex flex-wrap gap-1">
          {REACTIONS.map((v) => (
            <button
              key={v}
              onClick={() => onApply({ 반응: (row.반응 === v ? null : v) as Reaction | null })}
              className={[
                'cursor-pointer rounded-[6px] border-none px-[7px] py-[3px] text-[11px]',
                row.반응 === v
                  ? 'bg-success-soft text-success'
                  : 'bg-[#eef1f6] text-muted hover:bg-[#e4e8f0]',
              ].join(' ')}
            >
              {v}
            </button>
          ))}
        </div>
      )}
      <button className="cursor-pointer border-none bg-transparent p-0 text-[11px] text-muted underline" onClick={onMemo}>
        {row.메모 ? '메모 수정' : '메모'}
      </button>
    </div>
  );
}
