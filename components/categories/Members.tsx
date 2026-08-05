'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { sb } from '@/lib/supabase';
import {
  TABLE,
  COLUMNS,
  SEARCH_COLS,
  FILTER_COLS,
  BRANCHES,
  BRANCH_SRC_COL,
  EDITABLE,
  NUM_COLS,
  makeKey,
  fmtNum,
  usedCount,
  sanitizeSearchTerm,
  fetchAllRows,
  makePersonResolver,
  isUsableTicket,
  SCAN_ORDER_COL,
  type MemberRecord,
} from '@/lib/members';
import { useToast } from '@/components/ui/Toast';
import { Modal } from '@/components/ui/Modal';
import { btn, input, spinner } from '@/components/ui/styles';

export default function Members() {
  const toast = useToast();

  const [rows, setRows] = useState<MemberRecord[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(50);
  const [q, setQ] = useState('');
  // 기본 정렬 — 예약사이트 내보내기에 등록일이 없어 전 행이 빈 값이라, 수강권시작일로 정렬한다.
  const [sort, setSort] = useState<string>('수강권시작일');
  const [dir, setDir] = useState(false); // false = 내림차순
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── 필터: 성별·수강권종류·지점 드롭다운 + 사용횟수(전체−잔여) 범위 ──────────
  const [filters, setFilters] = useState<Record<string, string>>({}); // { 성별, 수강권종류 }
  const [branch, setBranch] = useState('');
  const [usedMin, setUsedMin] = useState('');
  const [usedMax, setUsedMax] = useState('');
  const [options, setOptions] = useState<Record<string, string[]>>({});

  const [editRow, setEditRow] = useState<MemberRecord | null>(null);
  const [delRow, setDelRow] = useState<MemberRecord | null>(null);

  // ── 요약 통계: 총 회원 / 현재 사용 / 만료 (1인 = 이름+연락처, 현재 필터 반영) ──────────
  // 총 회원 = 필터에 걸린 사람 수(중복 등록건은 1명으로), 현재 사용 = 종료일이 안 지났고
  // 잔여횟수 > 0 인 수강권을 하나라도 가진 사람, 만료 = 나머지(종료일 지났거나 잔여 소진).
  // 지점 선택이 없으면 전체가 대상.
  const [stats, setStats] = useState<{ total: number; active: number; expired: number } | null>(null);

  /* ── 1인 합산 사용횟수 인덱스 ────────────────────────────────────────────────
     사용횟수 필터는 "이 사람이 지금까지 몇 회 했나"로 걸러야 한다. DB의 used_count
     컬럼은 **수강권 1건짜리** 값이라 그걸로 거르면(예전 방식) 한 수강권에서만 100회
     넘게 쓴 행을 찾게 된다 — 사람 단위 합산이 아니다.
     그래서 전체 members 를 가벼운 컬럼만 한 번 읽어 사람별 합계를 만들어 둔다.
     ⚠️ 지점 필터와 무관하게 **전 지점 합산**이다(판교 이가원 + 반포 이가원 = 한 사람). */
  const [personTotals, setPersonTotals] = useState<Map<string, number> | null>(null);
  const [personKeyOf, setPersonKeyOf] = useState<((r: Record<string, unknown>) => string) | null>(null);
  const [indexError, setIndexError] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0); // 수정/삭제 후 인덱스 재계산용

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // dedup_key 도 받는다 — makePersonResolver 가 "동명이인 + 연락처 빈 행"을
        // 행 단위로 구분하는 기준이고, 표/요약과 같은 키를 얻으려면 양쪽에 있어야 한다.
        const all = await fetchAllRows('dedup_key,이름,연락처,전체횟수,잔여횟수');
        if (!alive) return;
        const keyOf = makePersonResolver(all);
        const totals = new Map<string, number>();
        for (const r of all) {
          const k = keyOf(r);
          totals.set(k, (totals.get(k) ?? 0) + usedCount(r));
        }
        setPersonKeyOf(() => keyOf);
        setPersonTotals(totals);
        setIndexError(false);
      } catch {
        if (alive) {
          setPersonTotals(null);
          setIndexError(true);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [refreshKey]);

  const loadSeq = useRef(0); // 동시 load() 경쟁 방지: 낡은 응답이 최신 결과를 덮어쓰지 않게 함

  // 사용횟수 범위가 입력돼 있나 (둘 중 하나라도)
  const minN = usedMin !== '' && !isNaN(Number(usedMin)) ? Number(usedMin) : null;
  const maxN = usedMax !== '' && !isNaN(Number(usedMax)) ? Number(usedMax) : null;
  const usedFilterOn = minN !== null || maxN !== null;

  /* 클라이언트에서 걸러야 하는 두 경우 — 이때만 전체를 받아 화면에서 페이징한다.
     ① 사용횟수 필터: 사람 단위 합계라 서버가 못 건다.
     ② 숫자 컬럼 정렬: DB 컬럼이 전부 text 라 서버 정렬은 **사전순**이 된다
        (전체횟수 300 < 9). 예전에는 ①이 켜질 때만 숫자 정렬을 해서, 같은 화면이
        사용횟수 필터를 넣고 빼는 것만으로 정렬 순서가 뒤바뀌었다. 숫자 컬럼은
        항상 이쪽 경로로 보내 두 경우의 순서를 일치시킨다. */
  const clientSide = usedFilterOn || NUM_COLS.has(sort);

  /* 전체 스캔 결과 캐시 — page/size 만 바뀔 때 17,000행을 다시 긁지 않는다.
     (예전엔 "다음" 클릭 한 번마다 select('*') 왕복 ~18회가 다시 돌았다) */
  const scanCache = useRef<{ sig: string; hit: MemberRecord[] } | null>(null);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError(null);
    let keepLoading = false; // 인덱스 대기 중이면 스피너를 유지한다(아래 finally)
    try {
      // 검색·드롭다운·지점은 서버에서 거른다(사용횟수 제외 — 그건 사람 단위라 아래에서).
      /* eslint-disable @typescript-eslint/no-explicit-any */
      const applyServerFilters = (q0: any): any => {
        let qq = q0;
        const term = sanitizeSearchTerm(q);
        if (term) qq = qq.or(SEARCH_COLS.map((c) => `${c}.ilike.%${term}%`).join(','));
        for (const c of FILTER_COLS) if (filters[c]) qq = qq.eq(c, filters[c]);
        // 지점 — 수강권명에 "체험권(광교)"처럼 들어있어 부분일치로 거른다.
        // 값은 BRANCHES 상수라 사용자 입력이 아니고, ilike 패턴은 값이 아니라 우리가 만든다.
        if (branch) qq = qq.ilike(BRANCH_SRC_COL, `%${branch}%`);
        return qq;
      };
      /* eslint-enable @typescript-eslint/no-explicit-any */

      if (!clientSide) {
        // ── 빠른 길: 서버 페이징 그대로 ──
        const query = applyServerFilters(sb.from(TABLE).select('*', { count: 'exact' }))
          .order(sort, { ascending: dir, nullsFirst: false })
          .range(page * size, page * size + size - 1);
        const { data, count, error } = await query;
        if (seq !== loadSeq.current) return; // 더 새 load()가 시작됨 → 이 낡은 응답은 버린다
        if (error) throw error;
        setRows((data as unknown as MemberRecord[]) || []);
        setTotal(count || 0);
        return;
      }

      // ── 전체를 받아 (사람별 합계로 거르고) 정렬한 뒤 화면에서 페이징 ──
      if (usedFilterOn && (!personTotals || !personKeyOf)) {
        if (indexError) throw new Error('1인 합산 사용횟수를 계산하지 못했습니다.');
        // 인덱스 준비 중 — 준비되면 이 effect 가 다시 돈다. 이전(필터 없던) 결과를
        // 그대로 두고 스피너만 끄면 "100회 이상 = 17,617명" 처럼 읽히므로 로딩을 유지한다.
        keepLoading = true;
        return;
      }

      // 같은 조건이면 이미 받아 둔 결과를 재사용한다(page/size 는 signature 에 없다).
      const sig = JSON.stringify([q, filters, branch, minN, maxN, sort, dir, refreshKey]);
      let hit = scanCache.current?.sig === sig ? scanCache.current.hit : null;

      if (!hit) {
        const PAGE = 1000;
        const collected: MemberRecord[] = [];
        for (let from = 0; ; from += PAGE) {
          // ⚠️ .order() 필수 — ORDER BY 없는 OFFSET 페이징은 행 중복/누락을 낸다.
          const { data, error } = await applyServerFilters(sb.from(TABLE).select('*'))
            .order(SCAN_ORDER_COL, { ascending: true })
            .range(from, from + PAGE - 1);
          if (seq !== loadSeq.current) return;
          if (error) throw error;
          const chunk = (data as unknown as MemberRecord[]) || [];
          collected.push(...chunk);
          if (chunk.length < PAGE || collected.length >= 50000) break;
        }
        hit =
          usedFilterOn && personTotals && personKeyOf
            ? collected.filter((r) => {
                const t = personTotals.get(personKeyOf(r)) ?? 0;
                if (minN !== null && t < minN) return false;
                if (maxN !== null && t > maxN) return false;
                return true;
              })
            : collected;
        // 서버 정렬을 못 쓰므로 화면에서 정렬한다(숫자 컬럼은 숫자로, 빈 값은 항상 뒤).
        const num = NUM_COLS.has(sort);
        hit.sort((a, b) => {
          const av = a[sort] ?? '';
          const bv = b[sort] ?? '';
          if (av === '' && bv === '') return 0;
          if (av === '') return 1;
          if (bv === '') return -1;
          const c = num
            ? Number(String(av).replace(/[^0-9.-]/g, '')) - Number(String(bv).replace(/[^0-9.-]/g, ''))
            : String(av).localeCompare(String(bv), 'ko');
          return dir ? c : -c;
        });
        if (seq !== loadSeq.current) return;
        scanCache.current = { sig, hit };
      }
      setRows(hit.slice(page * size, page * size + size));
      setTotal(hit.length);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      setLoadError((err as Error).message || String(err));
      setRows([]);
      setTotal(0); // 이걸 안 지우면 "총 17,617건 · 다음" 페이저가 살아 있어 계속 실패만 반복한다
    } finally {
      if (seq === loadSeq.current && !keepLoading) setLoading(false);
    }
  }, [
    q,
    filters,
    branch,
    clientSide,
    usedFilterOn,
    minN,
    maxN,
    sort,
    dir,
    page,
    size,
    personTotals,
    personKeyOf,
    indexError,
    refreshKey,
  ]);

  useEffect(() => {
    load();
  }, [load]);

  // 요약 통계 계산: 현재 필터에 걸린 "모든" 행을 가벼운 컬럼만 골라 페이지 단위로 받아
  // 이름+연락처로 1인 단위로 묶는다. (페이지네이션과 무관하게 전체를 집계) 필터를 빠르게
  // 바꿔도 매번 전체를 긁지 않도록 350ms 디바운스한다.
  useEffect(() => {
    /* 전역 resolver 가 준비되기 전에는 계산하지 않는다.
       예전엔 personKeyOf 가 없으면 `makePersonResolver(all)` 로 대체했는데, 그 `all` 은
       검색·지점 필터가 이미 적용된 **부분집합**이라 "이 이름의 연락처가 유일한가" 판정이
       전역이 아니라 필터 범위 안에서 이뤄졌다 — 같은 사람인데 화면마다 회원 수가 달라진다. */
    if (!personKeyOf) return;
    if (usedFilterOn && !personTotals) return; // 인덱스 준비되면 deps 변경으로 다시 돈다
    const keyOf = personKeyOf;
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const PAGE = 1000;
        const all: MemberRecord[] = [];
        for (let from = 0; ; from += PAGE) {
          // 사용횟수는 여기서 거르지 않는다 — 사람 단위 합계라 아래에서 personTotals 로 건다.
          // dedup_key: 동명이인 + 연락처 빈 행을 표·인덱스와 같은 기준으로 구분하기 위함.
          let query = sb.from(TABLE).select('dedup_key,이름,연락처,잔여횟수,수강권종료일');
          const term = sanitizeSearchTerm(q);
          if (term) query = query.or(SEARCH_COLS.map((c) => `${c}.ilike.%${term}%`).join(','));
          for (const c of FILTER_COLS) if (filters[c]) query = query.eq(c, filters[c]);
          if (branch) query = query.ilike(BRANCH_SRC_COL, `%${branch}%`);
          // ⚠️ .order() 필수 — ORDER BY 없는 OFFSET 페이징은 행 중복/누락을 낸다.
          const { data, error } = await query
            .order(SCAN_ORDER_COL, { ascending: true })
            .range(from, from + PAGE - 1);
          if (!alive) return; // 필터가 바뀌었다 — 남은 페이지를 더 긁지 않는다
          if (error) throw error;
          const chunk = (data as unknown as MemberRecord[]) || [];
          all.push(...chunk);
          if (chunk.length < PAGE || from + PAGE >= 50000) break;
        }
        // 전 행을 다 모은 뒤에 1인 단위로 묶는다 — 지점이 달라도 이름+연락처가 같으면 한 사람.
        const activeByPerson = new Map<string, boolean>(); // 사람 → 사용 가능 수강권 보유 여부
        for (const r of all) {
          const k = keyOf(r);
          if (usedFilterOn && personTotals) {
            const t = personTotals.get(k) ?? 0;
            if (minN !== null && t < minN) continue;
            if (maxN !== null && t > maxN) continue;
          }
          activeByPerson.set(k, (activeByPerson.get(k) || false) || isUsableTicket(r));
        }
        let activeN = 0;
        for (const a of activeByPerson.values()) if (a) activeN++;
        const totalN = activeByPerson.size;
        setStats({ total: totalN, active: activeN, expired: totalN - activeN });
      } catch {
        if (alive) setStats(null); // 실패해도 표는 그대로 — 요약만 숨긴다
      }
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [q, filters, branch, usedFilterOn, minN, maxN, personTotals, personKeyOf]);

  // 필터 드롭다운 옵션: 저카디널리티 컬럼(성별·수강권종류)의 실제 값 목록을 한 번 수집
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const rows = await fetchAllRows(FILTER_COLS.join(','));
        if (!alive) return;
        const opt: Record<string, string[]> = {};
        for (const c of FILTER_COLS) {
          opt[c] = [...new Set(rows.map((r) => (r[c] as string) || '').filter(Boolean))].sort((a, b) =>
            a.localeCompare(b, 'ko'),
          );
        }
        setOptions(opt);
      } catch {
        /* 옵션 수집 실패는 치명적이지 않다 — 드롭다운만 비게 둔다 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  // 검색어 디바운스 (300ms)
  const [searchInput, setSearchInput] = useState('');
  useEffect(() => {
    const t = setTimeout(() => {
      setQ(searchInput);
      setPage(0);
    }, 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  function onSort(c: string) {
    if (sort === c) setDir((d) => !d);
    else {
      setSort(c);
      setDir(false);
    }
    setPage(0);
  }

  const start = total ? page * size + 1 : 0;
  const end = Math.min((page + 1) * size, total);

  return (
    <>
      <div className="mb-[22px]">
        <h2 className="m-0 mb-1 text-[22px]">회원 관리</h2>
        <p className="m-0 text-[13px] text-muted">검색·정렬 후 각 행을 수정하거나 삭제할 수 있습니다.</p>
      </div>

      <div className="mb-[14px] flex flex-wrap items-center gap-[10px]">
        <input
          className={`${input} min-w-[200px] flex-1`}
          placeholder="이름 · 수강권명 · 종류 · 성별 검색"
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />
        <select
          className="rounded-[10px] border border-border bg-white px-3 py-[10px] text-sm"
          value={size}
          onChange={(e) => {
            setSize(+e.target.value);
            setPage(0);
          }}
        >
          <option value={25}>25개씩</option>
          <option value={50}>50개씩</option>
          <option value={100}>100개씩</option>
        </select>
      </div>

      {/* 필터 바: 성별·수강권종류 드롭다운 + 사용횟수(전체−잔여) 범위 */}
      <div className="mb-[14px] flex flex-wrap items-end gap-x-[10px] gap-y-3 rounded-xl border border-border bg-[#f7f8fa] px-[14px] py-3">
        {FILTER_COLS.map((c) => (
          <label key={c} className="flex flex-col gap-1 text-[12px] text-muted">
            {c}
            <select
              className="rounded-[10px] border border-border bg-white px-3 py-[9px] text-sm text-text"
              value={filters[c] ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                setFilters((s) => ({ ...s, [c]: v }));
                setPage(0);
              }}
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
          지점
          <select
            className="rounded-[10px] border border-border bg-white px-3 py-[9px] text-sm text-text"
            value={branch}
            onChange={(e) => {
              setBranch(e.target.value);
              setPage(0);
            }}
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
          사용횟수 <span className="text-[11px] text-primary">1인 합산 · 전 지점</span>
          <div className="flex items-center gap-[6px]">
            <input
              type="number"
              min={0}
              inputMode="numeric"
              className="w-[84px] rounded-[10px] border border-border bg-white px-3 py-[9px] text-sm"
              placeholder="최소"
              value={usedMin}
              onChange={(e) => {
                setUsedMin(e.target.value);
                setPage(0);
              }}
            />
            <span className="text-muted">~</span>
            <input
              type="number"
              min={0}
              inputMode="numeric"
              className="w-[84px] rounded-[10px] border border-border bg-white px-3 py-[9px] text-sm"
              placeholder="최대"
              value={usedMax}
              onChange={(e) => {
                setUsedMax(e.target.value);
                setPage(0);
              }}
            />
          </div>
        </label>

        <button
          className={btn.ghostSm}
          onClick={() => {
            setFilters({});
            setBranch('');
            setUsedMin('');
            setUsedMax('');
            setSearchInput('');
            setPage(0);
          }}
        >
          필터 초기화
        </button>

        {/* 요약 통계 — 현재 필터(지점 등) 기준 1인 단위 집계. 지점 미선택 시 전체 대상. */}
        <div className="ml-auto flex flex-wrap items-center gap-2 self-center">
          {indexError && (
            <span className="text-[12px] text-danger">
              1인 합산 사용횟수를 불러오지 못했습니다 — 사용횟수 필터·합계 열을 쓸 수 없습니다.
            </span>
          )}
          <StatChip label="총 회원" value={stats?.total} loading={stats === null} />
          <StatChip label="현재 사용" value={stats?.active} tone="green" loading={stats === null} />
          <StatChip label="만료" value={stats?.expired} tone="muted" loading={stats === null} />
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full whitespace-nowrap border-collapse text-[13px]">
          <thead>
            <tr>
              {COLUMNS.map((c) => (
                <th
                  key={c}
                  onClick={() => onSort(c)}
                  className="sticky top-0 cursor-pointer select-none border-b border-border bg-[#f7f8fa] px-3 py-[11px] text-left font-semibold"
                >
                  {c} {sort === c && <span className="text-[11px] text-primary">{dir ? '▲' : '▼'}</span>}
                </th>
              ))}
              <th
                className="sticky top-0 border-b border-border bg-[#f7f8fa] px-3 py-[11px] text-left font-semibold"
                title="이 사람의 전 지점 사용횟수 합계 (이름+연락처가 같으면 동일인)"
              >
                총 사용횟수<span className="ml-1 text-[11px] font-normal text-muted">1인</span>
              </th>
              <th className="sticky top-0 border-b border-border bg-[#f7f8fa] px-3 py-[11px] text-left font-semibold">
                관리
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={COLUMNS.length + 2}>
                  <div className="p-10 text-center text-sm text-muted">
                    <span className={spinner} /> 불러오는 중…
                  </div>
                </td>
              </tr>
            ) : loadError ? (
              <tr>
                <td colSpan={COLUMNS.length + 2}>
                  <div className="p-10 text-center text-sm text-muted">불러오기 실패: {loadError}</div>
                </td>
              </tr>
            ) : !rows.length ? (
              <tr>
                <td colSpan={COLUMNS.length + 2}>
                  <div className="p-10 text-center text-sm text-muted">결과가 없습니다.</div>
                </td>
              </tr>
            ) : (
              rows.map((r, i) => (
                <tr key={r.dedup_key ?? i} className="hover:bg-[#fafbfc]">
                  {COLUMNS.map((c) => (
                    <td key={c} className="border-b border-[#eef0f4] px-3 py-[10px]">
                      {NUM_COLS.has(c) ? fmtNum(r[c]) : (r[c] ?? '')}
                    </td>
                  ))}
                  {/* 이 행이 아니라 "이 사람"의 전 지점 합계. 실패 시 '—'(로딩 '…' 과 구분) */}
                  <td className="border-b border-[#eef0f4] px-3 py-[10px] font-semibold">
                    {personTotals && personKeyOf
                      ? fmtNum(personTotals.get(personKeyOf(r)) ?? 0)
                      : indexError
                        ? '—'
                        : '…'}
                  </td>
                  <td className="border-b border-[#eef0f4] px-3 py-[10px]">
                    <div className="flex gap-[6px]">
                      <button className={btn.ghostSm} onClick={() => setEditRow(r)}>
                        수정
                      </button>
                      <button className={btn.dangerGhostSm} onClick={() => setDelRow(r)}>
                        삭제
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="mt-[14px] flex items-center gap-3 text-[13px] text-muted">
        <span>총 {fmtNum(total)}건</span>
        <span className="flex-1" />
        <button className={btn.ghostSm} disabled={page === 0} onClick={() => setPage((p) => Math.max(0, p - 1))}>
          이전
        </button>
        <span>
          {fmtNum(start)}–{fmtNum(end)}
        </span>
        <button className={btn.ghostSm} disabled={end >= total} onClick={() => setPage((p) => p + 1)}>
          다음
        </button>
      </div>

      {editRow && (
        <EditModal
          row={editRow}
          onClose={() => setEditRow(null)}
          onSaved={() => {
            setEditRow(null);
            toast('수정되었습니다.');
            // refreshKey 만 올린다 — 인덱스 재계산 + load() 재실행이 여기에 딸려 온다.
            // (load() 를 같이 부르면 전체 스캔이 두 번 돈다)
            setRefreshKey((k) => k + 1);
          }}
          onError={(m) => toast('수정 실패: ' + m, 'err')}
        />
      )}
      {delRow && (
        <DeleteModal
          row={delRow}
          onClose={() => setDelRow(null)}
          onDeleted={() => {
            setDelRow(null);
            toast('삭제되었습니다.');
            setRefreshKey((k) => k + 1); // 등록건이 사라졌으니 1인 합산 인덱스 → load() 순으로 갱신
          }}
          onError={(m) => toast('삭제 실패: ' + m, 'err')}
        />
      )}
    </>
  );
}

/* -------------------- 요약 통계 칩 -------------------- */
function StatChip({
  label,
  value,
  tone,
  loading,
}: {
  label: string;
  value: number | undefined;
  tone?: 'green' | 'muted';
  loading?: boolean;
}) {
  const toneCls = tone === 'green' ? 'text-[#137333]' : tone === 'muted' ? 'text-muted' : 'text-text';
  return (
    <div className="flex items-center gap-2 rounded-[10px] border border-border bg-white px-3 py-[7px]">
      <span className="text-[12px] text-muted">{label}</span>
      <span className={`text-[15px] font-bold tabular-nums ${toneCls}`}>
        {loading ? '…' : fmtNum(value)}
      </span>
    </div>
  );
}

/* -------------------- 수정 모달 -------------------- */
function EditModal({
  row,
  onClose,
  onSaved,
  onError,
}: {
  row: MemberRecord;
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const origKey = row.dedup_key ?? makeKey(row);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const v: Record<string, string> = {};
    COLUMNS.forEach((c) => (v[c] = row[c] == null ? '' : String(row[c])));
    return v;
  });
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    const patch: MemberRecord = {};
    COLUMNS.forEach((c) => {
      const v = (values[c] ?? '').trim();
      patch[c] = v === '' ? null : v;
    });
    patch.dedup_key = makeKey(patch); // 키 컬럼이 바뀌면 dedup_key도 재계산
    try {
      const { error } = await sb.from(TABLE).update(patch).eq('dedup_key', origKey);
      if (error) throw error;
      onSaved();
    } catch (err) {
      setSaving(false);
      onError((err as Error).message || String(err));
    }
  }

  return (
    <Modal open onClose={onClose}>
      <h3 className="m-0 mb-4 text-[18px]">회원 정보 수정</h3>
      <div className="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
        {COLUMNS.map((c) => (
          <div key={c} className={c === '수강권명' ? 'col-span-full' : ''}>
            <label className="mb-[6px] block text-[13px] font-semibold">{c}</label>
            <input
              className={input}
              value={values[c]}
              disabled={!EDITABLE.has(c)}
              onChange={(e) => setValues((s) => ({ ...s, [c]: e.target.value }))}
            />
          </div>
        ))}
      </div>
      <div className="mt-5 flex justify-end gap-[10px]">
        <button className={btn.ghost} onClick={onClose}>
          취소
        </button>
        <button className={btn.primaryAuto + ' w-auto'} disabled={saving} onClick={save}>
          {saving ? '저장 중…' : '저장'}
        </button>
      </div>
    </Modal>
  );
}

/* -------------------- 삭제 모달 -------------------- */
function DeleteModal({
  row,
  onClose,
  onDeleted,
  onError,
}: {
  row: MemberRecord;
  onClose: () => void;
  onDeleted: () => void;
  onError: (msg: string) => void;
}) {
  const origKey = row.dedup_key ?? makeKey(row);
  const [deleting, setDeleting] = useState(false);

  async function remove() {
    setDeleting(true);
    try {
      const { error } = await sb.from(TABLE).delete().eq('dedup_key', origKey);
      if (error) throw error;
      onDeleted();
    } catch (err) {
      setDeleting(false);
      onError((err as Error).message || String(err));
    }
  }

  return (
    <Modal open onClose={onClose}>
      <h3 className="m-0 mb-4 text-[18px]">삭제 확인</h3>
      <p className="m-0 mb-1 text-sm text-text">
        <strong>{row['이름']}</strong> · {row['수강권명']}
      </p>
      <p className="m-0 text-[13px] text-muted">이 레코드를 삭제하시겠습니까? 되돌릴 수 없습니다.</p>
      <div className="mt-5 flex justify-end gap-[10px]">
        <button className={btn.ghost} onClick={onClose}>
          취소
        </button>
        <button className={btn.danger + ' w-auto'} disabled={deleting} onClick={remove}>
          {deleting ? '삭제 중…' : '삭제'}
        </button>
      </div>
    </Modal>
  );
}
