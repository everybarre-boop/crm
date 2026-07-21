'use client';

import { useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { sb } from '@/lib/supabase';
import { BRANCHES, fmtNum, ymKey } from '@/lib/members';
import { COSTS_TABLE, currentYearMonth } from '@/lib/costs';
import { useToast } from '@/components/ui/Toast';
import { btn, card } from '@/components/ui/styles';

/* ======================================================================
   비용 업로드 — 지점별·월별 비용이 담긴 엑셀을 올려 branch_costs 에 반영한다.
   대시보드가 이 값으로 "비용 총합 / 인건비 비율 / 임대료 비율"을 계산한다.
   저장은 (지점,연월) 유니크 기준 upsert(같은 지점·월은 덮어쓴다).

   엑셀 컬럼(헤더): 지점 · 연월 · 인건비 · 임대료 · 기타비용 · 메모(선택)
     - 지점: 청담·옥수·광교·반포·판교·송파 중 하나
     - 연월: 'YYYY-MM' (또는 2026-07-01 같은 날짜도 인식)
   ====================================================================== */

const norm = (s: string) => String(s).replace(/\s+/g, '').trim();
const NUM = (v: unknown) => Math.round(Number(String(v ?? '').replace(/[^0-9.-]/g, '')) || 0);

type Parsed = {
  지점: string;
  연월: string;
  인건비: number;
  임대료: number;
  기타비용: number;
  메모: string | null;
  _valid: boolean;
  _reason: string;
};

/* 시트 한 장(AOA)에서 헤더행을 자동 탐색해 레코드 배열로 바꾼다.
   - 제목/빈 행이 위에 있어도 '지점' + ('연월'|'인건비') 를 포함한 행을 헤더로 인식한다.
   - 헤더 위치를 1행으로 가정하던 기존 방식은, 행이 한 칸만 밀려도 전체가
     0/공란으로 파싱되던 문제가 있었다(전량 "지점명 없음" 오류). */
function rowsFromSheet(aoa: unknown[][]): Record<string, unknown>[] {
  let hi = -1;
  for (let i = 0; i < aoa.length; i++) {
    const cells = (aoa[i] ?? []).map((c) => norm(String(c ?? '')));
    if (cells.includes('지점') && (cells.includes('연월') || cells.includes('인건비'))) {
      hi = i;
      break;
    }
  }
  if (hi < 0) return [];
  const header = (aoa[hi] ?? []).map((c) => String(c ?? '').trim());
  const out: Record<string, unknown>[] = [];
  for (let r = hi + 1; r < aoa.length; r++) {
    const row = aoa[r] ?? [];
    if (row.every((c) => String(c ?? '').trim() === '')) continue; // 빈 행 스킵
    const rec: Record<string, unknown> = {};
    header.forEach((h, c) => {
      if (h) rec[h] = row[c] ?? '';
    });
    out.push(rec);
  }
  return out;
}

function readRows(f: File): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const name = f.name.toLowerCase();
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('파일을 읽지 못했습니다.'));
    reader.onload = (e) => {
      try {
        const result = e.target?.result;
        const wb = name.endsWith('.csv')
          ? XLSX.read(result as string, { type: 'string' })
          : XLSX.read(result as ArrayBuffer, { type: 'array' });
        // 모든 시트를 훑어 헤더가 있는 시트의 행을 모은다(월별 시트가 여러 장이어도 OK).
        const all: Record<string, unknown>[] = [];
        for (const sn of wb.SheetNames) {
          const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sn], {
            header: 1,
            raw: false,
            defval: '',
            blankrows: false,
          }) as unknown[][];
          all.push(...rowsFromSheet(aoa));
        }
        if (!all.length) {
          reject(
            new Error(
              `'지점'·'연월' 헤더를 찾지 못했습니다. 양식(지점·연월·인건비·임대료·기타비용·메모)을 확인하세요. 시트: ${wb.SheetNames.join(', ')}`,
            ),
          );
          return;
        }
        resolve(all);
      } catch (err) {
        reject(err);
      }
    };
    if (name.endsWith('.csv')) reader.readAsText(f, 'utf-8');
    else reader.readAsArrayBuffer(f);
  });
}

// 엑셀 헤더 정규화 매핑 (지점/연월/인건비/임대료/기타비용/메모)
function pick(row: Record<string, unknown>, names: string[]): unknown {
  const map: Record<string, unknown> = {};
  for (const k in row) map[norm(k)] = row[k];
  for (const n of names) if (map[norm(n)] !== undefined) return map[norm(n)];
  return undefined;
}

function toParsed(row: Record<string, unknown>): Parsed {
  const 지점 = String(pick(row, ['지점']) ?? '').trim();
  const 연월 = ymKey(pick(row, ['연월', '월', '기준월']));
  const p: Parsed = {
    지점,
    연월,
    인건비: NUM(pick(row, ['인건비'])),
    임대료: NUM(pick(row, ['임대료'])),
    기타비용: NUM(pick(row, ['기타비용', '기타'])),
    메모: (String(pick(row, ['메모']) ?? '').trim() || null) as string | null,
    _valid: true,
    _reason: '',
  };
  if (!BRANCHES.includes(지점 as (typeof BRANCHES)[number])) {
    p._valid = false;
    p._reason = `지점명이 목록(${BRANCHES.join('·')})에 없음`;
  } else if (!연월) {
    p._valid = false;
    p._reason = '연월(YYYY-MM)을 읽지 못함';
  }
  return p;
}

export default function Costs() {
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Parsed[]>([]);
  const [fileName, setFileName] = useState('');
  const [drag, setDrag] = useState(false);
  const [saving, setSaving] = useState(false);

  const valid = useMemo(() => rows.filter((r) => r._valid), [rows]);
  const invalid = useMemo(() => rows.filter((r) => !r._valid), [rows]);

  async function onFile(f: File | undefined) {
    if (!f) return;
    setFileName(f.name);
    try {
      const raw = await readRows(f);
      setRows(raw.map(toParsed));
    } catch (err) {
      toast('읽기 실패: ' + ((err as Error).message || String(err)), 'err');
      setRows([]);
    }
  }

  async function save() {
    if (!valid.length) return;
    setSaving(true);
    try {
      // 같은 (지점·연월)이 한 파일 안에 여러 번 있으면, 한 번의 upsert 로 같은 행을
      // 두 번 건드려 Postgres 가 배치 전체를 거부한다("ON CONFLICT ... cannot affect
      // row a second time") → 아무것도 저장되지 않는다. 미리 (지점,연월) 기준으로
      // 병합해(마지막 값 우선) 이를 막는다.
      const byKey = new Map<string, Parsed>();
      for (const r of valid) byKey.set(`${r.지점}${r.연월}`, r);
      const merged = Array.from(byKey.values());
      const dupMerged = valid.length - merged.length;

      const payload = merged.map((r) => ({
        지점: r.지점,
        연월: r.연월,
        인건비: r.인건비,
        임대료: r.임대료,
        기타비용: r.기타비용,
        메모: r.메모,
        updated_at: new Date().toISOString(),
      }));
      // .select() 로 실제로 DB에 쓰인 행을 되받아 저장을 확인한다.
      const { data, error } = await sb
        .from(COSTS_TABLE)
        .upsert(payload, { onConflict: '지점,연월' })
        .select();
      if (error) throw error;

      const saved = data?.length ?? 0;
      if (saved === 0) {
        toast(
          '저장된 행을 확인하지 못했습니다. 관리자 계정으로 로그인했는지/권한(RLS)을 확인하세요.',
          'err',
        );
        return;
      }
      toast(`${saved}건 저장했습니다.${dupMerged ? ` (같은 지점·월 ${dupMerged}건은 병합)` : ''}`);
      setRows([]);
      setFileName('');
    } catch (err) {
      let msg = (err as Error).message || String(err);
      if (/branch_costs/i.test(msg) || /relation.*does not exist/i.test(msg)) {
        msg += ' — 비용 테이블을 만들려면 sql/2026-07_setup_all.sql 을 Supabase에서 실행하세요.';
      } else if (/affect row a second time/i.test(msg)) {
        msg += ' — 파일에 같은 지점·월이 중복돼 있습니다.';
      }
      toast('저장 실패: ' + msg, 'err');
    } finally {
      setSaving(false);
    }
  }

  // 빈 양식(현재 월, 지점별 행) 다운로드
  function downloadTemplate() {
    const ym = currentYearMonth();
    const data = BRANCHES.map((b) => ({ 지점: b, 연월: ym, 인건비: 0, 임대료: 0, 기타비용: 0, 메모: '' }));
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '비용');
    XLSX.writeFile(wb, `비용양식_${ym}.xlsx`);
  }

  return (
    <>
      <div className="mb-[22px]">
        <h2 className="m-0 mb-1 text-[22px]">비용 업로드</h2>
        <p className="m-0 text-[13px] text-muted">
          지점별·월별 비용 엑셀을 올리면 대시보드에서 매출 대비 인건비·임대료 비율을 계산합니다. 같은 지점·월은 덮어씁니다.
        </p>
      </div>

      <div className={card}>
        <div className="mb-4 flex flex-wrap items-center gap-3 text-[13px]">
          <span className="font-semibold">엑셀 컬럼</span>
          <code className="rounded bg-[#f1f3f7] px-2 py-1 text-muted">지점 · 연월 · 인건비 · 임대료 · 기타비용 · 메모(선택)</code>
          <button className={btn.ghostSm} onClick={downloadTemplate}>
            양식 다운로드
          </button>
        </div>

        <label
          className={[
            'block cursor-pointer rounded-xl border-2 border-dashed p-10 text-center transition-colors',
            drag ? 'border-primary bg-primary-soft' : 'border-border hover:border-primary hover:bg-primary-soft',
          ].join(' ')}
          onDragEnter={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDrag(true);
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            setDrag(false);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDrag(false);
            onFile(e.dataTransfer.files?.[0]);
          }}
        >
          <div className="text-4xl">📁</div>
          <div className="my-1 mt-[10px] text-[15px] font-semibold">여기로 비용 엑셀을 끌어다 놓으세요</div>
          <div className="text-[13px] text-muted">또는 클릭해서 선택 · XLSX, XLS, CSV{fileName ? ` · ${fileName}` : ''}</div>
          <input
            ref={fileInput}
            type="file"
            className="hidden"
            accept=".csv,.xlsx,.xls,text/csv"
            onChange={(e) => {
              onFile(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </label>

        {rows.length > 0 && (
          <>
            <div className="mt-[16px] overflow-x-auto rounded-xl border border-border">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    {['지점', '연월', '인건비', '임대료', '기타비용', '합계', '메모', '상태'].map((h) => (
                      <th
                        key={h}
                        className="border-b border-border bg-[#f7f8fa] px-3 py-[10px] text-left font-semibold"
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => {
                    const sum = r.인건비 + r.임대료 + r.기타비용;
                    return (
                      <tr key={i} className={r._valid ? '' : 'bg-danger-soft'}>
                        <td className="border-b border-[#eef0f4] px-3 py-[8px] font-semibold">{r.지점 || '—'}</td>
                        <td className="border-b border-[#eef0f4] px-3 py-[8px]">{r.연월 || '—'}</td>
                        <td className="border-b border-[#eef0f4] px-3 py-[8px] text-right">{fmtNum(r.인건비)}</td>
                        <td className="border-b border-[#eef0f4] px-3 py-[8px] text-right">{fmtNum(r.임대료)}</td>
                        <td className="border-b border-[#eef0f4] px-3 py-[8px] text-right">{fmtNum(r.기타비용)}</td>
                        <td className="border-b border-[#eef0f4] px-3 py-[8px] text-right text-muted">{fmtNum(sum)}</td>
                        <td className="border-b border-[#eef0f4] px-3 py-[8px] text-muted">{r.메모 ?? ''}</td>
                        <td className="border-b border-[#eef0f4] px-3 py-[8px] text-[12px]">
                          {r._valid ? (
                            <span className="text-[#137333]">정상</span>
                          ) : (
                            <span className="text-danger">건너뜀 · {r._reason}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-[10px]">
              <button className={btn.primaryAuto + ' w-auto'} disabled={saving || !valid.length} onClick={save}>
                {saving ? '저장 중…' : `정상 ${valid.length}건 저장`}
              </button>
              {invalid.length > 0 && (
                <span className="text-[13px] text-danger">{invalid.length}건은 지점명/연월 오류로 건너뜁니다.</span>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
}
