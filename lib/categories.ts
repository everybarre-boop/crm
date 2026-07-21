import type { ComponentType } from 'react';
import Dashboard from '@/components/categories/Dashboard';
import Members from '@/components/categories/Members';
import MemberSummary from '@/components/categories/MemberSummary';
import Costs from '@/components/categories/Costs';
import BranchCosts from '@/components/categories/BranchCosts';
import Upload from '@/components/categories/Upload';

/* ======================================================================
   카테고리 레지스트리 (기존 admin.html 의 registerCategory 플러그인 구조 이식)
   ── 새 카테고리 추가법:
      1) components/categories/ 아래에 컴포넌트를 만들고
      2) 아래 CATEGORIES 배열에 { id, label, icon, Component } 를 추가하면 끝.
   ====================================================================== */
export type Category = {
  id: string;
  label: string;
  icon: string;
  Component: ComponentType;
};

export const CATEGORIES: Category[] = [
  { id: 'dashboard', label: '대시보드', icon: '📊', Component: Dashboard },
  { id: 'members', label: '회원 관리', icon: '👥', Component: Members },
  { id: 'summary', label: '회원별 집계', icon: '🧾', Component: MemberSummary },
  { id: 'costs', label: '비용 업로드', icon: '💰', Component: Costs },
  { id: 'branch-costs', label: '지점별 비용 집계', icon: '🏢', Component: BranchCosts },
  { id: 'upload', label: '데이터 업로드', icon: '⬆️', Component: Upload },
];
