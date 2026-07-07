# CLAUDE.md

에블바레 회원 데이터 관리 도구. 이 파일은 Claude Code(및 개발자)가 이 저장소에서
작업할 때 반드시 지켜야 할 규칙과 배경을 정리한 문서다.

## 🔐 보안 — 가장 먼저 읽을 것

이 프로젝트는 **정적 HTML이 브라우저에서 Supabase DB를 직접 호출**하는 구조다.
서버가 없으므로 **개인정보(PII) 보호는 오직 Supabase RLS(Row Level Security) 정책으로만**
이뤄진다. 아래 원칙을 절대 어기지 말 것.

- **`SUPABASE_ANON_KEY`는 비밀이 아니다.** HTML에 그대로 박히고 git에도 커밋된다.
  설계상 공개되는 키이므로 이걸 숨기려 하지 말 것. (숨겨봐야 브라우저에서 그대로 보인다.)
- **데이터를 지키는 유일한 방어선은 RLS다.** `members` 테이블 정책은 반드시
  `to authenticated` + **관리자 이메일 화이트리스트**로 제한한다.
  `anon` 역할에 `select`/`insert`/`update`/`delete` 를 열어두면
  **로그인 없이 공개 키만으로 전 회원 PII가 노출된다.** (과거 실제로 이 상태였음.)
- **로그인 화면은 데이터를 지키지 못한다.** [admin.html](admin.html)의 로그인은
  화면 전환용 UI일 뿐, 실제 접근 통제는 RLS가 한다. 인증을 우회하거나
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

## 구조

- [admin.html](admin.html) — **유일한 앱.** 로그인(Supabase Auth) 후
  대시보드/회원 관리(검색·정렬·수정·삭제)/데이터 업로드를 모두 제공한다.
  카테고리는 `registerCategory({ id, label, icon, render })`로 추가하는 플러그인 구조.
- `supabase.min.js`, `xlsx.full.min.js` — CDN 없이 로컬에 둔 vendor 스크립트.
- 백엔드 없음. 빌드/번들러/패키지 매니저 없음. 파일을 브라우저로 열면 끝.

## 데이터 모델

- 테이블: `public.members`. 엑셀 헤더명이 곧 DB 컬럼명이다(한글 컬럼).
  컬럼 목록은 [admin.html](admin.html)의 `COLUMNS` 배열이 기준.
- **`dedup_key` 불변식(중요):** upsert 충돌 판단용 고유 키.
  `KEY_COLS`를 `String.fromCharCode(31)`(Unit Separator)로 이어붙여 만든다
  (`makeKey`). 업로드 upsert(`onConflict: 'dedup_key'`)와 수정/삭제(`eq('dedup_key', …)`)가
  모두 이 값에 의존한다.
  - `KEY_COLS`를 바꾸면 **DB의 unique 인덱스 기준도 함께** 바꿔야 한다.
  - 잔여/예약가능/취소가능 횟수 등 "변하는 값"은 `KEY_COLS`에 넣지 말 것
    (넣으면 재업로드 때 같은 회원이 새 행으로 중복 생성된다).

## 코딩 규칙

- 화면에 값을 넣을 때는 항상 `escapeHtml()`로 이스케이프한다 (XSS 방지).
- 사용자 입력을 PostgREST 필터(`.or()` 등)에 넣을 때는 필터 구문 특수문자를
  제거한다. 검색 로직 참고: [admin.html](admin.html)의 `members` 카테고리 `load()`.
- 의존성 추가 금지(번들러가 없다). vendor 스크립트는 로컬 파일로만.
- 새 화면은 새 파일이 아니라 `registerCategory`로 admin 안에 추가한다.
