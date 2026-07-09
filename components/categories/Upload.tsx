'use client';

import { useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { sb } from '@/lib/supabase';
import { TABLE, COLUMNS, makeKey, type MemberRecord } from '@/lib/members';
import { btn, card } from '@/components/ui/styles';

type LogLine = { msg: string; kind: 'ok' | 'err' | 'info' };

const norm = (s: string) => String(s).replace(/\s+/g, '').trim();

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

export default function Upload() {
  const [files, setFiles] = useState<File[]>([]);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [status, setStatus] = useState('저장할 파일을 먼저 올려주세요.');
  const [saving, setSaving] = useState(false);
  const [drag, setDrag] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // 엑셀 헤더(정규화) → DB 컬럼 매핑
  const columnMap = useMemo(() => {
    const m: Record<string, string> = {};
    COLUMNS.forEach((c) => (m[norm(c)] = c));
    return m;
  }, []);

  function addFiles(list: FileList | null) {
    if (!list) return;
    setFiles((prev) => [...prev, ...Array.from(list)]);
    setStatus((prev) => prev); // 상태 문구는 아래 렌더에서 files 길이로 갱신
  }
  function removeFile(i: number) {
    setFiles((prev) => prev.filter((_, idx) => idx !== i));
  }

  function toRecord(row: Record<string, unknown>): MemberRecord {
    const rec: MemberRecord = {};
    for (const key in row) {
      const col = columnMap[norm(key)];
      if (col) rec[col] = row[key] === '' ? null : String(row[key]);
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
      try {
        const rows = await readRows(f);
        if (!rows.length) {
          addLog({ msg: `⏭️ ${f.name} — 데이터 행이 없습니다.`, kind: 'info' });
          continue;
        }
        const rawCount = rows.length;
        const records = dedupeByKey(rows.map(toRecord));
        const merged = rawCount - records.length;
        const CHUNK = 500;
        let saved = 0;
        for (let i = 0; i < records.length; i += CHUNK) {
          const batch = records.slice(i, i + CHUNK);
          const { error } = await sb.from(TABLE).upsert(batch, { onConflict: 'dedup_key' });
          if (error) throw error;
          saved += batch.length;
          setStatus(`${f.name} 저장 중… ${saved}/${records.length}`);
        }
        totalSaved += saved;
        addLog({
          msg: `✅ ${f.name} — ${saved}행 반영 완료` + (merged > 0 ? ` (파일 내 중복 ${merged}행 합침)` : ''),
          kind: 'ok',
        });
      } catch (err) {
        totalFail++;
        addLog({ msg: `❌ ${f.name} — 저장 실패: ${(err as Error).message || String(err)}`, kind: 'err' });
      }
    }
    setStatus(`완료 — 총 ${totalSaved}행 저장${totalFail ? `, ${totalFail}개 실패` : ''}.`);
    setSaving(false);
  }

  const readyStatus = saving
    ? status
    : files.length === 0
      ? '저장할 파일을 먼저 올려주세요.'
      : `${files.length}개 파일 준비됨.`;

  return (
    <>
      <div className="mb-[22px]">
        <h2 className="m-0 mb-1 text-[22px]">데이터 업로드</h2>
        <p className="m-0 text-[13px] text-muted">
          엑셀(.xlsx, .xls) · CSV 를 올리면 <code>members</code> 테이블에 upsert 됩니다. 같은 수강권은 중복 없이
          갱신됩니다.
        </p>
      </div>

      <div className={card}>
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
          <button className={btn.primaryAuto + ' w-auto'} disabled={files.length === 0 || saving} onClick={saveAll}>
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
