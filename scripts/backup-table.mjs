/* ======================================================================
   테이블 백업 → CSV (개발 도구 전용)
   ----------------------------------------------------------------------
   Supabase 무료 플랜에는 대시보드 자동 백업(Database → Backups)이 없다.
   되돌리기 어려운 SQL(중복 정리·키 재정의 등)을 돌리기 전에 이 스크립트로
   해당 테이블을 CSV 로 떠 둔다.

     npm run db:backup              # sales 백업
     npm run db:backup members      # 다른 테이블
     npm run db:backup sales members

   ⚠️ 보안
   · DATABASE_URL(전권 접속 문자열)을 쓰는 개발 도구다. 브라우저 앱과 무관하며
     클라이언트 번들에 절대 들어가지 않는다(app/ · components/ 에서 import 금지).
   · 결과 CSV 는 회원 PII 다. 기본 저장 위치를 OneDrive 동기화 밖(LOCALAPPDATA)으로
     둔 이유가 이것이다 — 프로젝트 폴더에 두면 그대로 클라우드에 올라간다.
     (.gitignore 가 *.csv 를 막지만 그건 커밋만 막지 동기화는 못 막는다.)
   ====================================================================== */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: '.env.local' });

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL 이 없습니다. .env.local 을 확인하세요. (.env.local.example 참고)');
  process.exit(1);
}

const tables = process.argv.slice(2).filter(Boolean);
if (!tables.length) tables.push('sales');

// 테이블명은 식별자로 쓰이므로 화이트리스트 문자만 허용한다(SQL 인젝션 차단).
for (const t of tables) {
  if (!/^[a-z_][a-z0-9_]*$/i.test(t)) {
    console.error(`테이블 이름이 올바르지 않습니다: ${t}`);
    process.exit(1);
  }
}

// 저장 위치 — OneDrive 동기화 밖. BACKUP_DIR 로 덮어쓸 수 있다.
const outDir =
  process.env.BACKUP_DIR ||
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local'), 'evble-backup');
fs.mkdirSync(outDir, { recursive: true });

// yyyymmdd_hhmm (로컬 시각)
const d = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;

// CSV 한 칸 — 항상 큰따옴표로 감싸고 내부 따옴표는 두 번 쓴다(줄바꿈·쉼표 안전).
function cell(v) {
  if (v === null || v === undefined) return '""';
  const s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return '"' + s.replace(/"/g, '""') + '"';
}

const sql = postgres(url, { prepare: false, max: 1 });
let failed = false;

try {
  for (const table of tables) {
    const rows = await sql`select * from ${sql(table)} order by id`;
    const file = path.join(outDir, `${table}_${stamp}.csv`);
    if (!rows.length) {
      fs.writeFileSync(file, '﻿', 'utf8');
      console.log(`⚠️  ${table} — 행이 없습니다. 빈 파일 생성: ${file}`);
      continue;
    }
    const cols = Object.keys(rows[0]);
    // ﻿(BOM) — Excel 이 UTF-8 한글을 깨지 않게 한다.
    const lines = ['﻿' + cols.map(cell).join(',')];
    for (const r of rows) lines.push(cols.map((c) => cell(r[c])).join(','));
    fs.writeFileSync(file, lines.join('\r\n'), 'utf8');
    const mb = (fs.statSync(file).size / 1048576).toFixed(2);
    console.log(`✅ ${table} — ${rows.length.toLocaleString('ko-KR')}행 · ${mb} MB → ${file}`);
  }
} catch (err) {
  failed = true;
  console.error('❌ 백업 실패:', err.message);
} finally {
  await sql.end({ timeout: 5 });
}

process.exit(failed ? 1 : 0);
