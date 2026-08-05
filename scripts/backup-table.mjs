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
     접속 문자열은 에러 메시지에도 새면 안 되므로 출력 전 항상 maskUrl() 로 가린다.
   · 결과 CSV 는 회원 PII 다. 기본 저장 위치를 OneDrive 동기화 밖(LOCALAPPDATA)으로
     둔 이유가 이것이다 — 프로젝트 폴더에 두면 그대로 클라우드에 올라간다.
     (.gitignore 가 *.csv 를 막지만 그건 커밋만 막지 동기화는 못 막는다.)
     BACKUP_DIR 로 위치를 바꿀 수 있지만, 동기화/배포되는 경로는 아래에서 거부한다.
   ====================================================================== */
import fs from 'fs';
import path from 'path';
import os from 'os';
import { config } from 'dotenv';
import postgres from 'postgres';

// .env.local 위치는 DOTENV_PATH 로 바꿀 수 있다 — DATABASE_URL 은 RLS 를 우회하는
// 전권 비밀번호라, OneDrive 로 동기화되는 이 프로젝트 폴더 밖에 두는 편이 안전하다.
config({ path: process.env.DOTENV_PATH || '.env.local' });

// 에러 메시지·스택에 접속 문자열이 통째로 찍히는 사고를 막는다.
// (비밀번호에 @ # % 같은 미인코딩 특수문자가 있으면 postgres.js 내부 new URL() 이
//  ERR_INVALID_URL 을 던지는데, Node 는 그 에러의 input 속성 — 즉 전체 접속 문자열 — 을
//  같이 출력한다.)
function maskUrl(s) {
  // [^\s]* 는 탐욕적 — 마지막 @ 까지 지운다. 비밀번호에 @ 가 들어 있어도(P@ss…)
  // 첫 @ 에서 끊겨 뒷부분이 남는 일이 없다. 과하게 가려지는 쪽이 안전하다.
  return String(s ?? '').replace(/(\w+:\/\/)[^\s]*@/g, '$1***:***@');
}

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
const outDir = path.resolve(
  process.env.BACKUP_DIR ||
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), '.local'), 'evble-backup'),
);

/* 저장 경로 가드 — 전 회원 PII 덤프가 새어 나가는 두 경로를 막는다.
   · 프로젝트 폴더 안: OneDrive 로 즉시 동기화되고, public/ 이면 next build 가
     out/ 으로 복사해 공개 호스팅에 배포한다. (.gitignore 는 커밋만 막는다.)
   · 경로에 OneDrive 가 들어간 곳: 프로젝트 밖이어도 그대로 클라우드에 올라간다. */
const repoRoot = process.cwd();
const inRepo = outDir === repoRoot || outDir.startsWith(repoRoot + path.sep);
const inOneDrive = /(^|[\\/])onedrive([\\/]|$)/i.test(outDir);
if (inRepo || inOneDrive) {
  console.error(
    `백업 위치가 안전하지 않습니다: ${outDir}\n` +
      `  ${inRepo ? '프로젝트 폴더 안이라' : 'OneDrive 동기화 경로라'} 회원 PII CSV 가 클라우드로 새어 나갑니다.\n` +
      `  BACKUP_DIR 를 동기화 밖 경로로 지정하거나(예: %LOCALAPPDATA%\\evble-backup) 비워 두세요.`,
  );
  process.exit(1);
}

// 0o700 — 같은 머신의 다른 로컬 계정이 PII 덤프를 읽지 못하게 한다.
// (Windows 에서는 무시되지만 ACL 로 사용자 프로필이 이미 보호된다. POSIX 폴백용.)
fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });

// yyyymmdd_hhmm (로컬 시각)
const d = new Date();
const p2 = (n) => String(n).padStart(2, '0');
const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;

/* CSV 한 칸 — 항상 큰따옴표로 감싸고 내부 따옴표는 두 번 쓴다(줄바꿈·쉼표 안전).
   ⚠️ CSV 인젝션 방어: 이 파일은 BOM 을 붙여 Excel 열람을 전제하는데, Excel 은
   큰따옴표로 감싼 셀이라도 = + - @ 로 시작하면 수식(DDE 포함)으로 실행한다.
   회원이 예약사이트 이름/메모란에 =HYPERLINK("http://…"&A2,"확인") 같은 값을 넣어두면
   관리자가 이 백업(전 회원 PII)을 여는 순간 옆 셀의 실명·연락처가 외부로 나간다.
   그래서 위험 문자로 시작하는 값 앞에 작은따옴표를 붙여 텍스트로 고정한다.
   (음수 등 순수 숫자는 복원 시 값이 달라지지 않도록 그대로 둔다.) */
const FORMULA_START = /^[=+\-@\t\r]/;
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
function cell(v) {
  if (v === null || v === undefined) return '""';
  let s = v instanceof Date ? v.toISOString() : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (FORMULA_START.test(s) && !PLAIN_NUMBER.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}

// 0o600 — 디렉터리와 같은 이유(POSIX 폴백에서 다른 계정이 PII 를 못 읽게).
const FILE_MODE = { encoding: 'utf8', mode: 0o600 };

let sql = null;
let failed = false;

try {
  // postgres(url) 자체도 try 안에서 호출한다 — 접속 문자열 파싱 실패가 여기서
  // uncaught 로 터지면 비밀번호가 스택과 함께 그대로 출력된다.
  sql = postgres(url, { prepare: false, max: 1 });
  for (const table of tables) {
    const rows = await sql`select * from ${sql(table)} order by id`;
    const file = path.join(outDir, `${table}_${stamp}.csv`);
    if (!rows.length) {
      fs.writeFileSync(file, '﻿', FILE_MODE);
      console.log(`⚠️  ${table} — 행이 없습니다. 빈 파일 생성: ${file}`);
      continue;
    }
    const cols = Object.keys(rows[0]);
    // ﻿(BOM) — Excel 이 UTF-8 한글을 깨지 않게 한다.
    const lines = ['﻿' + cols.map(cell).join(',')];
    for (const r of rows) lines.push(cols.map((c) => cell(r[c])).join(','));
    fs.writeFileSync(file, lines.join('\r\n'), FILE_MODE);
    const mb = (fs.statSync(file).size / 1048576).toFixed(2);
    console.log(`✅ ${table} — ${rows.length.toLocaleString('ko-KR')}행 · ${mb} MB → ${file}`);
  }
} catch (err) {
  failed = true;
  // err 객체를 통째로 넘기지 말 것 — ERR_INVALID_URL 의 input 속성에 접속 문자열이 들어 있다.
  console.error('❌ 백업 실패:', maskUrl(err?.message ?? err));
} finally {
  if (sql) await sql.end({ timeout: 5 });
}

process.exit(failed ? 1 : 0);
