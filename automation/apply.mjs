// ============================================================================
// Supabase 반영 — 관리자 로그인 후 apply_attendance RPC 호출
// ----------------------------------------------------------------------------
// service_role 키를 쓰지 않는다. 관리자 계정(ADMIN_EMAIL/PASSWORD)으로 로그인해
// 발급받은 JWT 로 RLS 안에서 동작한다. 복잡한 매칭·갱신은 DB의 apply_attendance RPC
// (SECURITY DEFINER, 내부에서 관리자 이메일 재검증)가 처리한다. sql/2026-07_apply_attendance.sql
// ============================================================================
import { createClient } from '@supabase/supabase-js';
import { env } from './config.mjs';

let _client = null;

export async function getAdminClient() {
  if (_client) return _client;
  const sb = createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await sb.auth.signInWithPassword({
    email: env.ADMIN_EMAIL,
    password: env.ADMIN_PASSWORD,
  });
  if (error) throw new Error(`관리자 로그인 실패: ${error.message}`);
  _client = sb;
  return sb;
}

// records: [{ 이름, 연락처, 수강권명, 전체횟수, 잔여횟수 }, ...]
export async function applyAttendance(records, { dryRun, branch }) {
  const sb = await getAdminClient();
  const { data, error } = await sb.rpc('apply_attendance', {
    records,
    dry_run: dryRun,
    branch,
  });
  if (error) throw new Error(`apply_attendance 실패(${branch}): ${error.message}`);
  return data; // { requested, matched, unmatched_count, dry_run, branch, unmatched }
}
