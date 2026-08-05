'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { sb } from '@/lib/supabase';
import {
  BRANCHES,
  fetchAllRows,
  fmtNum,
  makePersonResolver,
  ymdNum,
  type MemberRecord,
} from '@/lib/members';
import { renderTemplate } from '@/shared/crm-core.mjs';
import { SALES_TABLE } from '@/lib/sales';
import {
  CRM_MSG_TABLE,
  CRM_RULE_TABLE,
  addDays,
  crmErrorHint,
  periodRange,
  type CrmRule,
} from '@/lib/crm';
import { currentYear, periodLabel, type Period } from '@/lib/period';
import PeriodPicker from '@/components/ui/PeriodPicker';
import { Modal } from '@/components/ui/Modal';
import { useToast } from '@/components/ui/Toast';
import { btn, input, spinner } from '@/components/ui/styles';

/* ======================================================================
   CRM 성과 — "멘트가 실제로 실행됐나(프로세스)"와 "실행 후 결제로 이어졌나(결과)"
   ---------------------------------------------------------------------
   ⭐ 이 화면의 존재 이유는 **리프트**다.
      "만료 직전" 규칙은 어차피 재등록할 시점의 회원을 고르므로 전환율 절대값은
      아무것도 증명하지 않는다. 그런데 강사가 "못함"을 기록해 주면 공짜 대조군이 생기고,
      전환율(멘트함) − 전환율(못함) 이 CRM 의 실제 기여분이 된다.
   ⚠️ 표본이 적으면 퍼센트를 감춘다. 틀린 숫자를 보여주는 것보다 안 보여주는 게 낫다.
   ====================================================================== */

type Msg = {
  id: number;
  대상일자: string;
  지점: string;
  이름: string;
  연락처: string;
  rule_id: string;
  발송여부: boolean;
  발송오류: string | null;
  실행여부: boolean | null;
  반응: string | null;
};

type Agg = {
  발송: number;
  입력: number;
  함: number;
  못함: number;
  좋음: number;
  전환_함: number;
  전환_못함: number;
  결제액: number;
};

const blank = (): Agg => ({ 발송: 0, 입력: 0, 함: 0, 못함: 0, 좋음: 0, 전환_함: 0, 전환_못함: 0, 결제액: 0 });
const MIN_N = 20; // 이보다 분모가 작으면 퍼센트를 감춘다
const WINDOWS = [14, 30, 60];

function rate(n: number, d: number): string {
  return d ? `${Math.round((n / d) * 100)}%` : '—';
}

export default function CrmReport() {
  const toast = useToast();

  const [msgs, setMsgs] = useState<Msg[] | null>(null);
  const [sales, setSales] = useState<MemberRecord[] | null>(null);
  const [rules, setRules] = useState<CrmRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const [period, setPeriod] = useState<Period>({ mode: 'year', year: currentYear(), unit: 1 });
  const [branch, setBranch] = useState('');
  const [win, setWin] = useState(30);
  const [editing, setEditing] = useState<CrmRule | null>(null);

  const [from, to] = useMemo(() => periodRange(period), [period]);

  /* sales 는 진입 시 1회만 긁는다(17,602행). 기간 피커를 움직여도 다시 안 긁는다 —
     전환 창이 대상일자 이후로 뻗으므로 기간만큼 잘라 받으면 최근 결제가 잘린다. */
  useEffect(() => {
    let alive = true;
    (async () => {
      const s = await fetchAllRows(
        'dedup_key,이름,연락처,결제금액,결제일시',
        50000,
        SALES_TABLE,
      ).catch(() => [] as MemberRecord[]);
      if (alive) setSales(s);
    })();
    return () => {
      alive = false;
    };
  }, []);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [m, r] = await Promise.all([
        sb
          .from(CRM_MSG_TABLE)
          .select('id,대상일자,지점,이름,연락처,rule_id,발송여부,발송오류,실행여부,반응')
          .gte('대상일자', from)
          .lte('대상일자', to)
          .order('id', { ascending: true })
          .limit(20000),
        sb.from(CRM_RULE_TABLE).select('*').order('정렬순서', { ascending: true }),
      ]);
      if (m.error) throw m.error;
      if (r.error) throw r.error;
      setMsgs((m.data as unknown as Msg[]) || []);
      setRules((r.data as CrmRule[]) || []);
      setError(null);
    } catch (err) {
      setError(crmErrorHint((err as Error).message || String(err)));
    } finally {
      setRefreshing(false);
    }
  }, [from, to]);

  useEffect(() => {
    load();
  }, [load]);

  const years = useMemo(() => {
    const y = currentYear();
    return [y, y - 1, y - 2];
  }, []);

  /* ── 사람별 결제일 목록 (전환 판정용) ─────────────────────────────────
     ⚠️ crm_messages 에는 dedup_key 가 없다. 그래서 연락처가 비면
        makePersonResolver 의 폴백이 행 단위 일련번호로 떨어져 sales 와 절대 안 붙는다.
        (자동화가 연락처를 반드시 채우는 이유) 여기서는 그런 건을 따로 세어 표기한다. */
  const { payDays, payAmt, keyOf } = useMemo(() => {
    const rows = msgs ?? [];
    const s = sales ?? [];
    const k = makePersonResolver(rows as unknown as MemberRecord[], s);
    const days = new Map<string, number[]>();
    const amt = new Map<string, { d: number; amt: number }[]>();
    for (const row of s) {
      const d = ymdNum(row['결제일시']);
      if (d === null) continue;
      const key = k(row);
      if (!days.has(key)) days.set(key, []);
      if (!amt.has(key)) amt.set(key, []);
      days.get(key)!.push(d);
      amt.get(key)!.push({ d, amt: Number(String(row['결제금액'] ?? '').replace(/[^0-9-]/g, '')) || 0 });
    }
    for (const a of days.values()) a.sort((x, y) => x - y);
    return { payDays: days, payAmt: amt, keyOf: k };
  }, [msgs, sales]);

  const filtered = useMemo(
    () => (msgs ?? []).filter((m) => (!branch || m.지점 === branch) && m.발송여부 && !m.발송오류),
    [msgs, branch],
  );

  const 연락처없음 = useMemo(() => filtered.filter((m) => !String(m.연락처 ?? '').trim()).length, [filtered]);

  const agg = useMemo(() => {
    const byRule = new Map<string, Agg>();
    const byBranch = new Map<string, Agg>();
    const all = blank();

    const converted = (m: Msg) => {
      const d0 = ymdNum(m.대상일자);
      if (d0 === null) return false;
      const end = ymdNum(addDays(m.대상일자, win));
      const arr = payDays.get(keyOf(m as unknown as MemberRecord)) ?? [];
      return arr.some((d) => d >= d0 && (end === null || d <= end));
    };
    const amountIn = (m: Msg) => {
      const d0 = ymdNum(m.대상일자);
      const end = ymdNum(addDays(m.대상일자, win));
      if (d0 === null || end === null) return 0;
      return (payAmt.get(keyOf(m as unknown as MemberRecord)) ?? [])
        .filter((p) => p.d >= d0 && p.d <= end)
        .reduce((s, p) => s + p.amt, 0);
    };

    for (const m of filtered) {
      for (const bucket of [
        byRule.get(m.rule_id) ?? byRule.set(m.rule_id, blank()).get(m.rule_id)!,
        byBranch.get(m.지점) ?? byBranch.set(m.지점, blank()).get(m.지점)!,
        all,
      ]) {
        bucket.발송++;
        if (m.실행여부 !== null) bucket.입력++;
        if (m.실행여부 === true) {
          bucket.함++;
          if (m.반응 === '좋음') bucket.좋음++;
        } else if (m.실행여부 === false) bucket.못함++;
      }
      // 전환은 한 번만 계산해서 세 버킷에 반영
      if (m.실행여부 !== null) {
        const c = converted(m);
        const a = m.실행여부 === true ? amountIn(m) : 0;
        for (const bucket of [byRule.get(m.rule_id)!, byBranch.get(m.지점)!, all]) {
          if (c) {
            if (m.실행여부 === true) bucket.전환_함++;
            else bucket.전환_못함++;
          }
          if (m.실행여부 === true) bucket.결제액 += a;
        }
      }
    }
    return { byRule, byBranch, all };
  }, [filtered, payDays, payAmt, keyOf, win]);

  const lift = (a: Agg): string => {
    if (a.함 < MIN_N || a.못함 < MIN_N) return `표본 부족 (n=${Math.min(a.함, a.못함)})`;
    const v = (a.전환_함 / a.함 - a.전환_못함 / a.못함) * 100;
    return `${v > 0 ? '+' : ''}${v.toFixed(1)}pp`;
  };

  const 입력률 = agg.all.발송 ? Math.round((agg.all.입력 / agg.all.발송) * 100) : 0;
  const 입력부족 = agg.all.발송 > 0 && 입력률 < 60;

  async function saveRule(r: CrmRule) {
    try {
      const { data, error } = await sb
        .from(CRM_RULE_TABLE)
        .update({
          라벨: r.라벨,
          이모지: r.이모지,
          활성: r.활성,
          템플릿: r.템플릿,
          예시멘트: r.예시멘트,
          파라미터: r.파라미터,
          updated_at: new Date().toISOString(),
        })
        .eq('id', r.id)
        .select('id');
      if (error) throw error;
      if (!data?.length) throw new Error('저장된 행이 없습니다(RLS 확인).');
      setRules((rs) => (rs ?? []).map((x) => (x.id === r.id ? r : x)));
      toast('규칙을 저장했습니다. 다음 실행(21:00)부터 반영됩니다.');
      setEditing(null);
    } catch (err) {
      toast('저장 실패: ' + ((err as Error).message || String(err)), 'err');
    }
  }

  const th = 'border-b border-border bg-[#f7f8fa] px-3 py-[11px] text-right font-semibold first:text-left';
  const td = 'border-b border-[#eef0f4] px-3 py-[10px] text-right';
  const cardCls = 'rounded-[14px] border border-border bg-card p-[18px]';

  return (
    <>
      <div className="mb-[22px]">
        <h2 className="m-0 mb-1 text-[22px]">CRM 성과</h2>
        <p className="m-0 text-[13px] text-muted">
          멘트가 실제로 실행됐는지(프로세스)와, 실행된 뒤 결제로 이어졌는지(결과)를 함께 봅니다.
        </p>
      </div>

      <div className="mb-[18px] flex flex-wrap items-end gap-[14px] rounded-xl border border-border bg-[#f7f8fa] px-[14px] py-3">
        <PeriodPicker value={period} onChange={setPeriod} years={years} allowAll />
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
        <label className="flex items-center gap-2 text-[13px] text-muted">
          전환 판정 창
          <select
            value={win}
            onChange={(e) => setWin(Number(e.target.value))}
            className="rounded-[10px] border border-border px-3 py-[7px] text-[13px] outline-none focus:border-primary"
          >
            {WINDOWS.map((w) => (
              <option key={w} value={w}>
                {w}일
              </option>
            ))}
          </select>
        </label>
        <button className={btn.ghostSm} onClick={load} disabled={refreshing}>
          {refreshing ? '새로고침 중…' : '↻ 새로고침'}
        </button>
      </div>

      {error ? (
        <div className="whitespace-pre-line p-10 text-center text-sm text-muted">
          성과 데이터를 불러오지 못했습니다: {error}
        </div>
      ) : !msgs || !rules || !sales ? (
        <div className="p-10 text-center text-sm text-muted">
          <span className={spinner} /> 불러오는 중… (결제 원장을 함께 읽습니다)
        </div>
      ) : (
        <>
          <div className="mb-[18px] grid grid-cols-2 gap-[14px] sm:grid-cols-4">
            <div className={cardCls}>
              <div className="text-[12px] text-muted">발송</div>
              <div className="mt-1 text-[22px] font-bold">{fmtNum(agg.all.발송)}건</div>
            </div>
            <div className={입력부족 ? `${cardCls} border-danger bg-danger-soft` : cardCls}>
              <div className="text-[12px] text-muted">피드백 입력률</div>
              <div className={`mt-1 text-[22px] font-bold ${입력부족 ? 'text-danger' : ''}`}>
                {입력률}%
              </div>
              {입력부족 && <div className="mt-1 text-[11px] text-danger">⚠ 낮음 — 아래 결과 지표를 믿기 어렵습니다</div>}
            </div>
            <div className={cardCls}>
              <div className="text-[12px] text-muted">실행률 (입력 건 중)</div>
              <div className="mt-1 text-[22px] font-bold">{rate(agg.all.함, agg.all.입력)}</div>
            </div>
            <div className={cardCls}>
              <div className="text-[12px] text-muted">{win}일 내 결제 전환 (멘트함)</div>
              <div className="mt-1 text-[22px] font-bold">{rate(agg.all.전환_함, agg.all.함)}</div>
            </div>
          </div>

          {/* 규칙별 성과 */}
          <h3 className="mb-2 mt-6 text-[15px] font-semibold">규칙별 성과</h3>
          <div className="mb-[10px] overflow-x-auto rounded-xl border border-border">
            <table className="w-full whitespace-nowrap border-collapse text-[13px]">
              <thead>
                <tr>
                  {['규칙', '발송', '입력', '멘트함', '못함', '좋은반응', `전환(함)`, `전환(못함)`, '리프트', '결제액', ''].map(
                    (h) => (
                      <th key={h} className={th}>
                        {h}
                      </th>
                    ),
                  )}
                </tr>
              </thead>
              <tbody>
                {rules.length === 0 ? (
                  <tr>
                    <td colSpan={11} className="px-3 py-10 text-center text-muted">
                      규칙이 없습니다. sql/2026-08_crm.sql 을 실행하세요.
                    </td>
                  </tr>
                ) : (
                  rules.map((r) => {
                    const a = agg.byRule.get(r.id) ?? blank();
                    return (
                      <tr key={r.id} className="hover:bg-[#fafbfc]">
                        <td className="border-b border-[#eef0f4] px-3 py-[10px] font-semibold">
                          {r.이모지} {r.라벨}
                          {!r.활성 && <span className="ml-2 text-[11px] text-muted">(꺼짐)</span>}
                          {!r.슬랙발송 && (
                            <span className="ml-2 rounded-[6px] bg-[#eef1f6] px-[6px] py-[2px] text-[11px] text-muted">
                              슬랙 미발송
                            </span>
                          )}
                        </td>
                        <td className={td}>{fmtNum(a.발송)}</td>
                        <td className={td}>
                          {fmtNum(a.입력)}
                          <span className="ml-1 text-[11px] text-muted">({rate(a.입력, a.발송)})</span>
                        </td>
                        <td className={td}>{fmtNum(a.함)}</td>
                        <td className={td}>{fmtNum(a.못함)}</td>
                        <td className={td}>{rate(a.좋음, a.함)}</td>
                        <td className={td}>{rate(a.전환_함, a.함)}</td>
                        <td className={td}>{rate(a.전환_못함, a.못함)}</td>
                        <td
                          className={[
                            td,
                            'font-semibold',
                            a.함 >= MIN_N && a.못함 >= MIN_N ? '' : 'text-muted',
                          ].join(' ')}
                        >
                          {lift(a)}
                        </td>
                        <td className={td}>{fmtNum(a.결제액)}</td>
                        <td className={`${td} text-right`}>
                          <button className={btn.ghostSm} onClick={() => setEditing({ ...r })}>
                            템플릿 편집
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {/* 지점별 실행률 */}
          <h3 className="mb-2 mt-6 text-[15px] font-semibold">지점별 실행률</h3>
          <div className="mb-[10px] overflow-x-auto rounded-xl border border-border">
            <table className="w-full whitespace-nowrap border-collapse text-[13px]">
              <thead>
                <tr>
                  {['지점', '발송', '입력률', '실행률', `전환율(${win}일)`].map((h) => (
                    <th key={h} className={th}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {BRANCHES.filter((b) => agg.byBranch.has(b)).length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-10 text-center text-muted">
                      해당 기간의 발송 기록이 없습니다.
                    </td>
                  </tr>
                ) : (
                  BRANCHES.filter((b) => agg.byBranch.has(b)).map((b) => {
                    const a = agg.byBranch.get(b)!;
                    return (
                      <tr key={b} className="hover:bg-[#fafbfc]">
                        <td className="border-b border-[#eef0f4] px-3 py-[10px] font-semibold">{b}</td>
                        <td className={td}>{fmtNum(a.발송)}</td>
                        <td className={td}>{rate(a.입력, a.발송)}</td>
                        <td className={td}>{rate(a.함, a.입력)}</td>
                        <td className={td}>{rate(a.전환_함, a.함)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-6 rounded-xl border border-border bg-[#f7f8fa] px-4 py-3 text-xs leading-relaxed text-muted">
            ※ 전환 = 대상일자부터 {win}일 이내에 sales 에 결제가 1건 이상 있는 경우입니다(사람 = 이름 +
            연락처).
            <br />※ <strong>전환율은 인과가 아니라 상관입니다.</strong> ‘만료 임박’ 규칙은 원래 재등록
            시점의 회원을 고르므로 전환율이 높게 나옵니다 — 의미 있는 건 같은 규칙 안에서{' '}
            <strong>멘트함 vs 못함의 차이(리프트)</strong>뿐입니다.
            <br />※ 피드백이 입력되지 않은 건은 어느 쪽에도 세지 않습니다. 분모가 {MIN_N}건 미만이면
            퍼센트 대신 ‘표본 부족’으로 표시합니다.
            {연락처없음 > 0 && (
              <>
                <br />※ 연락처가 비어 결제 전환을 계산할 수 없는 건이 {연락처없음}건 있습니다(집계에서
                제외).
              </>
            )}
            <br />※ 기준 기간: <strong>{periodLabel(period)}</strong> ({from} ~ {to})
          </div>
        </>
      )}

      {/* 규칙·템플릿 편집 */}
      <Modal open={!!editing} onClose={() => setEditing(null)}>
        {editing && <RuleEditor rule={editing} onChange={setEditing} onSave={saveRule} onClose={() => setEditing(null)} />}
      </Modal>
    </>
  );
}

/* ---------------------------------------------------------------------- */

const VARS = [
  '이름', '지점', '수업시간', '수업명', '수강권명',
  '누적횟수', '마일스톤', '잔여횟수', '전체횟수', '수강권종료일', '남은일',
  '마지막출석일', '경과일', '잔여합',
];

const SAMPLE: Record<string, string | number> = {
  이름: '홍길동', 지점: '광교', 수업시간: '10:00', 수업명: '바레 그룹',
  수강권명: '바레 그룹 20회 (광교)', 누적횟수: 100, 마일스톤: 100,
  잔여횟수: 6, 전체횟수: 20, 수강권종료일: '2026-08-12', 남은일: 7,
  마지막출석일: '2026-07-22', 경과일: 14, 잔여합: 8,
};

function RuleEditor({
  rule,
  onChange,
  onSave,
  onClose,
}: {
  rule: CrmRule;
  onChange: (r: CrmRule) => void;
  onSave: (r: CrmRule) => void;
  onClose: () => void;
}) {
  const [paramText, setParamText] = useState(() => JSON.stringify(rule.파라미터 ?? {}, null, 2));
  const [paramErr, setParamErr] = useState<string | null>(null);

  return (
    <>
      <h3 className="m-0 mb-1 text-[17px]">
        {rule.이모지} {rule.라벨}
      </h3>
      <p className="m-0 mb-4 text-[12px] text-muted">
        수정한 내용은 <strong>다음 실행(매일 21:00 KST)</strong>부터 반영됩니다. 이미 보낸 메시지는
        바뀌지 않습니다.
      </p>

      <label className="mb-1 block text-[12px] font-semibold">상황 (슬랙 본문 한 줄)</label>
      <textarea
        className={`${input} mb-3 min-h-[64px]`}
        value={rule.템플릿}
        onChange={(e) => onChange({ ...rule, 템플릿: e.target.value })}
      />

      <label className="mb-1 block text-[12px] font-semibold">예시 멘트 (↳ 로 붙는 문장)</label>
      <textarea
        className={`${input} mb-3 min-h-[80px]`}
        value={rule.예시멘트}
        onChange={(e) => onChange({ ...rule, 예시멘트: e.target.value })}
      />

      <div className="mb-3 rounded-[10px] bg-[#f7f8fa] p-3">
        <div className="mb-1 text-[12px] font-semibold">미리보기 (샘플 값)</div>
        <div className="text-[13px]">• 10:00 바레 그룹 / 홍길동 — {renderTemplate(rule.템플릿, SAMPLE)}</div>
        {rule.예시멘트 && (
          <div className="mt-[2px] text-[13px] text-muted">
            &nbsp;&nbsp;↳ “{renderTemplate(rule.예시멘트, SAMPLE)}”
          </div>
        )}
        <div className="mt-2 flex flex-wrap gap-1">
          {VARS.map((v) => (
            <code key={v} className="rounded-[6px] bg-[#eef1f6] px-[6px] py-[2px] text-[11px] text-muted">
              {`{{${v}}}`}
            </code>
          ))}
        </div>
        <p className="m-0 mt-2 text-[11px] text-muted">
          ※ 모르는 변수는 치환되지 않고 <code>{'{{이렇게}}'}</code> 그대로 남습니다 — 위 미리보기에
          중괄호가 보이면 오타입니다.
        </p>
      </div>

      <label className="mb-1 block text-[12px] font-semibold">파라미터 (JSON)</label>
      <textarea
        className={`${input} mb-1 min-h-[90px] font-mono text-[12px]`}
        value={paramText}
        onChange={(e) => {
          setParamText(e.target.value);
          try {
            onChange({ ...rule, 파라미터: JSON.parse(e.target.value) });
            setParamErr(null);
          } catch (err) {
            setParamErr((err as Error).message);
          }
        }}
      />
      {paramErr && <p className="m-0 mb-2 text-[12px] text-danger">JSON 형식 오류: {paramErr}</p>}

      <label className="mb-3 flex items-center gap-2 text-[13px]">
        <input
          type="checkbox"
          checked={rule.활성}
          onChange={(e) => onChange({ ...rule, 활성: e.target.checked })}
        />
        이 규칙 사용
      </label>

      <div className="flex justify-end gap-2">
        <button className={btn.ghost} onClick={onClose}>
          취소
        </button>
        <button className={btn.primary} disabled={!!paramErr} onClick={() => onSave(rule)}>
          저장
        </button>
      </div>
    </>
  );
}
