'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { sb } from '@/lib/supabase';
import {
  TABLE,
  COLUMNS,
  SEARCH_COLS,
  FILTER_COLS,
  USED_COUNT,
  EDITABLE,
  NUM_COLS,
  makeKey,
  fmtNum,
  sanitizeSearchTerm,
  fetchAllRows,
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
  const [sort, setSort] = useState<string>('등록일');
  const [dir, setDir] = useState(false); // false = 내림차순
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // ── 필터: 성별·수강권종류 드롭다운 + 사용횟수(전체−잔여) 범위 ──────────────
  const [filters, setFilters] = useState<Record<string, string>>({}); // { 성별, 수강권종류 }
  const [usedMin, setUsedMin] = useState('');
  const [usedMax, setUsedMax] = useState('');
  const [options, setOptions] = useState<Record<string, string[]>>({});

  const [editRow, setEditRow] = useState<MemberRecord | null>(null);
  const [delRow, setDelRow] = useState<MemberRecord | null>(null);

  const loadSeq = useRef(0); // 동시 load() 경쟁 방지: 낡은 응답이 최신 결과를 덮어쓰지 않게 함

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setLoadError(null);
    try {
      let query = sb.from(TABLE).select('*', { count: 'exact' });
      const term = sanitizeSearchTerm(q);
      if (term) {
        query = query.or(SEARCH_COLS.map((c) => `${c}.ilike.%${term}%`).join(','));
      }
      // 드롭다운 필터 (성별·수강권종류) — 정확 일치(AND)
      for (const c of FILTER_COLS) {
        if (filters[c]) query = query.eq(c, filters[c]);
      }
      // 사용횟수(전체−잔여) 범위 — DB의 used_count 생성 컬럼 기준
      if (usedMin !== '' && !isNaN(Number(usedMin))) query = query.gte(USED_COUNT, Number(usedMin));
      if (usedMax !== '' && !isNaN(Number(usedMax))) query = query.lte(USED_COUNT, Number(usedMax));
      query = query
        .order(sort, { ascending: dir, nullsFirst: false })
        .range(page * size, page * size + size - 1);
      const { data, count, error } = await query;
      if (seq !== loadSeq.current) return; // 더 새 load()가 시작됨 → 이 낡은 응답은 버린다
      if (error) throw error;
      setRows((data as unknown as MemberRecord[]) || []);
      setTotal(count || 0);
    } catch (err) {
      if (seq !== loadSeq.current) return;
      let msg = (err as Error).message || String(err);
      // used_count 컬럼 미생성 시(마이그레이션 전) 안내를 덧붙인다.
      if (/used_count/i.test(msg)) {
        msg += ' — 사용횟수 필터를 쓰려면 sql/2026-07_sales_and_used_count.sql 을 Supabase에서 실행하세요.';
      }
      setLoadError(msg);
      setRows([]);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [q, filters, usedMin, usedMax, sort, dir, page, size]);

  useEffect(() => {
    load();
  }, [load]);

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
          사용횟수(전체−잔여)
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
            setUsedMin('');
            setUsedMax('');
            setSearchInput('');
            setPage(0);
          }}
        >
          필터 초기화
        </button>
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
              <th className="sticky top-0 border-b border-border bg-[#f7f8fa] px-3 py-[11px] text-left font-semibold">
                관리
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={COLUMNS.length + 1}>
                  <div className="p-10 text-center text-sm text-muted">
                    <span className={spinner} /> 불러오는 중…
                  </div>
                </td>
              </tr>
            ) : loadError ? (
              <tr>
                <td colSpan={COLUMNS.length + 1}>
                  <div className="p-10 text-center text-sm text-muted">불러오기 실패: {loadError}</div>
                </td>
              </tr>
            ) : !rows.length ? (
              <tr>
                <td colSpan={COLUMNS.length + 1}>
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
            load();
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
            load();
          }}
          onError={(m) => toast('삭제 실패: ' + m, 'err')}
        />
      )}
    </>
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
