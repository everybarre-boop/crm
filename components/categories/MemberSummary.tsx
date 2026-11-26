'use client';

import { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  fetchAllRows,
  fmtNum,
  usedCount,
  personUsedCount,
  toInt,
  ticketType,
  isTrial,
  isUsableTicket,
  phoneDigits,
  makePersonResolver,
  matchesBranch,
  BRANCHES,
  KEY_SEP,
  type MemberRecord,
} from '@/lib/members';
import { SALES_TABLE } from '@/lib/sales';
import { sb } from '@/lib/supabase';
import { Modal } from '@/components/ui/Modal';
import { btn, input, card, spinner } from '@/components/ui/styles';

/* ======================================================================
   회원별 집계 — "이 사람이 지금까지 몇 회 했고 얼마 결제했나"를 1인 단위로.
   members(등록건)·sales(결제건)를 이름+연락처(숫자)로 묶어 CRM의 핵심 데이터를 만든다.
   - 출석(실측) = 스튜디오메이트 회원 페이지의 `출석(N)` 전 사이트 합(crm_attendance_person).
     야간 자동화가 **예약이 잡힌 회원만** 읽으므로 없는 사람은 '—'. 결석·노쇼는 안 들어간다.
   - 차감 횟수 = 그 사람의 **수강권 등록건별** (전체−잔여) 합(personUsedCount).
     결석·노쇼도 차감되므로 출석보다 크게 나오는 게 정상이다(권인정: 차감 474 · 출석 418).
     ⚠️ member 행을 그냥 더하면 안 된다 — 같은 수강권 한 장이 이름 표식·결제 분할로
        여러 행이 되고 그 행들이 같은 잔여횟수를 각자 든다(2026-08-14 마일스톤 오발송의 원인).
     🔥 등록건 = 수강권명 + **수강권시작일**. 예전에 select 에서 수강권시작일이 빠져 같은
        수강권명의 재등록이 전부 1건으로 접혔다(권인정 114회로 표시 — 2026-11-04 수정).
   - 총 결제금액 = 그 사람 sales 행들의 결제금액 합 (sales가 결제 원장)
   - 연도별 출석 = crm_attendance_person_yearly(수업일 연도 기준 · 전 사이트 합).
     🔥 사이트마다 따로 읽은 값의 합이라, 그 사람이 수강권을 가진 사이트 중 **하나라도**
        연도별을 아직 안 읽었으면 숫자를 보여 주지 않는다('—'). 일부 사이트만 더한 값은
        "그 해 출석"이 아니다 — 다지점 회원에게서 조용히 낮게 나온다(임동우 사고와 같은 구조).
   ====================================================================== */

/* 지점 → 스튜디오메이트 사이트. 출석 수는 **사이트별**로 읽힌다(청담·판교는 한 사이트).
   ⚠️ automation/config.mjs 의 SITES · sql 의 crm_attendance_person(_yearly) CASE 와 같아야 한다. */
const SITE_OF_BRANCH: Record<string, string> = {
  청담: 'everybarre',
  판교: 'everybarre',
  광교: 'everybarre-gwanggyo',
  옥수: 'everybarre-oksu',
  반포: 'everybarre-banpo',
  송파: 'everybarre-songpa',
};

type Person = {
  key: string;
  이름: string;
  연락처: string;
  members: MemberRecord[]; // 보유 수강권(등록건)들
  sales: MemberRecord[]; // 결제 내역들
  총사용: number;
  출석: number | null; // 실측 출석 수 — 근거가 없으면 null(지어내지 않는다)
  연도별: Record<number, number>; // 수업일 연도 → 출석 수 (연도별완전일 때만 믿는다)
  연도별완전: boolean;
  연도누락지점: string[]; // 연도별을 아직 못 읽은 사이트의 지점명(진단용)
  총결제: number;
  체험여부: boolean;
  활성: boolean; // 현재 회원 = 지금 사용 가능한 수강권(잔여>0·미만료)을 하나라도 보유
};

type StatusFilter = '전체' | '현재' | '비활성';

function moneyOf(v: unknown): number {
  return Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0;
}

/** 연도별 출석 — 완전하지 않으면 null(화면엔 '—'). 완전한데 그 해 기록이 없으면 0. */
function yearCount(p: Person, year: number): number | null {
  return p.연도별완전 ? p.연도별[year] ?? 0 : null;
}

type SortKey = '총결제' | '출석' | '연도출석' | '총사용' | '이름';
const THIS_YEAR = new Date().getFullYear();

export default function MemberSummary() {
  const [memberRows, setMemberRows] = useState<MemberRecord[] | null>(null);
  const [salesRows, setSalesRows] = useState<MemberRecord[]>([]);
  const [attRows, setAttRows] = useState<{ person_key: string; 출석수: unknown }[]>([]);
  const [yearRows, setYearRows] = useState<{ person_key: string; 연도: unknown; 출석수: unknown }[]>([]);
  const [siteRows, setSiteRows] = useState<{ person_key: string; site: string; 연도기준일: string | null }[]>([]);
  const [error, setError] = useState<string | null>(null);

  const [q, setQ] = useState('');
  const [branch, setBranch] = useState('');
  const [status, setStatus] = useState<StatusFilter>('전체');
  const [sort, setSort] = useState<SortKey>('총결제');
  const [year, setYear] = useState<number>(THIS_YEAR);
  const [detail, setDetail] = useState<Person | null>(null);

  useEffect(() => {
    let alive = true;
    // 뷰·테이블 하나를 정렬 걸어 전부 읽는다(사람×연도 · 사람×사이트라 수만 행 이하)
    const readAll = async <T,>(table: string, cols: string, order: string[]): Promise<T[]> => {
      const out: T[] = [];
      for (let from = 0; ; from += 1000) {
        let qb = sb.from(table).select(cols);
        for (const o of order) qb = qb.order(o);
        const { data, error } = await qb.range(from, from + 999);
        if (error) throw error;
        out.push(...((data || []) as unknown as T[]));
        if (!data || data.length < 1000) return out;
      }
    };
    (async () => {
      try {
        const [m, s, a, y, st] = await Promise.all([
          // dedup_key: makePersonResolver 가 "동명이인 + 연락처 빈 행"을 행 단위로 구분하는 기준.
          fetchAllRows(
            // 수강권시작일: personUsedCount 가 재등록을 구분하는 기준. 빼면 재등록이 1건으로 접힌다.
            // 결제일시: makePersonResolver 가 개명('손소영' → '손소영M')을 등록건 공유로 알아보는 근거.
            'dedup_key,이름,연락처,성별,수강권명,수강권종류,전체횟수,잔여횟수,등록일,수강권시작일,수강권종료일,결제일시',
          ),
          fetchAllRows(
            'dedup_key,이름,연락처,수강권명,수강권종류,결제구분,결제금액,결제일시',
            50000,
            SALES_TABLE,
          ).catch(() => [] as MemberRecord[]),
          // 사람×사이트를 이미 합친 뷰라 수천 행 이하 — 한 번에 읽는다.
          (async () => {
            const { data, error } = await sb
              .from('crm_attendance_person')
              .select('person_key,출석수')
              .order('person_key')
              .limit(50000);
            if (error) throw error;
            return (data || []) as unknown as { person_key: string; 출석수: unknown }[];
          })().catch(() => []),
          // 연도별이 없으면(SQL 미적용 등) 빈 배열 → 전원 '—'. 지어내지 않는다.
          readAll<{ person_key: string; 연도: unknown; 출석수: unknown }>(
            'crm_attendance_person_yearly',
            'person_key,연도,출석수',
            ['person_key', '연도'],
          ).catch(() => []),
          readAll<{ person_key: string; site: string; 연도기준일: string | null }>(
            'crm_attendance',
            'person_key,site,연도기준일',
            ['id'],
          ).catch(() => []),
        ]);
        if (!alive) return;
        setMemberRows(m);
        setSalesRows(s);
        setAttRows(a);
        setYearRows(y);
        setSiteRows(st);
      } catch (err) {
        if (alive) setError((err as Error).message || String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 이름+연락처(숫자)로 1인 단위 그룹핑 — 지점이 달라도 같은 사람이면 한 행으로 합친다.
  // (연락처가 빈 행은 그 이름의 연락처가 유일할 때만 붙인다 — makePersonResolver 참고)
  const people = useMemo(() => {
    if (!memberRows) return null;
    const keyOf = makePersonResolver(memberRows, salesRows);
    const map = new Map<string, Person>();
    const get = (rec: MemberRecord): Person => {
      const k = keyOf(rec);
      let p = map.get(k);
      if (!p) {
        p = {
          key: k,
          // 키의 이름 = 대표 이름(개명했으면 지금 이름 · 미수금 같은 표식은 뗀 것). 첫 행의
          // 이름을 쓰면 옛 이름('손소영')이 보일 수 있다.
          이름: k.split(KEY_SEP)[0] || String(rec['이름'] ?? '').trim(),
          연락처: String(rec['연락처'] ?? ''),
          members: [],
          sales: [],
          총사용: 0,
          출석: null,
          연도별: {},
          연도별완전: false,
          연도누락지점: [],
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
      if (isTrial(r)) p.체험여부 = true;
      if (isUsableTicket(r)) p.활성 = true;
      if (!p.연락처 && r['연락처']) p.연락처 = String(r['연락처']);
    }
    /* 총사용은 행을 더하지 않고 **수강권 등록건별로 접어서** 센다.
       같은 수강권 한 장이 이름 표식('○○○ 미수금')·결제 분할로 여러 행이 되고 그 행들이
       같은 잔여횟수를 각자 들기 때문이다(실측 583명 부풀림 · 최대 615회). */
    for (const p of map.values()) p.총사용 = personUsedCount(p.members);

    /* 실측 출석 — person_key(이름⋮숫자연락처)를 같은 resolver 로 다시 풀어 붙인다.
       송파 체험처럼 연락처 없이 잡힌 사이트('권인정⋮')도 그 이름의 연락처가 유일하면
       같은 사람으로 합쳐진다. 회원(members)에 없는 키는 버린다(사람을 새로 만들지 않는다). */
    for (const a of attRows) {
      const [이름, 연락처 = ''] = String(a.person_key ?? '').split(KEY_SEP);
      const p = map.get(keyOf({ 이름, 연락처 }));
      if (!p) continue;
      p.출석 = (p.출석 ?? 0) + toInt(a.출석수);
    }

    /* 연도별 출석 — 같은 resolver 로 붙인다(개명·표식으로 갈린 키도 한 사람으로).
       완전성: 그 사람이 수강권을 가진 **모든 사이트**에 연도별이 읽혀 있어야 한다. */
    const personOfStored = (pk: string) => {
      const [이름, 연락처 = ''] = String(pk ?? '').split(KEY_SEP);
      return map.get(keyOf({ 이름, 연락처 }));
    };
    for (const r of yearRows) {
      const p = personOfStored(r.person_key);
      const y = toInt(r.연도);
      if (!p || !y) continue;
      p.연도별[y] = (p.연도별[y] ?? 0) + toInt(r.출석수);
    }
    const yearSites = new Map<Person, Map<string, boolean>>();
    for (const r of siteRows) {
      const p = personOfStored(r.person_key);
      if (!p) continue;
      if (!yearSites.has(p)) yearSites.set(p, new Map());
      const m = yearSites.get(p)!;
      m.set(r.site, (m.get(r.site) ?? false) || !!r.연도기준일);
    }
    for (const p of map.values()) {
      const got = yearSites.get(p) ?? new Map<string, boolean>();
      const missing = new Set<string>();
      for (const m of p.members) {
        for (const b of BRANCHES) {
          const site = SITE_OF_BRANCH[b];
          if (site && matchesBranch(m, b) && !got.get(site)) missing.add(b);
        }
      }
      // 수강권 지점을 하나도 모르는 사람은 판단 근거가 없다 — 완전으로 치지 않는다
      p.연도별완전 = got.size > 0 && missing.size === 0 && [...got.values()].every(Boolean);
      p.연도누락지점 = [...missing];
    }

    for (const r of salesRows) {
      // 결제 내역은 회원(이름+연락처)에 붙인다. 매칭 안 되는 결제도 사람으로 남긴다.
      const p = get(r);
      p.sales.push(r);
      p.총결제 += moneyOf(r['결제금액']);
    }
    return [...map.values()];
  }, [memberRows, salesRows, attRows, yearRows, siteRows]);

  // 연도 선택지 = 데이터에 있는 연도(최신순). 없으면 올해만.
  const years = useMemo(() => {
    const s = new Set<number>([THIS_YEAR]);
    for (const r of yearRows) {
      const y = toInt(r.연도);
      if (y) s.add(y);
    }
    return [...s].sort((a, b) => b - a);
  }, [yearRows]);

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
      if (sort === '출석') return (b.출석 ?? -1) - (a.출석 ?? -1);
      if (sort === '연도출석') return (yearCount(b, year) ?? -1) - (yearCount(a, year) ?? -1);
      return b[sort] - a[sort];
    });
    return out;
  }, [people, q, branch, status, sort, year]);

  const totals = useMemo(() => {
    if (!filtered) return null;
    const known = filtered.filter((p) => p.연도별완전);
    return {
      인원: filtered.length,
      현재: filtered.filter((p) => p.활성).length,
      총사용: filtered.reduce((s, p) => s + p.총사용, 0),
      총결제: filtered.reduce((s, p) => s + p.총결제, 0),
      연도출석: known.reduce((s, p) => s + (yearCount(p, year) ?? 0), 0),
      연도미수집: filtered.length - known.length,
    };
  }, [filtered, year]);

  /* 지금 화면에 보이는 목록(필터·정렬 적용 그대로)을 엑셀로 내려받는다.
     숫자는 숫자 셀로 넣어 엑셀에서 바로 합계·정렬이 되게 한다. 문자열은 SheetJS 가
     문자열 셀로 쓰므로 이름에 '=…' 이 있어도 수식으로 실행되지 않는다. */
  function downloadXlsx() {
    if (!filtered) return;
    const data = filtered.map((p) => ({
      이름: p.이름,
      연락처: p.연락처,
      상태: p.활성 ? '현재' : '비활성',
      체험: p.체험여부 ? 'Y' : '',
      지점: BRANCHES.filter((b) => p.members.some((m) => matchesBranch(m, b))).join(', '),
      '보유 수강권': p.members.length,
      '출석(실측)': p.출석 ?? '',
      // 연도별 — 오래된 해부터. 수집이 덜 된 사람은 빈칸(일부 지점만 더한 값을 내보내지 않는다)
      ...Object.fromEntries(
        [...years].reverse().map((y) => [`${y}년 출석`, yearCount(p, y) ?? ''] as const),
      ),
      '차감 횟수': p.총사용,
      '총 결제금액': p.총결제,
    }));
    const ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = [10, 15, 8, 6, 22, 11, 11, ...years.map(() => 11), 10, 14].map((wch) => ({ wch }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '회원별 집계');
    const d = new Date();
    const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    XLSX.writeFile(wb, `회원별집계_${branch || '전체'}_${ymd}.xlsx`);
  }

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
          출석 연도
          <select
            className="rounded-[10px] border border-border bg-white px-3 py-[9px] text-sm text-text"
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
          >
            {years.map((y) => (
              <option key={y} value={y}>
                {y}년
              </option>
            ))}
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
            <option value="출석">출석(실측) 많은순</option>
            <option value="연도출석">{year}년 출석 많은순</option>
            <option value="총사용">차감 횟수 많은순</option>
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
            setYear(THIS_YEAR);
          }}
        >
          필터 초기화
        </button>
        <button className={btn.ghostSm} disabled={!filtered?.length} onClick={downloadXlsx}>
          엑셀 다운로드{filtered ? ` (${fmtNum(filtered.length)}명)` : ''}
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
            <Stat
              label={`${year}년 출석 합`}
              value={fmtNum(totals.연도출석)}
              note={totals.연도미수집 ? `연도별 미수집 ${fmtNum(totals.연도미수집)}명 제외` : undefined}
            />
            <Stat label="차감 횟수 합" value={fmtNum(totals.총사용)} />
            <Stat label="총 결제금액 합" value={`${fmtNum(totals.총결제)}원`} small />
          </div>

          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full whitespace-nowrap border-collapse text-[13px]">
              <thead>
                <tr>
                  {['이름', '연락처', '보유 수강권', '출석(실측)', `${year}년 출석`, '차감 횟수', '총 결제금액'].map((h) => (
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
                    <td colSpan={7}>
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
                      <td className="border-b border-[#eef0f4] px-3 py-[10px] font-semibold">
                        {p.출석 == null ? <span className="text-muted">—</span> : `${fmtNum(p.출석)}회`}
                      </td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px]">
                        {yearCount(p, year) == null ? (
                          <span
                            className="text-muted"
                            title={
                              p.연도누락지점.length
                                ? `연도별 미수집 지점: ${p.연도누락지점.join(', ')}`
                                : '연도별 미수집'
                            }
                          >
                            —
                          </span>
                        ) : (
                          `${fmtNum(yearCount(p, year)!)}회`
                        )}
                      </td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px]">{fmtNum(p.총사용)}회</td>
                      <td className="border-b border-[#eef0f4] px-3 py-[10px]">{fmtNum(p.총결제)}원</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <p className="mt-[14px] text-xs text-muted">
            ※ 출석(실측)은 스튜디오메이트 회원 페이지의 출석 수(전 지점 합)로, 야간 자동화가 읽은 회원만 있습니다(없으면 —).
            연도별 출석은 수업일 기준 전 지점 합이며, 수강권이 있는 지점 중 하나라도 아직 읽지 못한 회원은 —로 둡니다.
            차감 횟수는 수강권 등록건별 전체−잔여 합계라 결석·노쇼도 포함됩니다. 총 결제금액은 매출(sales) 기준.
          </p>
        </>
      )}

      {detail && <DetailModal person={detail} onClose={() => setDetail(null)} />}
    </>
  );
}

function Stat({ label, value, small, note }: { label: string; value: string; small?: boolean; note?: string }) {
  return (
    <div className="rounded-[14px] border border-border bg-card px-5 py-[18px]">
      <div className="text-[13px] text-muted">{label}</div>
      <div className={`mt-[6px] font-bold ${small ? 'text-[22px]' : 'text-[28px]'}`}>{value}</div>
      {note && <div className="mt-1 text-[11px] text-muted">{note}</div>}
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
          출석(실측){' '}
          <strong className="text-text">{person.출석 == null ? '—' : `${fmtNum(person.출석)}회`}</strong>
        </span>
        <span>
          차감 횟수 <strong className="text-text">{fmtNum(person.총사용)}회</strong>
        </span>
        <span>
          총 결제금액 <strong className="text-text">{fmtNum(person.총결제)}원</strong>
        </span>
      </div>

      <div className={card}>
        <h4 className="m-0 mb-[10px] text-[14px]">연도별 출석 (수업일 기준 · 전 지점 합)</h4>
        {!person.연도별완전 ? (
          <p className="m-0 text-[13px] text-muted">
            아직 모든 지점의 연도별 출석을 읽지 못했습니다
            {person.연도누락지점.length ? ` (미수집: ${person.연도누락지점.join(', ')})` : ''}.
          </p>
        ) : !Object.keys(person.연도별).length ? (
          <p className="m-0 text-[13px] text-muted">출석 기록이 없습니다.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {Object.entries(person.연도별)
              .sort(([a], [b]) => Number(b) - Number(a))
              .map(([y, n]) => (
                <div key={y} className="rounded-[10px] border border-border px-3 py-2 text-[13px]">
                  <span className="text-muted">{y}년</span> <strong>{fmtNum(n)}회</strong>
                </div>
              ))}
          </div>
        )}
      </div>

      <div className={card}>
        <h4 className="m-0 mb-[10px] text-[14px]">보유 수강권 ({person.members.length})</h4>
        <div className="overflow-x-auto">
          <table className="w-full whitespace-nowrap border-collapse text-[13px]">
            <thead>
              <tr>
                {['수강권 종류', '수강권명', '시작일', '전체', '잔여', '사용'].map((h) => (
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
                  <td className="border-b border-[#eef0f4] px-2 py-[8px] text-muted">{String(m['수강권시작일'] ?? '')}</td>
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
