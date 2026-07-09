# 에블바레 회원 데이터 관리 도구

Next.js(App Router) + TypeScript + Tailwind CSS v4 로 만든 **정적 export** 관리자 앱.
로그인(Supabase Auth) 후 대시보드 · 회원 관리(검색/정렬/수정/삭제) · 엑셀/CSV 업로드를 제공한다.

서버는 없다. 빌드 결과(`out/`)를 그대로 정적 호스팅하며, 브라우저가 Supabase를 직접
호출한다. **회원 개인정보(PII) 보호는 오직 Supabase RLS 정책으로만** 이뤄진다 —
자세한 보안 규칙은 [CLAUDE.md](CLAUDE.md)를 반드시 읽을 것.

## 실행

```bash
npm install       # 최초 1회
npm run dev       # 개발 서버 → http://localhost:3000
npm run build     # 정적 export → out/ 생성
```

`out/` 폴더를 Vercel / Netlify / GitHub Pages 등 아무 정적 호스팅에 올리면 배포 끝.

## 환경 변수 (선택)

anon 키는 공개 키이며 [lib/supabase.ts](lib/supabase.ts)에 기본값이 들어 있어
설정 없이도 동작한다. 다른 Supabase 프로젝트로 바꿀 때만 `.env.local.example`을
`.env.local`로 복사해 값을 채운다.

## 구조

```
app/            layout · page(인증 오케스트레이션) · globals.css
components/     LoginScreen · AppShell(사이드바) · ui/ · categories/(화면들)
lib/            supabase(클라이언트) · members(스키마/상수/유틸) · categories(레지스트리)
```

새 화면은 `components/categories/`에 컴포넌트를 만들고 `lib/categories.ts`의
`CATEGORIES` 배열에 등록한다.
