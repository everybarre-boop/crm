'use client';

import { useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { sb } from '@/lib/supabase';
import { TABLE, makeKey, canonicalColumn, type MemberRecord } from '@/lib/members';
import { SALES_TABLE, toSalesRecord } from '@/lib/sales';
import { btn, card } from '@/components/ui/styles';

type LogLine = { msg: string; kind: 'ok' | 'err' | 'info' };

/* 엑셀 행을 "표준 컬럼명" 행으로 정규화한다(별칭 해석 포함). 이렇게 한 번 맞춰두면
   members(정규화 매핑)와 sales(정확 헤더 참조) 두 저장 경로가 모두 같은 표준명을 본다.
   - 매핑 안 된 헤더는 unmapped 로 모아 로그에 보여준다(어떤 엑셀 컬럼이 무시됐는지).
   - 같은 표준 컬럼에 여러 헤더가 오면(예: 연락처+휴대폰) 먼저 온 "빈 값 아님"을 유지. */
function canonicalizeRows(rows: Record<string, unknown>[]): {
  rows: Record<string, unknown>[];
  unmapped: string[];
} {
  const unmapped = new Set<string>();
  const out = rows.map((row) => {
    const rec: Record<string, unknown> = {};
    for (const key in row) {
      const col = canonicalColumn(key);
      if (!col) {
        unmapped.add(String(key));
        continue;
      }
      const cur = rec[col];
      if (cur === undefined || cur === null || cur === '') rec[col] = row[key];
    }
    return rec;
  });
  return { rows: out, unmapped: [...unmapped] };
}

function hasAnyValue(rows: Record<string, unknown>[], col: string): boolean {
  return rows.some((r) => r[col] != null && String(r[col]).trim() !== '');
}

function formatSize(b: number): string {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1048576).toFixed(1) + ' MB';
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
        const ws = wb.Sheets[wb.SheetNames[0]];
        resolve(XLSX.utils.sheet_to_json(ws, { raw: false, defval: '' }));
      } catch (err) {
        reject(err);
      }
    };
    if (name.endsWith('.csv')) reader.readAsText(f, 'utf-8');
    else reader.readAsArrayBuffer(f);
  });
}

// 한 파일을 대상 테이블에 chunk 단위로 upsert. 반영/합침 행수를 돌려준다.
async function upsertBatches(
  table: string,
  records: MemberRecord[],
  onProgress: (n: number) => void,
): Promise<number> {
  const CHUNK = 500;
  let saved = 0;
  for (let i = 0; i < records.length; i += CHUNK) {
    const batch = records.slice(i, i + CHUNK);
    const { error } = await sb.from(table).upsert(batch, { onConflict: 'dedup_key' });
    if (error) throw error;
    saved += batch.length;
    onProgress(saved);
  }
  return saved;
}

export default function Upload() {
  const [files, setFiles] = useState<File[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [status, setStatus] = useState('저장할 파일을 먼저 올려주세요.');
  const [saving, setSaving] = useState(false);
  const [drag, setDrag] = useState(false);
  // 저장 대상: 회원(members) / 매출(sales). 같은 회원 파일에서 컬럼만 나눠 각 테이블로 보낸다.
  const [toMembers, setToMembers] = useState(true);
  const [toSales, setToSales] = useState(true);
  const fileInput = useRef<HTMLInputElement>(null);

  function addFiles(list: FileList | null) {
    if (!list) return;
    setFiles((prev) => [...prev, ...Array.from(list)]);
  }
  function removeFile(i: number) {
    setFiles((prev) => prev.filter((_, idx) => idx !== i));
  }

  // 표준화된 행 → members 레코드. (canonicalizeRows 로 키가 이미 표준 컬럼명이라 그대로 담는다)
  function toMemberRecord(row: Record<string, unknown>): MemberRecord {
    const rec: MemberRecord = {};
    for (const key in row) {
      const v = row[key];
      rec[key] = v === '' || v == null ? null : String(v);
    }
    rec.dedup_key = makeKey(rec);
    return rec;
  }
  function dedupeByKey(records: MemberRecord[]): MemberRecord[] {
    const map = new Map<string, MemberRecord>();
    for (const rec of records) map.set(rec.dedup_key!, rec);
    return [...map.values()];
  }

  async function saveAll() {
    setSaving(true);
    setLogs([]);
    const addLog = (line: LogLine) => setLogs((prev) => [...prev, line]);
    let totalSaved = 0;
    let totalFail = 0;

    for (const f of files) {
      let rows: Record<string, unknown>[];
      try {
        rows = await readRows(f);
      } catch (err) {
        totalFail++;
        addLog({ msg: `❌ ${f.name} — 읽기 실패: ${(err as Error).message || String(err)}`, kind: 'err' });
        continue;
      }
      if (!rows.length) {
        addLog({ msg: `⏭️ ${f.name} — 데이터 행이 없습니다.`, kind: 'info' });
        continue;
      }
      const rawCount = rows.length;

      // 엑셀 헤더를 표준 컬럼명으로 한 번 정규화(별칭 해석). 두 저장 경로가 이 결과를 공유한다.
      const { rows: crows, unmapped } = canonicalizeRows(rows);
      if (unmapped.length) {
        addLog({
          msg: `ℹ️ ${f.name} — 무시된 컬럼(표준 컬럼/별칭에 없음): ${unmapped.join(', ')}`,
          kind: 'info',
        });
      }
      // 연락처가 통째로 비면 사람 식별(이름+연락처)이 무너진다 — 헤더 이름을 바로 알린다.
      if (toMembers && !hasAnyValue(crows, '연락처')) {
        addLog({
          msg: `⚠️ ${f.name} — 연락처 값이 하나도 없습니다. 엑셀의 전화번호 컬럼명을 확인하세요(필요하면 별칭에 추가).`,
          kind: 'err',
        });
      }

      // ── 회원(members) 저장 ──────────────────────────────────────────────
      if (toMembers) {
        try {
          const records = dedupeByKey(crows.map(toMemberRecord));
          const merged = rawCount - records.length;
          const saved = await upsertBatches(TABLE, records, (n) =>
            setStatus(`${f.name} · 회원 저장 중… ${n}/${records.length}`),
          );
          totalSaved += saved;
          addLog({
            msg: `✅ ${f.name} · 회원 — ${saved}행 반영` + (merged > 0 ? ` (파일 내 중복 ${merged}행 합침)` : ''),
            kind: 'ok',
          });
        } catch (err) {
          totalFail++;
          addLog({ msg: `❌ ${f.name} · 회원 — 저장 실패: ${(err as Error).message || String(err)}`, kind: 'err' });
        }
      }

      // ── 매출(sales) 저장 ────────────────────────────────────────────────
      if (toSales) {
        try {
          const records = dedupeByKey(crows.map(toSalesRecord));
          const merged = rawCount - records.length;
          const saved = await upsertBatches(SALES_TABLE, records, (n) =>
            setStatus(`${f.name} · 매출 저장 중… ${n}/${records.length}`),
          );
          totalSaved += saved;
          addLog({
            msg: `✅ ${f.name} · 매출 — ${saved}행 반영` + (merged > 0 ? ` (파일 내 중복 ${merged}행 합침)` : ''),
            kind: 'ok',
          });
        } catch (err) {
          totalFail++;
          addLog({ msg: `❌ ${f.name} · 매출 — 저장 실패: ${(err as Error).message || String(err)}`, kind: 'err' });
        }
      }
    }
    setStatus(`완료 — 총 ${totalSaved}행 저장${totalFail ? `, ${totalFail}개 실패` : ''}.`);
    setSaving(false);
  }

  const noTarget = !toMembers && !toSales;
  const readyStatus = saving
    ? status
    : files.length === 0
      ? '저장할 파일을 먼저 올려주세요.'
      : noTarget
        ? '저장 대상(회원/매출)을 하나 이상 선택하세요.'
        : `${files.length}개 파일 준비됨.`;

  return (
    <>
      <div className="mb-[22px]">
        <h2 className="m-0 mb-1 text-[22px]">데이터 업로드</h2>
        <p className="m-0 text-[13px] text-muted">
          회원 엑셀(.xlsx, .xls) · CSV 한 장을 올리면 <strong>회원 정보는 <code>members</code></strong>, <strong>결제(매출)
          정보는 <code>sales</code></strong> 테이블로 나눠 upsert 됩니다. 같은 건은 중복 없이 갱신됩니다.
          헤더 이름이 조금 달라도(예: 휴대폰·전화번호 → 연락처) 별칭으로 인식하며, 매핑 안 된 컬럼은 저장 로그에 표시됩니다.
        </p>
      </div>

      <div className={card}>
        <div className="mb-4 flex flex-wrap items-center gap-4">
          <span className="text-[13px] font-semibold">저장 대상</span>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={toMembers} onChange={(e) => setToMembers(e.target.checked)} disabled={saving} />
            회원 데이터 <code className="text-muted">members</code>
          </label>
          <label className="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" checked={toSales} onChange={(e) => setToSales(e.target.checked)} disabled={saving} />
            매출 데이터 <code className="text-muted">sales</code>
          </label>
          <span className="text-xs text-muted">※ 특정 대상만 저장하려면 체크를 해제하세요.</span>
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
            addFiles(e.dataTransfer.files);
          }}
        >
          <div className="text-4xl">📁</div>
          <div className="my-1 mt-[10px] text-[15px] font-semibold">여기로 파일을 끌어다 놓으세요</div>
          <div className="text-[13px] text-muted">또는 클릭해서 선택 · XLSX, XLS, CSV</div>
          <input
            ref={fileInput}
            type="file"
            className="hidden"
            accept=".csv,.xlsx,.xls,text/csv"
            multiple
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = '';
            }}
          />
        </label>

        <ul className="mt-[14px] list-none p-0">
          {files.map((f, i) => {
            const ext = (f.name.split('.').pop() || '').toUpperCase();
            return (
              <li key={i} className="mb-2 flex items-center gap-3 rounded-[10px] border border-border px-[14px] py-[11px]">
                <span>📄</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-semibold">{f.name}</div>
                  <div className="text-xs text-muted">
                    {ext} · {formatSize(f.size)}
                  </div>
                </div>
                <button
                  className="rounded-md border-none bg-transparent px-2 py-[6px] text-[13px] text-danger hover:bg-danger-soft"
                  onClick={() => removeFile(i)}
                >
                  삭제
                </button>
              </li>
            );
          })}
        </ul>

        <div className="mt-4 flex flex-wrap items-center gap-[10px]">
          <button
            className={btn.primaryAuto + ' w-auto'}
            disabled={files.length === 0 || saving || noTarget}
            onClick={saveAll}
          >
            Supabase에 저장
          </button>
          <span className="text-[13px] text-muted">{readyStatus}</span>
        </div>

        <div className="mt-[14px] text-[13px]">
          {logs.map((l, i) => (
            <div
              key={i}
              className={[
                'mb-[6px] rounded-lg px-3 py-2',
                l.kind === 'ok'
                  ? 'bg-success-soft text-success'
                  : l.kind === 'err'
                    ? 'bg-danger-soft text-danger'
                    : 'bg-[#f1f3f7] text-text',
              ].join(' ')}
            >
              {l.msg}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
