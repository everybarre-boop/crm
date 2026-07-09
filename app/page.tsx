'use client';

import { useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { sb } from '@/lib/supabase';
import { ToastProvider } from '@/components/ui/Toast';
import LoginScreen from '@/components/LoginScreen';
import AppShell from '@/components/AppShell';
import { spinner } from '@/components/ui/styles';

/* 인증 상태에 따라 로그인 화면 / 앱을 전환한다.
   실제 데이터 접근 통제는 화면이 아니라 Supabase RLS 가 한다. */
export default function Page() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    sb.auth.getSession().then(({ data }) => {
      if (!alive) return;
      setUser(data.session?.user ?? null);
      setReady(true);
    });
    const { data: sub } = sb.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
    });
    return () => {
      alive = false;
      sub.subscription.unsubscribe();
    };
  }, []);

  return (
    <ToastProvider>
      {!ready ? (
        <div className="flex min-h-screen items-center justify-center text-sm text-muted">
          <span className={spinner} />
        </div>
      ) : user ? (
        <AppShell user={user} />
      ) : (
        <LoginScreen />
      )}
    </ToastProvider>
  );
}
