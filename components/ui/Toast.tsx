'use client';

import { createContext, useCallback, useContext, useRef, useState } from 'react';

type ToastKind = '' | 'err';
type ToastState = { msg: string; kind: ToastKind; on: boolean };

const ToastContext = createContext<(msg: string, kind?: ToastKind) => void>(() => {});

export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<ToastState>({ msg: '', kind: '', on: false });
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const toast = useCallback((msg: string, kind: ToastKind = '') => {
    setState({ msg, kind, on: true });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setState((s) => ({ ...s, on: false })), 2600);
  }, []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      <div
        className={[
          'fixed bottom-6 left-1/2 z-[100] rounded-[10px] px-[18px] py-3 text-sm text-white',
          'transition-all duration-200 pointer-events-none',
          state.kind === 'err' ? 'bg-danger' : 'bg-sidebar',
          state.on ? 'opacity-100 -translate-x-1/2 -translate-y-1' : 'opacity-0 -translate-x-1/2',
        ].join(' ')}
        role="status"
      >
        {state.msg}
      </div>
    </ToastContext.Provider>
  );
}
