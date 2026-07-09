/* 기존 admin.html 의 버튼/입력 스타일을 Tailwind 유틸리티 문자열로 이식.
   컴포넌트 여러 곳에서 재사용한다. */

const base = 'rounded-[10px] font-semibold cursor-pointer disabled:cursor-not-allowed transition-colors';
const sizeMd = 'px-[18px] py-[11px] text-sm';
const sizeSm = 'px-3 py-[7px] text-[13px]';

export const btn = {
  primary: `${base} ${sizeMd} border-none bg-primary text-white disabled:bg-[#b9c2e9]`,
  primaryAuto: `${base} ${sizeMd} border-none bg-primary text-white disabled:bg-[#b9c2e9]`,
  ghost: `${base} ${sizeMd} bg-transparent border border-border text-text hover:bg-[#f1f3f7]`,
  ghostSm: `${base} ${sizeSm} bg-transparent border border-border text-text hover:bg-[#f1f3f7] disabled:opacity-50`,
  danger: `${base} ${sizeMd} border-none bg-danger text-white`,
  dangerGhostSm: `${base} ${sizeSm} bg-transparent border border-danger text-danger hover:bg-danger-soft`,
};

export const input =
  'w-full rounded-[10px] border border-border px-3 py-[11px] text-sm outline-none focus:border-primary disabled:bg-[#f7f8fa] disabled:text-muted';

export const card = 'mb-[18px] rounded-[14px] border border-border bg-card p-[22px]';

export const spinner =
  'inline-block h-4 w-4 -mb-[3px] animate-spin rounded-full border-2 border-[#d3d8e2] border-t-primary';
