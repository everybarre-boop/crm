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
  가능하면 `.env.local`을 동기화 밖 경로에 두고 **`DOTENV_PATH` 환경변수**로 그 경로를
  가리킬 것 — [drizzle.config.ts](drizzle.config.ts)와
  [scripts/backup-table.mjs](scripts/backup-table.mjs) 둘 다 `DOTENV_PATH`를 먼저 보고,
  없을 때만 `.env.local`로 폴백한다(코드 수정 불필요).
  (`.gitignore`는 커밋만 막지 동기화는 못 막는다.)
- 접속 문자열은 Supabase → Connect → **Session pooler**(`aws-*.pooler.supabase.com`)를 쓴다.
  직접 연결(`db.<ref>.supabase.co`)은 IPv6 전용이라 대부분의 IPv4 환경에서 DNS 가 안 잡힌다.
- 스키마 정의: [lib/db/schema.ts](lib/db/schema.ts). 설정: [drizzle.config.ts](drizzle.config.ts)
  (관리 대상은 `public.members`로 한정). 생성 마이그레이션은 `drizzle/`에 커밋한다.
- **`dedup_key` 현황:** `members`·`sales` 둘 다 `dedup_key` + 유니크 제약이 실재하며 upsert
  덮어쓰기가 정상 동작한다. `schema.ts`의 `dedupKey` 정의(양 테이블)는 실제 DB 상태와 일치한다.
  - ✅ **2026-08 KEY_COLS 개정분은 DB 에 이미 반영돼 있다.** 2026-08-05 실측으로
    `members` 17,617행 · `sales` 17,602행 **전부 새 공식과 일치**(어긋난 행 0, 새 키 충돌 0).
    2026-08-04 초기화 + 전 지점 재업로드가 새 키로 들어갔기 때문이다.
  - 키를 **또** 바꾸거나, 옛 키가 섞인 백업을 복원했거나, verify 결과가 0이 아닐 때는
    [sql/2026-08_rekey_dedup_keys.sql](sql/2026-08_rekey_dedup_keys.sql)로 맞춘다
    (점검 → 어긋난 행만 재키잉 → 중복 정리 → 유니크 인덱스 복구. 한 트랜잭션이고,
    정리 대상이 5%를 넘으면 공식이 틀린 것으로 보고 스스로 중단한다).
    단, 재키잉은 **옛 키가 이미 합쳐 버린 행을 되살리지 못한다** — 그건 원본 엑셀 재업로드뿐이다.
  - ⛔️ [sql/2026-07_dedup_members.sql](sql/2026-07_dedup_members.sql)은 **폐기**됐다(옛 공식).
    실행하면 같은 사람의 재등록 행을 전부 삭제한다. 본문은 주석 처리해 뒀다.
- **새 스키마/컬럼은 [sql/](sql/) 의 손수 작성 SQL로 반영한다.** 서버 없는 정적 앱이라
  Supabase SQL Editor 직접 실행이 가장 단순하다. `schema.ts`는 짝을 맞춰 갱신해 두되(향후
  `db:pull` 대조 기준), 운영 반영은 그 SQL을 쓴다. `members.used_count`(생성 컬럼)와 `sales`가
  이 방식으로 추가됐다.
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
npm run db:backup            # sales 테이블 → CSV 덤프
npm run db:backup members    # 다른 테이블 (여러 개 나열 가능)
```

**`db:backup` — 되돌리기 어려운 SQL 전에 반드시 실행할 것.** Supabase 무료 플랜에는
대시보드 자동 백업(Database → Backups)이 없다. [scripts/backup-table.mjs](scripts/backup-table.mjs)가
`DATABASE_URL` 로 직접 붙어 CSV 를 뜬다(Drizzle 과 같은 "개발 도구 전용" 경로 — 클라이언트
번들과 무관). 결과 CSV 는 회원 PII 이므로 기본 저장 위치를 **OneDrive 동기화 밖**
(`%LOCALAPPDATA%\evble-backup`)으로 뒀다. `BACKUP_DIR` 로 바꿀 수 있지만 프로젝트 폴더에는
두지 말 것 — `.gitignore` 는 커밋만 막지 동기화는 못 막는다. **이건 이제 스크립트가 직접
막는다**: 저장 경로가 프로젝트 폴더 안이거나 경로에 `OneDrive` 가 들어가면 DB 에 붙기 전에
중단한다(`BACKUP_DIR=public` 으로 `out/` 에 실려 공개 배포되는 사고도 같이 막힌다).
CSV 는 Excel 열람을 전제하므로 `=` `+` `-` `@` 로 시작하는 셀 값 앞에 `'` 를 붙여
**수식 실행(CSV 인젝션)을 차단**한다 — 회원이 이름·메모란에 넣은 `=HYPERLINK(...)` 가
관리자 Excel 에서 실행되면 옆 셀의 실명·연락처가 외부로 나간다. 순수 숫자(음수 포함)는
그대로 둬서 값이 변형되지 않는다.

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

- 테이블: `public.members`(회원+수강권), `public.sales`(매출/결제). 둘 다 엑셀 헤더명이
  곧 DB 컬럼명이다(한글 컬럼). 회원 컬럼은 [lib/members.ts](lib/members.ts)의 `COLUMNS`,
  매출 컬럼은 [lib/sales.ts](lib/sales.ts)의 `SALES_COLUMNS`가 기준.
- **회원/매출 분리 업로드:** 업로드 화면은 회원 엑셀 **한 장**을 받아 컬럼만 나눈다 —
  회원 정보는 `members`, 결제 컬럼(`결제구분/결제금액/결제일시/결제방법/할부개월수`+식별정보)은
  `sales`로 각각 upsert. 저장 대상은 체크박스로 켜고 끌 수 있다(특정 대상만 저장 가능).
  회원 파일 자체에 결제 컬럼이 함께 들어 있으므로 `members`도 결제 컬럼을 계속 보관한다
  (대시보드 결제 합계 등 기존 동작 유지). `sales`는 그 결제 내역의 **분리된 사본**이다.
- **`dedup_key` 불변식(중요) = 중복 판정 기준:** upsert 충돌 판단용 고유 키.
  키 컬럼들을 `String.fromCharCode(31)`(Unit Separator)로 이어붙여 만든다
  (`makeKey(rec, keyCols)`, NULL→''). 업로드 upsert(`onConflict: 'dedup_key'`)와
  수정/삭제(`eq('dedup_key', …)`)가 모두 이 값에 의존한다.
  - **`members` 키(`KEY_COLS`) = `이름 · 연락처 · 수강권명 · 수강권시작일 · 결제구분 ·
    결제금액 · 결제일시 · 결제방법 · 할부개월수`** = "수강권 등록건 1건". 이게 모두 같아야
    같은 데이터로 보고 덮어쓴다.
    - 🔥 **2026-08 개정 — 이전 키(`…·등록일·전체횟수`)는 사용횟수를 48% 누락시켰다.**
      파일에 `등록일`이 없어 그 자리가 항상 빈 값이라 **같은 사람이 같은 수강권을 재등록한
      건이 전부 1건으로 뭉개졌다**(이가원: 엑셀 55행 632회 → DB 23행 173회 / 전체
      124,839회 → 65,201회). 새 키로는 17,641행 중 17,617행이 살아남는다(124,802회).
    - **키에 "변하는 값"을 넣지 말 것** — 넣으면 upsert 가 덮어쓰기가 아니라 새 행 추가가
      되어 중복이 쌓인다. 금지: 잔여/예약가능/취소가능 횟수(매일 변함), `전체횟수`(횟수
      조정으로 변함), `수강권종료일`(연장·홀드로 변함), `등록일`(파일에 없어 빈 값).
  - `sales` 키(`SALES_KEY_COLS`)는 결제 1건을 식별하는 필드 집합(이름·연락처·수강권명·
    결제구분/금액/일시/방법/할부). **생년월일은 2026-08 에 키에서 뺐다** — 예약사이트
    내보내기마다 이 컬럼이 있다 없다 해서, 빠진 파일을 올리면 같은 결제가 키 불일치로
    새 행이 됐다.
  - 🔥 **키 컬럼 구성이 바뀌면 dedup_key 가 통째로 달라져 "전량 중복"이 된다.** 실제로 두 번
    겪었다. 원인은 둘 다 같다 — **DB 에 쌓인 값과 새 업로드가 만드는 값이 어긋난 것.**
    - 2026-08: `전화번호 → 연락처` 헤더 별칭(커밋 `dfc130d`)을 추가했더니, 별칭 이전에
      업로드된 DB 는 `연락처`가 **전 행 비어 있는데**(members 11,914 / sales 17,197 행 모두)
      새 업로드는 연락처를 채워 넣어 키가 전부 달라졌다 → **전량 중복 직전.**
      해결: [sql/2026-07_reset_all_data.sql](sql/2026-07_reset_all_data.sql) 로 초기화 후
      전 지점 엑셀 재업로드(2026-08-04). 엑셀이 원본이고 DB 는 그 파생물이라 이게 가장 깨끗하다.
    - 같은 이유로 `등록일`도 위험하다. 2026-07-21 이후 내보내기에는 `등록일`이 **없어서**
      DB 전 행이 빈 값이다. 지금 `등록일`이 든 파일을 올리면 회원 전체가 중복된다.
    - **그래서: 업로드 전에 (1) 이전 파일과 헤더를 대조하고, (2) 키 컬럼이 DB 에서 실제로
      채워져 있는지 확인할 것.** 확인 쿼리는 [sql/2026-07_verify_dedup.sql](sql/2026-07_verify_dedup.sql).
      되돌리기 어려운 작업 전에는 `npm run db:backup` 으로 먼저 덤프를 뜬다.
  - `KEY_COLS`/`SALES_KEY_COLS`를 바꾸면 **DB의 unique 인덱스 기준과 백필 SQL 공식도 함께**
    바꿔야 한다(코드↔DB 공식 불일치 시 중복이 다시 생긴다).
  - **"변하는 값"의 기준은 "재업로드 때 값이 달라지는가"다.** 잔여/예약가능/취소가능 횟수,
    `전체횟수`, `수강권종료일`은 매 내보내기마다 달라지므로 키에 넣으면 안 된다.
    반대로 `결제금액`·`결제일시`·`결제방법`·`할부개월수`는 **결제 시점에 확정되고 이후 안 변하므로
    키에 들어간다**(2026-08 개정). 이 둘을 헷갈리지 말 것 — 결제 컬럼이 키에 있어야
    "같은 수강권 재등록"이 별개 행으로 남는다.
  - ✅ **`members`·`sales` 모두 실제 `dedup_key` 유니크 제약이 있다.**
    현재 공식 확인은 [sql/2026-07_verify_dedup.sql](sql/2026-07_verify_dedup.sql),
    재백필은 [sql/2026-08_rekey_dedup_keys.sql](sql/2026-08_rekey_dedup_keys.sql).
- **동일인 판정 = 이름 + 연락처(숫자만).** 지점은 수강권명 안에 있을 뿐 사람을 나누지
  않는다 — **판교 이가원 · 반포 이가원은 한 사람이고, 사용횟수는 전 지점 합산이다.**
  [lib/members.ts](lib/members.ts)의 `makePersonResolver(...rowSets)`를 쓸 것(`personKey`는
  행 하나짜리 저수준 함수). resolver 는 전체 행을 먼저 훑어 **연락처가 빈 행**(실측 385행)을
  그 이름의 연락처가 **유일할 때만** 붙인다. 이름만으로 합치면 안 된다 — '김민정'처럼 서로
  다른 연락처가 24개인 동명이인이 실재한다.
  - **연락처가 비었고 그 이름에 연락처가 여럿이면(동명이인) 행마다 따로 센다.** 예전엔 이런
    행을 전부 `이름+''` 하나로 보내서 **서로 다른 사람이 한 명으로 뭉쳤다**(연락처 없는
    '김민정' 5행 × 30회 = 가짜 1명 150회 → "100회 이상" 필터에 오검출, 총회원은 5명이 1명).
    구분 기준은 `dedup_key`라, **집계용 select 에는 `dedup_key`를 포함시킬 것**
    (없으면 조회 안에서만 유효한 일련번호로 대체된다).
  - 지점별 인원을 더해서 전체 인원을 내지 말 것 — 다지점 회원이 중복 계수된다.
    합계는 전 행을 한 번에 `new Set(rows.map(keyOf)).size` 로 센다(대시보드 합계 행 참고).
- **`등록일`은 전 행이 비어 있다**(내보내기에 컬럼이 없음). 기간 집계는 `regDate(rec)`
  (`등록일` 없으면 `수강권시작일`)를 쓸 것. 대시보드 신규/체험 집계가 이것 때문에 0이었다.
- **`used_count`(사용횟수) 컬럼:** `members.used_count` = `전체횟수 − 잔여횟수`인 STORED
  생성 컬럼(숫자 외 문자는 제거 후 계산). 생성 컬럼이라 **업로드 upsert 에 넣지 말 것**.
  클라이언트 계산이 필요하면 [lib/members.ts](lib/members.ts)의 `usedCount(rec)`를 쓴다.
  - ⚠️ **이 컬럼은 "수강권 1건짜리" 값이다 — 사람 단위 합계가 아니다.**
    회원 관리의 "사용횟수 범위" 필터가 예전에 이걸로 서버 필터(`.gte/.lte`)를 걸어서,
    "100회 이상"이 **한 수강권에서만 100회 넘게 쓴 행**을 찾았다(실측 1명). 지금은 전체
    members 를 한 번 읽어 **사람별 합계**로 거른다(같은 조건 282명). 합계 기준은 전 지점
    합산이라 지점 필터와 무관하다. 사람 단위 필터가 켜지면 화면에서 페이징한다.
  - ⚠️ **전체를 훑는 페이징에는 반드시 `.order()` 를 건다.** Postgres 는 ORDER BY 없는
    LIMIT/OFFSET 의 행 순서를 보장하지 않아, 페이지 사이에 같은 행이 두 번 나오거나 빠진다.
    합계가 조용히 부풀어 필터 결과가 뒤집힌다. `fetchAllRows` 는 `SCAN_ORDER_COL`(=`id`)로
    정렬하며, 직접 짜는 스캔 루프도 똑같이 할 것.
  - **숫자 컬럼 정렬은 서버(`.order()`)에 맡기면 안 된다.** DB 컬럼이 전부 `text` 라
    사전순(전체횟수 300 < 9)이 된다. 회원 관리는 `NUM_COLS` 정렬이면 전체를 받아 화면에서
    숫자로 정렬한다(그래야 사용횟수 필터를 켜고 끌 때 순서가 안 바뀐다). 스캔 결과는
    조건별로 캐시하므로 페이지 이동만으로는 다시 긁지 않는다.
- **DB 마이그레이션(1회):** 위 `sales` 테이블 + RLS + `members.used_count`는
  [sql/2026-07_sales_and_used_count.sql](sql/2026-07_sales_and_used_count.sql)을
  Supabase SQL Editor에서 실행해 반영한다(idempotent). 이 SQL을 돌리기 전에는
  사용횟수 필터/매출 업로드가 동작하지 않는다.

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
