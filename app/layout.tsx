import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '에블바레 관리자',
  description: '에블바레 회원 데이터 관리 도구',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
