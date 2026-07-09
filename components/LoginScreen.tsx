'use client';

import { useState } from 'react';
import { sb } from '@/lib/supabase';
import { btn, input } from '@/components/ui/styles';

/* 로그인 화면.
   ⚠️ 이 화면은 데이터를 지키지 못한다 — 화면 전환용 UI일 뿐이다.
   실제 접근 통제는 Supabase RLS(members 테이블 정책)가 한다. */
export default function LoginScreen() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { error } = await sb.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    // 성공 시 onAuthStateChange 리스너(page.tsx)가 화면을 전환한다.
    if (error) setError('로그인 실패: ' + error.message);
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-[380px] rounded-2xl border border-border bg-card p-8">
        <h1 className="m-0 mb-1 text-[22px]">에블바레 관리자</h1>
        <p className="m-0 mb-6 text-[13px] text-muted">관리자 계정으로 로그인하세요.</p>
        <form onSubmit={onSubmit}>
          <div className="mb-[14px]">
            <label className="mb-[6px] block text-[13px] font-semibold" htmlFor="email">
              이메일
            </label>
            <input
              id="email"
              type="email"
              autoComplete="username"
              required
              className={input}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
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
