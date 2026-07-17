'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  fetchAllRows,
  fmtNum,
  usedCount,
  toInt,
  ticketType,
  isTrial,
  isUsableTicket,
  phoneDigits,
  personKey,
  matchesBranch,
  BRANCHES,
  type MemberRecord,
} from '@/lib/members';
import { SALES_TABLE } from '@/lib/sales';
import { Modal } from '@/components/ui/Modal';
import { btn, input, card, spinner } from '@/components/ui/styles';

/* ======================================================================
   회원별 집계 — "이 사람이 지금까지 몇 회 했고 얼마 결제했나"를 1인 단위로.
   members(등록건)·sales(결제건)를 이름+연락처(숫자)로 묶어 CRM의 핵심 데이터를 만든다.
   - 총 사용횟수 = 그 사람 member 행들의 usedCount(전체−잔여) 합
   - 총 결제금액 = 그 사람 sales 행들의 결제금액 합 (sales가 결제 원장)
   ====================================================================== */

type Person = {
  key: string;
  이름: string;
  연락처: string;
  members: MemberRecord[]; // 보유 수강권(등록건)들
  sales: MemberRecord[]; // 결제 내역들
  총사용: number;
  총결제: number;
  체험여부: boolean;
  활성: boolean; // 현재 회원 = 지금 사용 가능한 수강권(잔여>0·미만료)을 하나라도 보유
};

type StatusFilter = '전체' | '현재' | '비활성';

function moneyOf(v: unknown): number {
  return Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
}

type SortKey = '총결제' | '총사용' | '이름';

export default function MemberSummary() {
  const [memberRows, setMemberRows] = useState<MemberRecord[] | null>(null);
  const [salesRows, setSalesRows] = useState<MemberRecord[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState('');
  const [branch, setBranch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('전체');
  const [sort, setSort] = useState<SortKey>('총결제');
  const [detail, setDetail] = useState<Person | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [m, s] = await Promise.all([
          fetchAllRows('이름,연락처,성별,수강권명,수강권종류,전체횟수,잔여횟수,등록일,수강권종료일'),
          fetchAllRows('이름,연락처,수강권명,수강권종류,결제구분,결제금액,결제일시', 50000, SALES_TABLE).catch(
            () => [] as MemberRecord[],
          ),
        ]);
        if (!alive) return;
        setMemberRows(m);
        setSalesRows(s);
      } catch (err) {
        if (alive) setError((err as Error).message || String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 이름+연락처(숫자)로 1인 단위 그룹핑
  const people = useMemo(() => {
    if (!memberRows) return null;
    const map = new Map<string, Person>();
    const get = (rec: MemberRecord): Person => {
      const k = personKey(rec);
      let p = map.get(k);
      if (!p) {
        p = {
          key: k,
          이름: String(rec['이름'] ?? '').trim(),
          연락처: String(rec['연락처'] ?? ''),
          members: [],
          sales: [],
          총사용: 0,
          총결제: 0,
          체험여부: false,
          활성: false,
        };
        map.set(k, p);
      }
      return p;
    };
    for (const r of memberRows) {
      const p = get(r);
      p.members.push(r);
      p.총사용 += usedCount(r);
      if (isTrial(r)) p.체험여부 = true;
      if (isUsableTicket(r)) p.활성 = true;
      if (!p.연락처 && r['연락처']) p.연락처 = String(r['연락처']);
    }
    for (const r of salesRows) {
      // 결제 내역은 회원(이름+연락처)에 붙인다. 매칭 안 되는 결제도 사람으로 남긴다.
      const p = get(r);
      p.sales.push(r);
      p.총결제 += moneyOf(r['결제금액']);
    }
    return [...map.values()];
  }, [memberRows, salesRows]);

  const filtered = useMemo(() => {
    if (!people) return null;
    const term = q.trim();
    const digits = phoneDigits(term);
    let out = people.filter((p) => {
      if (branch && !p.members.some((m) => matchesBranch(m, branch))) return false;
      if (status === '현재' && !p.활성) return false;
      if (status === '비활성' && p.활성) return false;
      if (term) {
        const nameHit = p.이름.includes(term);
        const phoneHit = digits !== '' && phoneDigits(p.연락처).includes(digits);
        if (!nameHit && !phoneHit) return false;
      }
      return true;
    });
    out = out.sort((a, b) => {
      if (sort === '이름') return a.이름.localeCompare(b.이름, 'ko');
      return b[sort] - a[sort];
    });
    return out;
  }, [people, q, branch, status, sort]);

  const totals = useMemo(() => {
    if (!filtered) return null;
    return {
      인원: filtered.length,
      현재: filtered.filter((p) => p.활성).length,
      총사용: filtered.reduce((s, p) => s + p.총사용, 0),
      총결제: filtered.reduce((s, p) => s + p.총결제, 0),
    };
  }, [filtered]);

  return (
    <>
      <div className="mb-[22px]">
        <h2 className="m-0 mb-1 text-[22px]">회원별 집계</h2>
        <p className="m-0 text-[13px] text-muted">
          한 사람 기준 총 사용횟수·총 결제금액입니다. 행을 클릭하면 보유 수강권과 결제 내역을 볼 수 있습니다.
        </p>
      </div>

      {/* 필터 바 */}
      <div className="mb-[14px] flex flex-wrap items-end gap-x-[10px] gap-y-3 rounded-xl border border-border bg-[#f7f8fa] px-[14px] py-3">
        <label className="flex flex-1 flex-col gap-1 text-[12px] text-muted">
          검색
          <input
            className={`${input} min-w-[200px]`}
            placeholder="이름 · 연락처 검색"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          지점
          <select
            className="rounded-[10px] border border-border bg-white px-3 py-[9px] text-sm text-text"
            value={branch}
            disabled={!people}
            onChange={(e) => setBranch(e.target.value)}
          >
            <option value="">전체</option>
            {BRANCHES.map((b) => (
              <option key={b} value={b}>
                {b}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          회원 상태
          <select
            className="rounded-[10px] border border-border bg-white px-3 py-[9px] text-sm text-text"
            value={status}
            disabled={!people}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
          >
            <option value="전체">전체</option>
            <option value="현재">현재 회원(사용 가능)</option>
            <option value="비활성">비활성(만료·소진)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-[12px] text-muted">
          정렬
          <select
            className="rounded-[10px] border border-border bg-white px-3 py-[9px] text-sm text-text"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
          >
            <option value="총결제">총 결제금액 많은순</option>
            <option value="총사용">총 사용횟수 많은순</option>
            <option value="이름">이름순</option>
          </select>
        </label>
        <button
          className={btn.ghostSm}
          onClick={() => {
            setQ('');
            setBranch('');
            setStatus('전체');
            setSort('총결제');
          }}
        >
          필터 초기화
        </button>
      </div>

      {error ? (
        <div className="p-10 text-center text-sm text-muted">불러오지 못했습니다: {error}</div>
      ) : !filtered || !totals ? (
        <div className="p-10 text-center text-sm text-muted">
          <span className={spinner} /> 집계하는 중…
        </div>
      ) : (
        <>
          <div className="mb-[18px] grid grid-cols-[repeat(auto-fit,minmax(180px,1fr))] gap-[14px]">
            <Stat label="전체 회원 수" value={fmtNum(totals.인원)} />
            <Stat label="현재 회원 (사용 가능)" value={fmtNum(totals.현재)} />
            <Stat label="총 사용횟수 합" value={fmtNum(totals.총사용)} />
            <Stat label="총 결제금액 합" value={`${fmtNum(totals.총결제)}원`} small />
          </div>

          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full whitespace-nowrap border-collapse text-[13px]">
              <thead>
                <tr>
                  {['이름', '연락처', '보유 수강권', '총 사용횟수', '총 결제금액'].map((h) => (
                    <th
                      key={h}
                      className="sticky top-0 border-b border-border bg-[#f7f8fa] px-3 py-[11px] text-left font-semibold"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {!filtered.length ? (
                  <tr>
                    <td colSpan={5}>
                      <div className="p-10 text-center text-sm text-muted">결과가 없습니다.</div>
                    </td>
                  </tr>
                ) : (
                  filtered.map((p) => (
                    <tr
                      key={p.key}
                      className="cursor-pointer hover:bg-[#fafbfc]"
                      onClick={() => setDetail(p)}
                    >
                      <td className="border-b border-[#eef0f4] px-3 py-[10px] font-semibold">
                        {p.이름 || '(이름없음)'}
                        <span
                          className={`ml-[6px] rounded-[6px] px-[6px] py-[2px] text-[11px] ${
                            p.활성 ? 'bg-[#e6f4ea] text-[#137333]' : 'bg-[#eef1f6] text-muted'
                          }`}
                        >
                          {p.활성 ? '현재' : '비활성'}
                        </span>
                        {p.체험여부 && (
                          <span className="ml-[6px] rounded-[6px] bg-[#eef1f6] px-[6px] py-[2px] text-[11px] text-muted">
                            체험
                          </span>
                        )}
                      </td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px] text-muted">{p.연락처}</td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px]">{fmtNum(p.members.length)}개</td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px]">{fmtNum(p.총사용)}회</td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px]">{fmtNum(p.총결제)}원</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-[14px] text-xs text-muted">
            ※ 총 결제금액은 매출(sales) 기준, 총 사용횟수는 전체−잔여 합계입니다. 최근 최대 50,000행 기준.
          </p>
        </>
      )}

      {detail && <DetailModal person={detail} onClose={() => setDetail(null)} />}
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

/* -------------------- 상세 모달 -------------------- */
function DetailModal({ person, onClose }: { person: Person; onClose: () => void }) {
  return (
    <Modal open onClose={onClose}>
      <h3 className="m-0 mb-1 text-[18px]">
        {person.이름 || '(이름없음)'} <span className="text-[13px] text-muted">{person.연락처}</span>
      </h3>
      <div className="mb-4 flex gap-[14px] text-[13px] text-muted">
        <span>
          총 사용횟수 <strong className="text-text">{fmtNum(person.총사용)}회</strong>
        </span>
        <span>
          총 결제금액 <strong className="text-text">{fmtNum(person.총결제)}원</strong>
        </span>
      </div>

      <div className={card}>
        <h4 className="m-0 mb-[10px] text-[14px]">보유 수강권 ({person.members.length})</h4>
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap border-collapse text-[13px]">
            <thead>
              <tr>
                {['수강권 종류', '수강권명', '전체', '잔여', '사용'].map((h) => (
                  <th key={h} className="border-b border-border px-2 py-[8px] text-left font-semibold text-muted">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {person.members.map((m, i) => (
                <tr key={i}>
                  <td className="border-b border-[#eef0f4] px-2 py-[8px]">{ticketType(m['수강권명'])}</td>
                  <td className="border-b border-[#eef0f4] px-2 py-[8px] text-muted">{m['수강권명']}</td>
                  <td className="border-b border-[#eef0f4] px-2 py-[8px]">{fmtNum(toInt(m['전체횟수']))}</td>
                  <td className="border-b border-[#eef0f4] px-2 py-[8px]">{fmtNum(toInt(m['잔여횟수']))}</td>
                  <td className="border-b border-[#eef0f4] px-2 py-[8px] font-semibold">{fmtNum(usedCount(m))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className={card}>
        <h4 className="m-0 mb-[10px] text-[14px]">결제 내역 ({person.sales.length})</h4>
        {!person.sales.length ? (
          <p className="m-0 text-[13px] text-muted">매출(sales) 데이터가 없습니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full whitespace-nowrap border-collapse text-[13px]">
              <thead>
                <tr>
                  {['결제일시', '수강권명', '결제구분', '결제금액'].map((h) => (
                    <th key={h} className="border-b border-border px-2 py-[8px] text-left font-semibold text-muted">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {person.sales.map((s, i) => (
                  <tr key={i}>
                    <td className="border-b border-[#eef0f4] px-2 py-[8px] text-muted">{s['결제일시']}</td>
                    <td className="border-b border-[#eef0f4] px-2 py-[8px]">{s['수강권명']}</td>
                    <td className="border-b border-[#eef0f4] px-2 py-[8px]">{s['결제구분']}</td>
                    <td className="border-b border-[#eef0f4] px-2 py-[8px]">{fmtNum(moneyOf(s['결제금액']))}원</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="mt-5 flex justify-end">
        <button className={btn.ghost} onClick={onClose}>
          닫기
        </button>
      </div>
    </Modal>
  );
}
