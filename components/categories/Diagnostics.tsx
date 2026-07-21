'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  fetchAllRows,
  fmtNum,
  toInt,
  phoneDigits,
  personKey,
  ymdNum,
  isUsableTicket,
  matchesBranch,
  BRANCHES,
  type MemberRecord,
} from '@/lib/members';
import { card, spinner, btn } from '@/components/ui/styles';

/* ======================================================================
   데이터 진단 — 예약사이트 집계와 앱 집계가 어긋나는 원인을 실제 데이터로 짚는다.
   세 축을 계산한다:
     1) 연락처 채움 → 사람 묶기(이름+연락처)가 무너지면 총 회원이 부풀거나 흔들린다.
     2) 지점 태그(수강권명 안의 "(옥수)") → 없으면 지점 필터가 무력.
     3) 잔여횟수 / 종료일 → "현재 회원" 판정 차이(특히 기간제 잔여 0)의 크기.
   전부 브라우저에서 계산(서버 없음). 읽기만 하므로 데이터는 바뀌지 않는다.
   ====================================================================== */

const today = new Date();
const todayNum = today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate();

type Diag = {
  총행수: number;

  // 연락처
  연락처있음: number;
  연락처없음: number;

  // 사람 집계
  사람_이름연락처: number; // 앱이 실제로 쓰는 기준 personKey
  사람_이름만: number; // 이름만으로 묶었을 때
  쪼개진사람: number; // 같은 이름이 "이름+연락처"와 "이름+''" 둘 다로 갈린 케이스

  // 지점 태그
  지점별행수: { branch: string; n: number }[];
  지점태그없음: number;

  // 잔여 / 종료일 (행 단위)
  잔여양수행: number;
  잔여0행: number;
  종료일없음: number;
  종료일파싱실패: number;
  종료일지남: number;
  기간제의심행: number; // 잔여<=0 인데 종료일이 아직 남음 → 기간제(무제한) 추정

  // 현재 회원 판정 3종 비교 (사람 단위)
  현재_앱기준: number; // 종료일 유효 & 잔여>0  (= isUsableTicket)
  현재_잔여만: number; // 잔여>0 (종료일 무시)
  현재_기간만: number; // 종료일 유효 (잔여 무시)
  기간제의심사람: number; // 잔여<=0 이지만 기간이 남은 수강권을 가진 사람
};

function compute(rows: MemberRecord[]): Diag {
  let 연락처있음 = 0;
  let 잔여양수행 = 0;
  let 잔여0행 = 0;
  let 종료일없음 = 0;
  let 종료일파싱실패 = 0;
  let 종료일지남 = 0;
  let 기간제의심행 = 0;

  const 지점count = new Map<string, number>(BRANCHES.map((b) => [b, 0]));
  let 지점태그없음 = 0;

  // 사람 단위 플래그 집계
  const persons = new Map<
    string,
    { appActive: boolean; remActive: boolean; periodActive: boolean; periodSuspect: boolean }
  >();
  const nameOnly = new Set<string>();
  const nameHasPhoneKey = new Map<string, { withPhone: boolean; blank: boolean }>();

  for (const r of rows) {
    const 이름 = String(r['이름'] ?? '').trim();
    const digits = phoneDigits(r['연락처']);
    if (digits) 연락처있음++;

    // 사람 키
    const pk = personKey(r);
    let p = persons.get(pk);
    if (!p) {
      p = { appActive: false, remActive: false, periodActive: false, periodSuspect: false };
      persons.set(pk, p);
    }
    nameOnly.add(이름);
    const nh = nameHasPhoneKey.get(이름) ?? { withPhone: false, blank: false };
    if (digits) nh.withPhone = true;
    else nh.blank = true;
    nameHasPhoneKey.set(이름, nh);

    // 지점 태그 (수강권명 부분일치)
    const 수강권명 = String(r['수강권명'] ?? '');
    let 태그있음 = false;
    for (const b of BRANCHES) {
      if (수강권명.includes(b)) {
        지점count.set(b, (지점count.get(b) ?? 0) + 1);
        태그있음 = true;
      }
    }
    if (!태그있음) 지점태그없음++;

    // 잔여 / 종료일
    const rem = toInt(r['잔여횟수']);
    if (rem > 0) 잔여양수행++;
    else 잔여0행++;

    const endRaw = String(r['수강권종료일'] ?? '').trim();
    const endNum = ymdNum(r['수강권종료일']);
    const 종료일future = endNum === null ? true : endNum >= todayNum; // 파싱 못하면 만료로 보지 않음(앱 규칙과 동일)
    if (endRaw === '') 종료일없음++;
    else if (endNum === null) 종료일파싱실패++;
    else if (endNum < todayNum) 종료일지남++;

    if (rem <= 0 && endNum !== null && endNum >= todayNum) 기간제의심행++;

    // 사람 단위 플래그 갱신
    if (isUsableTicket(r, today)) p.appActive = true;
    if (rem > 0) p.remActive = true;
    if (종료일future) p.periodActive = true;
    if (rem <= 0 && endNum !== null && endNum >= todayNum) p.periodSuspect = true;
  }

  let 쪼개진사람 = 0;
  for (const nh of nameHasPhoneKey.values()) if (nh.withPhone && nh.blank) 쪼개진사람++;

  let 현재_앱기준 = 0;
  let 현재_잔여만 = 0;
  let 현재_기간만 = 0;
  let 기간제의심사람 = 0;
  for (const p of persons.values()) {
    if (p.appActive) 현재_앱기준++;
    if (p.remActive) 현재_잔여만++;
    if (p.periodActive) 현재_기간만++;
    if (p.periodSuspect) 기간제의심사람++;
  }

  return {
    총행수: rows.length,
    연락처있음,
    연락처없음: rows.length - 연락처있음,
    사람_이름연락처: persons.size,
    사람_이름만: nameOnly.size,
    쪼개진사람,
    지점별행수: BRANCHES.map((b) => ({ branch: b, n: 지점count.get(b) ?? 0 })),
    지점태그없음,
    잔여양수행,
    잔여0행,
    종료일없음,
    종료일파싱실패,
    종료일지남,
    기간제의심행,
    현재_앱기준,
    현재_잔여만,
    현재_기간만,
    기간제의심사람,
  };
}

export default function Diagnostics() {
  const [rows, setRows] = useState<MemberRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [branch, setBranch] = useState(''); // '' = 전체 지점

  useEffect(() => {
    let alive = true;
    setRows(null);
    setError(null);
    (async () => {
      try {
        const data = await fetchAllRows('이름,연락처,수강권명,잔여횟수,전체횟수,수강권종료일');
        if (alive) setRows(data);
      } catch (err) {
        if (alive) setError((err as Error).message || String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [nonce]);

  // ② 지점 분포는 항상 "전체 DB" 기준(어느 지점이 얼마나 들어있나). ①③은 선택 지점으로 좁혀
  // 예약사이트의 지점별 숫자(옥수 전체회원 1,234 / 이용회원 186)와 바로 맞대보게 한다.
  const dAll = useMemo(() => (rows ? compute(rows) : null), [rows]);
  const scoped = useMemo(
    () => (rows ? rows.filter((r) => matchesBranch(r, branch)) : null),
    [rows, branch],
  );
  const d = useMemo(() => (scoped ? compute(scoped) : null), [scoped]);

  return (
    <>
      <div className="mb-[22px] flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="m-0 mb-1 text-[22px]">데이터 진단</h2>
          <p className="m-0 text-[13px] text-muted">
            예약사이트 집계와 앱 집계가 어긋나는 원인을 실제 데이터로 짚습니다. (읽기 전용 · 데이터는 바뀌지 않음)
          </p>
        </div>
        <div className="flex items-end gap-2">
          <label className="flex flex-col gap-1 text-[12px] text-muted">
            지점 (①·③에 적용)
            <select
              className="rounded-[10px] border border-border bg-white px-3 py-[9px] text-sm text-text"
              value={branch}
              disabled={!rows}
              onChange={(e) => setBranch(e.target.value)}
            >
              <option value="">전체 지점</option>
              {BRANCHES.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </label>
          <button className={btn.ghostSm} onClick={() => setNonce((n) => n + 1)} disabled={!rows && !error}>
            다시 계산
          </button>
        </div>
      </div>

      {error ? (
        <div className="p-10 text-center text-sm text-muted">불러오지 못했습니다: {error}</div>
      ) : !d || !dAll ? (
        <div className="p-10 text-center text-sm text-muted">
          <span className={spinner} /> 전체 회원 데이터를 훑는 중…
        </div>
      ) : (
        <>
          <p className="mb-[18px] text-[13px] text-muted">
            {branch ? (
              <>
                <strong className="text-text">{branch}</strong> 지점 수강권 등록건{' '}
                <strong className="text-text">{fmtNum(d.총행수)}행</strong> 기준 (전체{' '}
                {fmtNum(dAll.총행수)}행 중). ①·③은 이 지점만, ②는 전체 지점 분포입니다.
              </>
            ) : (
              <>
                전체 지점 수강권 등록건 <strong className="text-text">{fmtNum(d.총행수)}행</strong> 기준입니다.
                예약사이트는 지점별 숫자이니, 옥수와 비교하려면 위 <strong className="text-text">지점 필터를
                옥수로</strong> 두세요. (한 사람이 여러 수강권을 가지면 여러 행)
              </>
            )}
          </p>

          {/* 1) 연락처 & 사람 묶기 → 총 회원 부풀림 진단 */}
          <Section
            title="① 사람 식별(총 회원)"
            note="앱은 이름+연락처로 사람을 묶습니다. 연락처가 비면 같은 사람이 쪼개져 총 회원이 부풀 수 있습니다."
          >
            <Rows
              rows={[
                ['연락처 있는 행', `${fmtNum(d.연락처있음)} (${pct(d.연락처있음, d.총행수)})`],
                ['연락처 빈 행', `${fmtNum(d.연락처없음)} (${pct(d.연락처없음, d.총행수)})`],
                ['총 회원 — 이름+연락처 기준(앱)', `${fmtNum(d.사람_이름연락처)}명`, true],
                ['참고: 이름만으로 묶으면', `${fmtNum(d.사람_이름만)}명`],
                ['같은 이름이 연락처 유무로 쪼개진 사람', `${fmtNum(d.쪼개진사람)}명`],
              ]}
            />
            {d.연락처있음 === 0 ? (
              <VerdictBox tone="bad">
                연락처가 <strong>전혀 없습니다(100% 빈 행).</strong> 그래서 앱은 사람을{' '}
                <strong>이름만으로</strong> 묶습니다 — 총 회원 {fmtNum(d.사람_이름연락처)}명은 곧 서로 다른 이름의
                수입니다. 이 방식은 총 회원을 부풀리는 게 아니라, 반대로 <strong>동명이인을 한 명으로 합쳐 축소</strong>
                시킵니다(특히 전체 지점을 합치면 지점이 다른 동명이인까지 병합). 예약사이트와 정확히 맞추려면 업로드에
                연락처 컬럼을 반드시 포함하고, 위 지점 필터로 지점을 맞춰 비교하세요.
              </VerdictBox>
            ) : (
              <Verdict
                ok={d.연락처없음 === 0 && d.쪼개진사람 === 0}
                bad={`연락처 빈 행이 ${pct(d.연락처없음, d.총행수)}이고, 같은 이름이 연락처 유무로 쪼개진 사람이 ${fmtNum(
                  d.쪼개진사람,
                )}명입니다. 연락처가 있는 행과 없는 행이 섞여 같은 사람이 갈라졌습니다 — 업로드 시 연락처 컬럼 매핑을 확인하세요.`}
                good="연락처가 잘 채워져 있어 사람 묶기로 인한 총 회원 왜곡은 작습니다."
              />
            )}
          </Section>

          {/* 2) 지점 태그 → 지점 필터 무력 진단 */}
          <Section
            title="② 지점 태그(지점 필터) — 전체 지점 기준"
            note='앱은 지점을 수강권명 안의 "(옥수)" 같은 문자열로만 구분합니다. 태그가 없으면 지점 필터가 안 걸립니다. (항상 전체 DB 기준)'
          >
            <Rows
              rows={[
                ...dAll.지점별행수.map(
                  ({ branch, n }) =>
                    [`"${branch}" 포함 행`, `${fmtNum(n)} (${pct(n, dAll.총행수)})`] as [string, string],
                ),
                ['지점 태그 전혀 없는 행', `${fmtNum(dAll.지점태그없음)} (${pct(dAll.지점태그없음, dAll.총행수)})`, true],
              ]}
            />
            <Verdict
              ok={dAll.지점태그없음 === 0}
              bad={`수강권명에 지점 태그가 없는 행이 ${pct(
                dAll.지점태그없음,
                dAll.총행수,
              )}입니다. 이 행들은 지점 필터에 안 잡혀, "옥수"로 걸러도 누락됩니다. 옥수와 비교하려면 전체 지점이 섞여 있지 않은지 먼저 확인하세요.`}
              good="대부분의 행에 지점 태그가 있어 지점 필터가 정상 동작합니다."
            />
          </Section>

          {/* 3) 잔여/종료일 → 현재 회원 과소 진단 */}
          <Section
            title="③ 현재 회원 판정"
            note="앱 기준 현재 회원 = 종료일이 안 지났고 + 잔여횟수 > 0. 기간제(무제한)는 잔여가 0으로 내려와 만료로 빠질 수 있습니다."
          >
            <Rows
              rows={[
                ['잔여 > 0 인 행', `${fmtNum(d.잔여양수행)} (${pct(d.잔여양수행, d.총행수)})`],
                ['잔여 0/공란 인 행', `${fmtNum(d.잔여0행)} (${pct(d.잔여0행, d.총행수)})`],
                ['종료일 없는 행', `${fmtNum(d.종료일없음)}`],
                ['종료일 형식 못 읽은 행', `${fmtNum(d.종료일파싱실패)}`],
                ['종료일 지난 행', `${fmtNum(d.종료일지남)}`],
                ['⚠ 잔여 0 인데 기간은 남은 행(기간제 추정)', `${fmtNum(d.기간제의심행)}`, true],
              ]}
            />
            <div className="mt-[14px] rounded-[12px] border border-border bg-[#f7f8fa] p-4">
              <div className="mb-2 text-[13px] font-semibold">현재 회원 — 기준별 인원 (예약사이트 "이용회원"과 비교)</div>
              <Rows
                rows={[
                  ['앱 기준 (기간 유효 & 잔여>0)', `${fmtNum(d.현재_앱기준)}명`, true],
                  ['잔여만 있으면 (종료일 무시)', `${fmtNum(d.현재_잔여만)}명`],
                  ['기간만 유효하면 (잔여 무시)', `${fmtNum(d.현재_기간만)}명`],
                ]}
              />
            </div>
            <Verdict
              ok={d.기간제의심사람 === 0}
              bad={`잔여가 0인데 기간이 남은 수강권을 가진 사람이 ${fmtNum(
                d.기간제의심사람,
              )}명입니다. 이들은 예약사이트에선 "이용회원"이지만 앱에선 만료로 빠집니다. 위 표에서 예약사이트 이용회원 수와 가장 가까운 기준이 실제 정의입니다 — "기간만 유효하면" 쪽이 가깝다면 기간제가 원인입니다.`}
              good="기간은 남았는데 잔여가 0인(기간제 추정) 회원이 없어, 현재 회원 과소 집계의 주 원인은 아닙니다."
            />
          </Section>
        </>
      )}
    </>
  );
}

function pct(n: number, total: number): string {
  if (!total) return '0%';
  return `${Math.round((n / total) * 100)}%`;
}

function Section({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <div className={card}>
      <h3 className="m-0 mb-1 text-[16px]">{title}</h3>
      <p className="m-0 mb-[14px] text-[12px] text-muted">{note}</p>
      {children}
    </div>
  );
}

function Rows({ rows }: { rows: [string, string, boolean?][] }) {
  return (
    <table className="w-full border-collapse text-[13px]">
      <tbody>
        {rows.map(([label, value, strong], i) => (
          <tr key={i}>
            <td className="border-b border-[#eef0f4] py-[8px] pr-3 text-muted">{label}</td>
            <td
              className={`whitespace-nowrap border-b border-[#eef0f4] py-[8px] text-right ${
                strong ? 'font-bold text-text' : ''
              }`}
            >
              {value}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Verdict({ ok, bad, good }: { ok: boolean; bad: string; good: string }) {
  return <VerdictBox tone={ok ? 'good' : 'bad'}>{ok ? good : bad}</VerdictBox>;
}

function VerdictBox({ tone, children }: { tone: 'good' | 'bad'; children: React.ReactNode }) {
  return (
    <p
      className={`mt-[14px] rounded-[10px] px-4 py-3 text-[13px] leading-[1.6] ${
        tone === 'good' ? 'bg-[#e6f4ea] text-[#137333]' : 'bg-[#fbeaea] text-[#c0362c]'
      }`}
    >
      {children}
    </p>
  );
}
