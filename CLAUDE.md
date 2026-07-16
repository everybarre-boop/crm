# CLAUDE.md

에블바레 회원 데이터 관리 도구. 이 파일은 Claude Code(및 개발자)가 이 저장소에서
작업할 때 반드시 지켜야 할 규칙과 배경을 정리한 문서다.

**스택:** Next.js(App Router) + TypeScript + Tailwind CSS v4.
`next.config.mjs`의 `output: 'export'`로 **정적 사이트(`out/`)를 빌드**한다.
서버는 없고 빌드 결과물을 그대로 정적 호스팅한다. 보안 모델은 마이그레이션
전(단일 admin.html)과 **완전히 동일**하다 — 브라우저가 Supabase를 직접 호출한다.

## 🔐 보안 — 가장 먼저 읽을 것

이 프로젝트는 **정적으로 빌드된 클라이언트가 브라우저에서 Supabase DB를 직접 호출**하는
구조다. 서버가 없으므로 **개인정보(PII) 보호는 오직 Supabase RLS(Row Level Security)
정책으로만** 이뤄진다. 아래 원칙을 절대 어기지 말 것.

- **`output: 'export'`(정적 export)를 유지할 것.** 서버 컴포넌트/서버 액션/Route
  Handler로 백엔드를 만드는 순간 배포·보안 모델이 통째로 바뀐다. 서버 도입은
  독립적인 큰 결정이므로, 임의로 서버 경로(특히 service_role 키를 쓰는 코드)를
  추가하지 말 것.
- **`SUPABASE_ANON_KEY`는 비밀이 아니다.** 정적 번들에 그대로 인라인되고 git에도
  커밋된다([lib/supabase.ts](lib/supabase.ts)의 기본값). 설계상 공개되는 키이므로
  숨기려 하지 말 것. (숨겨봐야 브라우저에서 그대로 보인다.) `service_role` 키는
  **절대** 이 저장소/클라이언트에 넣지 말 것.
- **데이터를 지키는 유일한 방어선은 RLS다.** `members` 테이블 정책은 반드시
  `to authenticated` + **관리자 이메일 화이트리스트**로 제한한다.
  `anon` 역할에 `select`/`insert`/`update`/`delete` 를 열어두면
  **로그인 없이 공개 키만으로 전 회원 PII가 노출된다.** (과거 실제로 이 상태였음.)
- **로그인 화면은 데이터를 지키지 못한다.** [components/LoginScreen.tsx](components/LoginScreen.tsx)의
  로그인은 화면 전환용 UI일 뿐, 실제 접근 통제는 RLS가 한다. 인증을 우회하거나
  RLS를 우회하는 코드를 절대 추가하지 말 것.
- **anon 권한으로 동작하는 무인증(no-login) 경로를 다시 만들지 말 것.**
  (과거 `upload.html`이 그런 경로였고, 그래서 폐기했다. 업로드는 로그인 후
  admin의 "데이터 업로드" 탭에서만 한다.)
- **PII 원본 파일(`*.xlsx`, `*.xls`, `*.csv`)은 절대 커밋·외부 전송 금지.**
  `.gitignore`로 차단돼 있다. 이 규칙을 무력화하지 말 것.
  (작업 폴더가 OneDrive에 동기화되고 있으니 원본 엑셀 취급에 특히 주의.)

### 권장 RLS 정책 (Supabase SQL Editor)

```sql
alter table public.members enable row level security;

create policy "admins_full_access"
on public.members
for all
to authenticated
using      ( (auth.jwt() ->> 'email') = any (array['basegolf.official@gmail.com']) )
with check ( (auth.jwt() ->> 'email') = any (array['basegolf.official@gmail.com']) );
```

추가로 Supabase → Authentication → **Enable Signups 끄기**(공개 가입 차단),
관리자 계정은 대시보드에서 직접 생성.

## 실행 / 빌드

```bash
npm install       # 최초 1회
npm run dev       # 로컬 개발 서버 (http://localhost:3000)
npm run build     # 정적 export → out/ 생성. 이 폴더를 그대로 정적 호스팅한다.
```

배포는 `out/`을 Vercel/Netlify/GitHub Pages 등 아무 정적 호스팅에 올리면 된다
(서버 불필요). 다른 Supabase 프로젝트로 바꿀 때만 `.env.local`에
`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY`를 넣어 덮어쓴다.

## Drizzle — ⚠️ 마이그레이션/스키마 관리 "개발 도구 전용"

DB 스키마·마이그레이션은 Drizzle(drizzle-kit)로 관리한다. **런타임 데이터 접근은
아니다.** 브라우저 앱은 여전히 `@supabase/supabase-js`(PostgREST + RLS)로만 DB에
접근한다. 이유는 위 보안 원칙과 동일하다 — 정적 export 앱에는 서버가 없고, Drizzle의
직접 Postgres 연결은 브라우저에서 불가능할뿐더러 **RLS를 우회**하기 때문이다.

- `drizzle-orm` / `drizzle-kit` / `postgres`는 **`devDependencies`에만** 둔다.
  런타임 코드(`app/`, `components/`, `lib/*` 중 supabase.ts 계열)에서 **import 금지** —
  클라이언트 번들에 들어가면 안 된다.
- Drizzle가 쓰는 **`DATABASE_URL`(전권 접속 문자열)은 비밀값**이다. `.env.local`에만
  두고(`.gitignore`로 차단됨) **절대 커밋·클라이언트 사용 금지.** `service_role` 키와
  같은 급의 비밀로 취급할 것. **주의: 이 작업 폴더는 OneDrive 로 동기화되므로**,
  `.env.local`을 여기 두면 DB 전권 비밀번호가 클라우드로 동기화된다(RLS 우회 자격증명 유출).
  가능하면 `.env.local`을 동기화 밖 경로에 두고 [drizzle.config.ts](drizzle.config.ts)의
  `config({ path })`를 그 경로로 가리키게 할 것. (`.gitignore`는 커밋만 막지 동기화는 못 막는다.)
- 접속 문자열은 Supabase → Connect → **Session pooler**(`aws-*.pooler.supabase.com`)를 쓴다.
  직접 연결(`db.<ref>.supabase.co`)은 IPv6 전용이라 대부분의 IPv4 환경에서 DNS 가 안 잡힌다.
- 스키마 정의: [lib/db/schema.ts](lib/db/schema.ts). 설정: [drizzle.config.ts](drizzle.config.ts)
  (관리 대상은 `public.members`로 한정). 생성 마이그레이션은 `drizzle/`에 커밋한다.
- **`dedup_key` 현황:** 위 "데이터 모델"은 `dedup_key` 불변식을 전제하지만, **실제 운영 DB와
  현재 스키마([lib/db/schema.ts](lib/db/schema.ts))에는 `dedup_key` 컬럼/유니크 인덱스가 없다.**
  그래서 업로드의 `onConflict:'dedup_key'` 는 지금 동작하지 않는다(중복 정리 데이터 마이그레이션
  보류 중). 이 불일치를 해소(컬럼+유니크 추가+기존 중복 정리)하기 전까지 스키마에 임의로
  `dedup_key`를 되살리지 말 것 — 실제 DB와 어긋나 허위 diff/파괴적 마이그레이션이 생긴다.
- **운영 DB 대상 `db:push`는 검토 없이 실행 금지.** 손으로 쓴 스키마가 실제 DB 타입과
  다를 수 있으니, 먼저 `npm run db:pull`로 실제 스키마를 뽑아 대조한 뒤 맞춘다.
- **`drizzle/0000_*.sql` 은 기존 DB 를 인트로스펙션한 "베이스라인"이라 전체가 주석 처리돼 있다.**
  이미 존재하는 운영 DB 에는 적용할 게 없다(테이블이 이미 있음). **빈 새 프로젝트**에
  `db:migrate` 로 스키마를 재현하려면 이 파일의 주석(`/* */`)을 풀고 실행해야 한다.

```bash
npm run db:pull      # 실제 Supabase DB → 스키마 인트로스펙션 (대조용)
npm run db:generate  # schema.ts 변경분 → drizzle/ 에 SQL 마이그레이션 생성
npm run db:migrate   # 생성된 마이그레이션을 DB에 적용 (0000 베이스라인은 위 설명 참고)
npm run db:studio    # 로컬 GUI (drizzle studio)
```

## 구조

- [app/page.tsx](app/page.tsx) — 인증 상태에 따라 로그인/앱 전환(전부 클라이언트).
  실제 접근 통제는 화면이 아니라 RLS가 한다.
- [components/AppShell.tsx](components/AppShell.tsx) — 사이드바 + `location.hash` 라우팅.
- [components/categories/](components/categories/) — 대시보드/회원 관리/업로드 화면.
  카테고리 등록은 [lib/categories.ts](lib/categories.ts)의 `CATEGORIES` 배열
  (`{ id, label, icon, Component }`)로 하는 플러그인 구조.
- [lib/members.ts](lib/members.ts) — `COLUMNS`/`KEY_COLS`/`makeKey` 등 스키마·상수.
  [lib/supabase.ts](lib/supabase.ts) — Supabase 클라이언트(공개 anon 키 포함).
- vendor 스크립트 없음. `@supabase/supabase-js`, `xlsx`는 npm 의존성으로 번들된다.
- 백엔드 없음. Next.js가 정적 파일로 빌드한다(`output: 'export'`).

## 데이터 모델

- 테이블: `public.members`. 엑셀 헤더명이 곧 DB 컬럼명이다(한글 컬럼).
  컬럼 목록은 [lib/members.ts](lib/members.ts)의 `COLUMNS` 배열이 기준.
- **`dedup_key` 불변식(중요):** upsert 충돌 판단용 고유 키.
  `KEY_COLS`를 `String.fromCharCode(31)`(Unit Separator)로 이어붙여 만든다
  (`makeKey`). 업로드 upsert(`onConflict: 'dedup_key'`)와 수정/삭제(`eq('dedup_key', …)`)가
  모두 이 값에 의존한다.
  - `KEY_COLS`를 바꾸면 **DB의 unique 인덱스 기준도 함께** 바꿔야 한다.
  - 잔여/예약가능/취소가능 횟수 등 "변하는 값"은 `KEY_COLS`에 넣지 말 것
    (넣으면 재업로드 때 같은 회원이 새 행으로 중복 생성된다).

## 코딩 규칙

- 화면 렌더는 JSX가 기본으로 이스케이프하므로 `dangerouslySetInnerHTML`을 쓰지 말 것.
  (부득이 써야 하면 반드시 직접 이스케이프한다. XSS 방지.)
- 사용자 입력을 PostgREST 필터(`.or()` 등)에 넣을 때는 필터 구문 특수문자를 제거한다.
  [lib/members.ts](lib/members.ts)의 `sanitizeSearchTerm()`를 쓸 것. 검색 로직 참고:
  [components/categories/Members.tsx](components/categories/Members.tsx)의 `load()`.
- 화면 상태(로그인/앱, 카테고리 전환)는 React 상태·`location.hash`로 관리한다.
- 새 화면은 [components/categories/](components/categories/)에 컴포넌트를 만들고
  [lib/categories.ts](lib/categories.ts)의 `CATEGORIES` 배열에 등록한다.
- 클라이언트에서 상호작용하는 컴포넌트는 파일 맨 위에 `'use client'`를 둔다.
