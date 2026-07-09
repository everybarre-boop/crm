'use client';

import { useEffect, useState } from 'react';
import type { User } from '@supabase/supabase-js';
import { sb } from '@/lib/supabase';
import { CATEGORIES } from '@/lib/categories';

/* 사이드바 + 라우팅된 본문. location.hash 로 카테고리를 전환한다(기존 동작 유지). */
export default function AppShell({ user }: { user: User }) {
  const [activeId, setActiveId] = useState<string>(CATEGORIES[0].id);

  useEffect(() => {
    const fromHash = () => {
      const id = location.hash.slice(1);
      setActiveId(CATEGORIES.some((c) => c.id === id) ? id : CATEGORIES[0].id);
    };
    fromHash();
    window.addEventListener('hashchange', fromHash);
    return () => window.removeEventListener('hashchange', fromHash);
  }, []);

  const active = CATEGORIES.find((c) => c.id === activeId) ?? CATEGORIES[0];
  const ActiveComponent = active.Component;

  return (
    <div className="grid min-h-screen grid-cols-[240px_1fr] max-[720px]:grid-cols-1">
      <aside className="flex flex-col gap-1 bg-sidebar px-[14px] py-[22px] text-white max-[720px]:flex-row max-[720px]:overflow-x-auto max-[720px]:p-[10px]">
        <div className="px-[10px] pb-[18px] pt-[6px] max-[720px]:hidden">
          <div className="text-[17px] font-bold">에블바레</div>
          <div className="mt-[2px] text-xs text-sidebar-muted">관리자 콘솔</div>
        </div>

        <nav className="contents">
          {CATEGORIES.map((c) => (
            <button
              key={c.id}
              onClick={() => {
                location.hash = c.id;
              }}
              className={[
                'flex w-full items-center gap-[10px] rounded-[10px] border-none px-3 py-[11px] text-left text-sm font-medium',
                c.id === active.id
                  ? 'bg-primary text-white'
                  : 'bg-transparent text-sidebar-muted hover:bg-white/[0.06] hover:text-white',
              ].join(' ')}
            >
              <span className="w-5 text-center text-base">{c.icon}</span> {c.label}
            </button>
          ))}
        </nav>

        <div className="flex-1 max-[720px]:hidden" />
        <div className="mt-2 truncate border-t border-white/[0.08] px-3 py-2 text-xs text-sidebar-muted max-[720px]:hidden">
          {user.email}
        </div>
        <button
          onClick={() => sb.auth.signOut()}
          className="flex w-full items-center gap-[10px] rounded-[10px] border-none bg-transparent px-3 py-[11px] text-left text-sm font-medium text-sidebar-muted hover:bg-white/[0.06] hover:text-white"
        >
          <span className="w-5 text-center text-base">↩</span> 로그아웃
        </button>
      </aside>

      <main className="overflow-auto px-9 py-8 max-[720px]:px-4 max-[720px]:py-5">
        <ActiveComponent />
      </main>
    </div>
  );
}
