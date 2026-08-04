'use client';

import { useState } from 'react';
import { sb } from '@/lib/supabase';
import { btn, input } from '@/components/ui/styles';

/* 관리자 이메일은 고정. 화면에는 비밀번호 한 칸만 노출하고, 로그인 시
   내부적으로 이 이메일 + 입력된 비밀번호로 Supabase 인증을 수행한다.
   ⚠️ RLS(members 테이블 정책)의 관리자 화이트리스트와 반드시 동일해야 한다. */
const ADMIN_EMAIL = 'basegolf.official@gmail.com';

/* 인증 실패 원인을 "사용자가 조치할 수 있는 문구"로 번역한다.
   ⚠️ 서버에 닿지 못한 것과 비밀번호가 틀린 것은 완전히 다른 문제인데,
   Supabase 원본 메시지를 그대로 보여주면 둘 다 "로그인 실패"로만 보인다.
   (무료 플랜 프로젝트가 자동 일시정지돼 호스트가 사라졌을 때 실제로
   비밀번호 오류로 오해한 적이 있다.) */
function describeAuthError(err: { name?: string; status?: number; message?: string }): string {
  const msg = err.message ?? '';
  if (typeof navigator !== 'undefined' && navigator.onLine === false)
    return '인터넷에 연결돼 있지 않습니다. 네트워크를 확인한 뒤 다시 시도하세요.';
  // fetch 자체가 실패하면 status 가 없거나 0 이다(supabase-js: AuthRetryableFetchError).
  if (err.name === 'AuthRetryableFetchError' || !err.status || /fetch|network|load failed/i.test(msg))
    return '서버에 연결할 수 없습니다 — 비밀번호 문제가 아닙니다. Supabase 프로젝트가 일시정지(paused)됐는지 대시보드에서 확인하고 Resume 하세요.';
  if (/invalid login credentials/i.test(msg)) return '비밀번호가 올바르지 않습니다.';
  if (/email not confirmed/i.test(msg))
    return '관리자 계정이 아직 확인되지 않았습니다. Supabase 대시보드 → Authentication → Users 에서 확인 처리하세요.';
  if (err.status === 429 || /rate limit/i.test(msg))
    return '시도가 너무 잦습니다. 잠시 후 다시 시도하세요.';
  return '로그인 실패: ' + msg;
}

/* 로그인 화면.
   ⚠️ 이 화면은 데이터를 지키지 못한다 — 화면 전환용 UI일 뿐이다.
   실제 접근 통제는 Supabase RLS(members 테이블 정책)가 한다.
   비밀번호만 입력받지만, 내부적으로는 여전히 Supabase 인증(authenticated)을
   거치므로 RLS 보호가 그대로 유지된다. */
export default function LoginScreen() {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { error } = await sb.auth.signInWithPassword({ email: ADMIN_EMAIL, password });
    setBusy(false);
    // 성공 시 onAuthStateChange 리스너(page.tsx)가 화면을 전환한다.
    if (error) setError(describeAuthError(error));
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-[380px] rounded-2xl border border-border bg-card p-8">
        <h1 className="m-0 mb-1 text-[22px]">에블바레 관리자</h1>
        <p className="m-0 mb-6 text-[13px] text-muted">비밀번호를 입력하세요.</p>
        <form onSubmit={onSubmit}>
          {/* 이메일은 ADMIN_EMAIL로 고정. autoComplete용 숨김 필드만 유지. */}
          <input type="email" autoComplete="username" value={ADMIN_EMAIL} readOnly hidden />
          <div className="mb-[14px]">
            <label className="mb-[6px] block text-[13px] font-semibold" htmlFor="password">
              비밀번호
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              className={input}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          <button type="submit" className={btn.primary} disabled={busy}>
            {busy ? '로그인 중…' : '로그인'}
          </button>
          {error && <div className="mt-3 min-h-[18px] text-[13px] text-danger">{error}</div>}
        </form>
      </div>
    </div>
  );
}
