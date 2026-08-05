/* ======================================================================
   sql/ 의 마이그레이션 파일 실행 (개발 도구 전용)
   ----------------------------------------------------------------------
   Supabase SQL Editor 에 700줄짜리 파일을 복사·붙여넣기 하는 대신 쓴다.

     npm run db:sql sql/2026-08_apply_attendance_v2.sql
     npm run db:sql sql/2026-08_crm.sql sql/2026-08_verify_crm.sql

   ⚠️ 보안 — scripts/backup-table.mjs 와 같은 원칙
   · DATABASE_URL(전권 접속 문자열, RLS 우회)을 쓰는 개발 도구다. 브라우저 앱과 무관하며
     클라이언트 번들에 절대 들어가지 않는다(app/ · components/ 에서 import 금지).
   · 접속 문자열은 에러 메시지에도 새면 안 되므로 출력 전 항상 maskUrl() 로 가린다.
   · 실행 대상은 **저장소의 sql/*.sql 로만** 제한한다. 임의 경로의 SQL 을 이 전권 연결로
     돌리는 통로를 만들지 않는다.

   ⚠️ 각 파일은 **하나의 암묵 트랜잭션**으로 실행된다(simple query protocol).
      중간에 실패하면 그 파일 전체가 롤백되므로 반쯤 적용된 상태가 남지 않는다.
      되돌리기 어려운 작업 전에는 `npm run db:backup` 을 먼저 돌릴 것.
   ====================================================================== */
import fs from 'fs';
import path from 'path';
import { config } from 'dotenv';
import postgres from 'postgres';

config({ path: process.env.DOTENV_PATH || '.env.local' });

// 비밀번호에 @ 등이 있으면 postgres.js 내부 new URL() 이 던지는 에러의 input 속성에
// 접속 문자열이 통째로 들어간다. 출력 전 반드시 통과시킨다.
function maskUrl(s) {
  return String(s ?? '').replace(/(\w+:\/\/)[^\s]*@/g, '$1***:***@');
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL 이 없습니다. .env.local 을 확인하세요.');
  process.exit(1);
}

const files = process.argv.slice(2).filter(Boolean);
if (!files.length) {
  console.error('실행할 SQL 파일을 지정하세요. 예: npm run db:sql sql/2026-08_crm.sql');
  process.exit(1);
}

// 경로 가드 — 저장소의 sql/ 안, .sql 확장자만.
const sqlDir = path.resolve(process.cwd(), 'sql');
const resolved = [];
for (const f of files) {
  const p = path.resolve(process.cwd(), f);
  if (!p.startsWith(sqlDir + path.sep) || !p.toLowerCase().endsWith('.sql')) {
    console.error(`sql/ 안의 .sql 파일만 실행할 수 있습니다: ${f}`);
    process.exit(1);
  }
  if (!fs.existsSync(p)) {
    console.error(`파일이 없습니다: ${f}`);
    process.exit(1);
  }
  resolved.push({ label: path.relative(process.cwd(), p).replace(/\\/g, '/'), path: p });
}

let sql = null;
let failed = false;

try {
  sql = postgres(url, { prepare: false, max: 1 });

  for (const { label, path: p } of resolved) {
    const body = fs.readFileSync(p, 'utf8');
    process.stdout.write(`\n▶ ${label} (${body.split('\n').length}줄) 실행 중…\n`);

    // .simple() — 파라미터 없는 다중 문장을 한 번에. 파일 하나 = 트랜잭션 하나.
    const results = await sql.unsafe(body).simple();

    // 파일 끝의 SELECT(점검 쿼리) 결과만 보여준다.
    const sets = (Array.isArray(results) ? results : [results]).filter(
      (r) => Array.isArray(r) && r.length,
    );
    if (!sets.length) {
      console.log('  ✅ 완료 (반환 결과 없음 — DDL/함수 정의)');
      continue;
    }
    console.log(`  ✅ 완료 · 결과 ${sets.length}세트`);
    for (const rows of sets) {
      console.table(rows.map((r) => ({ ...r })));
    }
  }
} catch (err) {
  failed = true;
  // err 객체를 통째로 넘기지 말 것 — input 속성에 접속 문자열이 들어 있다.
  console.error('\n❌ 실행 실패:', maskUrl(err?.message ?? err));
  if (err?.position) console.error('   위치(문자):', err.position);
  if (err?.hint) console.error('   힌트:', maskUrl(err.hint));
  console.error('   → 이 파일은 통째로 롤백됐습니다(암묵 트랜잭션).');
} finally {
  if (sql) await sql.end({ timeout: 5 });
}

process.exit(failed ? 1 : 0);
