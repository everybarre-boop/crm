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
npm run db:sql sql/2026-08_crm.sql   # sql/ 마이그레이션 실행 (Supabase SQL Editor 대신)
```

**`db:sql` — 700줄짜리 SQL 을 SQL Editor 에 복사·붙여넣기 하는 대신 쓴다.**
[scripts/run-sql.mjs](scripts/run-sql.mjs)가 `DATABASE_URL` 로 붙어 실행한다(`db:backup` 과 같은
"개발 도구 전용" 경로 — 클라이언트 번들과 무관, 접속 문자열은 에러 출력에서 마스킹).
**실행 대상은 저장소의 `sql/*.sql` 로만 제한**한다 — 임의 경로 SQL 을 전권 연결로 돌리는 통로를
만들지 않기 위함이다. 파일 하나가 **하나의 암묵 트랜잭션**이라 중간에 실패하면 그 파일 전체가
롤백된다(반쯤 적용된 상태가 안 남는다). 파일 끝의 점검 SELECT 결과는 표로 출력된다.
되돌리기 어려운 SQL 전에는 `db:backup` 을 먼저.

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
- **[shared/](shared/) — 앱과 자동화가 **같은 공식**을 쓰기 위한 순수 모듈.**
  [shared/crm-core.mjs](shared/crm-core.mjs)(동일인 판정·횟수·날짜),
  [shared/crm-rules.mjs](shared/crm-rules.mjs)(CRM 규칙 엔진). 타입은 손으로 쓴 `.d.mts`.
  - ⛔️ **`shared/*.mjs` 에는 import 문이 하나도 없어야 한다**(crm-rules → crm-core 만 예외).
    검사: `grep -n "^import\|require(" shared/*.mjs`. 의존성이 붙는 순간 앱 번들이 오염되거나
    자동화가 브라우저 코드를 끌어온다.
  - `lib/members.ts` 는 이 구현들을 **re-export 만** 한다 — 화면 코드는 지금까지처럼
    `from '@/lib/members'` 를 쓰면 된다. 구현을 lib 로 되돌리지 말 것(자동화가 못 쓴다).
- **[automation/](automation/) — 일간 CRM 자동화(Node/Playwright).** 아래 "일간 CRM 자동화" 참고.
  - ⛔️ `app/`·`components/`·`lib/` 를 **import 금지**(클라이언트 번들 오염). 반대로
    `automation/ → shared/*.mjs` 는 허용된다.
- vendor 스크립트 없음. `@supabase/supabase-js`, `xlsx`는 npm 의존성으로 번들된다.
- 백엔드 없음. Next.js가 정적 파일로 빌드한다(`output: 'export'`).

## 데이터 모델

- 테이블: `public.members`(회원+수강권), `public.sales`(매출/결제). 둘 다 엑셀 헤더명이
  곧 DB 컬럼명이다(한글 컬럼). 회원 컬럼은 [lib/members.ts](lib/members.ts)의 `COLUMNS`,
  매출 컬럼은 [lib/sales.ts](lib/sales.ts)의 `SALES_COLUMNS`가 기준.
  그 밖에 `branch_costs`(지점 비용), `daily_runs`(자동화 실행 로그), 그리고 CRM 자동화용
  `reservations`·`crm_rules`·`crm_messages`·`crm_dormant`·`crm_slack_posts` 가 있다
  (아래 "일간 CRM 자동화" 참고). Drizzle 짝은 [lib/db/schema.ts](lib/db/schema.ts).
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
- 🔥 **사람 단위 누적 사용횟수는 행을 더해서 내지 말 것 — `personUsedCount(rows)` 를 쓴다.**
  `members` 한 행은 사람도 수강권도 아니고 **(수강권 등록건 × 결제건 × 그때의 이름)** 이다.
  같은 수강권 한 장이 ① 이름 표식(`'구태희'` / `'구태희 미수금'`)이 붙었다 떼어지는 사이의
  재업로드 ② 미수금 완납·추가 결제로 갈라진 결제 행 때문에 여러 행으로 남고,
  **그 행들이 같은 잔여횟수를 각자 들고 있다.** `Σ (전체−잔여)` 는 한 번 나온 수업을 2~3번 센다.
  - 실사고(2026-08-14 반포): 구태희 5행 합 9 → 슬랙에 **"오늘로 10번째 수업이에요"** 발송.
    **실제 출석 4회.** 그날 마일스톤 5건 중 3건이 틀렸다. 전 회원 7,690명 중 **583명**이 부풀어
    있었다(최대 +615회). 공식은 [shared/crm-core.mjs](shared/crm-core.mjs) 의
    `dedupeTicketRows`(= 수강권명 + 수강권시작일 하나당 대표 1행, 사용횟수 최대) ·
    `usageAudit`(값 + 그 값을 믿어도 되는지) · `personUsedCount` 한 곳에만 둔다.
  - 재등록(같은 수강권명 · **다른** 시작일)은 별개 등록건이라 그대로 더해진다 — 접는 건
    **같은 등록건의 중복 행**뿐이다.
  - **회차·횟수를 말하는 멘트는 사실 단언이다.** `verifyMilestone()` 이 `reservations` 의 실제
    출석 수와 대조해 모순이면 보류한다(전체횟수/시작일 결손 · 출석기록 > 누적 · 전 이력이
    관측 안인데 불일치). 배경과 표는 [docs/CRM-SLACK.md](docs/CRM-SLACK.md) 4-1 절.
- **`used_count`(사용횟수) 컬럼:** `members.used_count` = `전체횟수 − 잔여횟수`인 STORED
  생성 컬럼(숫자 외 문자는 제거 후 계산). 생성 컬럼이라 **업로드 upsert 에 넣지 말 것**.
  클라이언트 계산이 필요하면 [lib/members.ts](lib/members.ts)의 `usedCount(rec)`를 쓴다.
  - ⚠️ **이 컬럼은 "수강권 1건짜리" 값이다 — 사람 단위 합계가 아니다.**(위 항목도 같이 볼 것)
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

## 일간 CRM 자동화 (2026-08)

매일 21:00 KST GitHub Actions 실행(22:30 예비 1회) → 어제 출석 반영 → 내일 예약자 명단 →
CRM 규칙 → 지점별 슬랙 발송. 피드백은 관리자 페이지에서 받는다.
- 🔥 **GitHub 의 `schedule` 은 기본 브랜치의 워크플로만 실행한다.** 기능 브랜치에만 cron 이
  있으면 영원히 안 돈다(수동 실행만 가능) — 실제로 2026-08-13 이후 5일간 야간 실행이 없었다.
- 예비 실행(22:30)은 [automation/guard.mjs](automation/guard.mjs) 를 먼저 태운다. 그날 발송이
  이미 끝났으면 Playwright 설치 전에 끊는다. schedule 은 지연될 뿐 아니라 **스킵**되기도 하는데,
  스킵은 실행이 없어서 실패 알림조차 없다 — 그 조용한 구멍을 메우는 자리다.
**운영 매뉴얼(슬랙 앱·Secrets·장애 대응·규칙 표)은 [docs/CRM-SLACK.md](docs/CRM-SLACK.md).**

- **선행 SQL(순서 고정):** [sql/2026-08_apply_attendance_v2.sql](sql/2026-08_apply_attendance_v2.sql)
  → [sql/2026-08_crm.sql](sql/2026-08_crm.sql) → [sql/2026-08_verify_crm.sql](sql/2026-08_verify_crm.sql).
  실행 전 `npm run db:backup members` · `npm run db:backup sales`.
- 🔥 **`apply_attendance` v1 은 재등록 다중행을 전부 덮어썼다.** 매칭이
  `이름+수강권명+연락처` 3열이었는데, 2026-08 `KEY_COLS` 개정 이후 **같은 사람의 같은 수강권
  재등록 건이 각각 별개 행**이라(이가원 `언리미티드(판교) 30회` 19행) 그 19행이 전부 같은
  전체/잔여로 덮였다 → `used_count` 합(=1인 누적)이 왜곡되고 `matched > requested` 가 됐다.
  v2 는 입력 1건당 members **1행만** 고른다(수강권시작일 정확 일치 → 최신 등록건 순).
  v1(3인자) 함수는 **삭제**한다 — 남겨 두면 3인자 호출이 양쪽에 매칭돼 `is not unique` 에러다.
- **`reservations.res_key` 불변식** = `지점 ⋮ 예약일자 ⋮ 수업시간 ⋮ 수업명 ⋮ 이름 ⋮ 숫자연락처`
  (`⋮` = chr(31)). `dedup_key` 와 **같은 원칙** — `예약상태`·`수강권명`·`강사`는 재실행 때
  값이 변하므로(예약→출석) 키에 넣지 않는다. 키 참여 컬럼은 전부 `not null default ''`
  (하나라도 NULL 이면 unique index 에서 NULL≠NULL 이라 재실행마다 새 행이 쌓인다).
  **공식은 `_norm_reservations` RPC 안에만 있다** — JS 로 다시 구현하지 말 것.
- **`reservations` 는 하루 300~800행씩 쌓인다.** 클라이언트에서 `fetchAllRows` 로 전량 스캔
  **금지**. 항상 `.gte/.lte('예약일자')` 로 끊는다. CRM 실행 화면은 아예 안 읽는다(야간 잡이
  `crm_messages` 에 결과를 미리 써 두기 때문 — 이게 성능을 지키는 핵심이다).
- **뷰는 반드시 `with (security_invoker = on)`.** 없으면 뷰가 소유자 권한으로 돌아 **RLS 를
  우회**한다 — anon 이 뷰로 회원 PII 를 읽는 경로가 생긴다.
- **슬랙은 발송 전용(outbound only)이다.** 버튼 응답을 받으려면 HTTP 엔드포인트가 필요한데
  서버를 도입하면 정적 export + RLS 모델이 통째로 바뀐다. 피드백은 `crm_messages` 의 인라인
  컬럼(`실행여부`/`반응`/`메모`)에 관리자 화면에서만 쓴다.
  - 🔐 **슬랙에 나가는 PII 는 "이름 + 수업 정보"까지.** 연락처·생년월일·결제금액 금지
    (채널 인원이 회원 DB 접근 권한자보다 넓다). 운영 알림에는 **건수만** — 미매칭 로그에는
    실명이 섞인다. `automation/out/*.json` 은 커밋·artifact 업로드 금지.
  - Slack Web API 는 **실패해도 HTTP 200** 을 준다. 반드시 본문의 `ok:false` 를 검사할 것.
- **`crm_messages.연락처`를 반드시 채운다.** 이 테이블에는 `dedup_key` 가 없어서, 연락처가
  비면 `makePersonResolver` 폴백이 행 단위 일련번호로 떨어져 `sales` 와 절대 안 붙는다
  → CRM 성과 화면의 결제 전환 계산이 통째로 무너진다.
- **재실행 멱등성** — 21:00 실패 후 22:00 재실행이 안전해야 한다. 마일스톤 억제 조회에는
  반드시 `대상일자 <> targetDate` 를 넣는다. 없으면 1차 실행에서 발송된 **자기 자신**이 억제
  근거가 되어 재실행 때 메시지가 통째로 사라진다.
- **`DRY_RUN` 은 엄격 파싱한다**(`parseBool`). 옛 코드는 `!== 'false'` 라서 `DRY_RUN=1`·오타가
  전부 조용히 `true`(=아무것도 안 함)가 됐다 — 밤새 아무 일도 없었는데 아침에 초록불만 남았다.
- **스크래퍼 셀렉터는 [automation/studiomate/selectors.mjs](automation/studiomate/selectors.mjs)
  한 파일에만 둔다.** `scrape.mjs` 는 흐름만 담당하고 셀렉터를 모른다. 값은 문자열(CSS)/
  함수/`null`(미설정) 셋 다 되고, `null` 이면 그 필드만 비고 경고가 뜬다.
- 🔥 **스튜디오메이트 실측(2026-08-10) — 가정과 달랐던 것들:**
  - **사이트 ≠ 지점.** `everybarre.studiomate.kr` 하나에 **청담·판교가 같이** 있다
    (일간·룸별 뷰의 룸 컬럼이 지점). 나머지는 `everybarre-{gwanggyo,oksu,banpo,songpa}`.
    그래서 스크랩 단위는 `config.mjs` 의 **`SITES`**(지점 아님)이고, 각 예약행의 지점은
    **수강권명에서 뽑는다**(`branchOf`). 사이트마다 세션이 따로라 **사이트별로 로그인**한다.
  - **로그인은 이메일이 아니라 휴대폰 번호**(`STUDIOMATE_PHONE`, `input#mobileRequired`).
  - **날짜는 `?date=` 쿼리로 못 바꾼다 — 무시된다.** 좌/우 화살표로 한 칸씩 이동하며 매번
    `.el-date-editor input` 값으로 검증한다(`gotoDate`).
  - **수업 상세 한 페이지(`/lecture/detail?id=`)에 필요한 게 전부 있다** — 이름·연락처·
    수강권명·잔여횟수·수강권기간·예약상태. 회원 상세 모달에 들어갈 필요가 없다.
  - ⚠️ **전체횟수는 화면 어디에도 없다**("12회 남음"만). 스크래퍼는 빈 값으로 보내고
    `apply_attendance` v2 가 `coalesce(tgt.tot, mem."전체횟수")` 로 DB 값을 유지한다.
    **이 coalesce 를 빼면 전체횟수가 통째로 비워져 `used_count` 가 음수가 된다.**
    수강권명의 "40회" 같은 명목값을 대신 넣지 말 것 — 횟수 조정된 회원이 틀어진다.
  - 예약상태는 텍스트가 아니라 **readonly `input` 의 value**(Element UI 셀렉트).
    화면 원문 어휘(2026-08-12 실측): `예약` · `예약 확정` · `예약 대기 (1)` · `출석` · `결석`
    (드롭다운은 `취소/결석/노쇼/출석`). `normStatus` 가 `예약/예약대기/출석/결석/노쇼/취소` 로 접는다.
    예약자 행은 반드시 `li.members-list-item` 으로 잡는다
    (`li` 만 쓰면 상태 드롭다운 옵션까지 잡혀 11명이 55개가 된다).
  - 🔥 **화면의 "예약회원 (N명)" 은 `li` 수와 다르다.** 27개 수업 전수 확인으로 나온 불변식:
    **`count(li:not(.uncounted)) == N + M`** (`M` = "예약 대기 회원 (M명)", 없으면 0).
    - **결석 행에는 `uncounted` 클래스가 붙고 라벨 N 에서 빠진다**(결석 ⇔ `uncounted` 1:1, 예외 0건).
    - **예약대기자는 별도 `ul`** 에 있고 자기 라벨로 따로 센다. `li` 클래스는 예약자와 같아서
      **DOM 으로는 구분되지 않는다** — 구분은 예약상태 값(`예약 대기 (n)`)으로 한다.
    - 이걸 모르고 `li` 수 == N 으로 검증해서 만석 수업이 통째로 실패했다(옛 "미완: 예약대기 분리").
  - ⛔️ **`예약대기`를 `예약`으로 접지 말 것.** 접으면 대기자가 예약자로 둔갑해 "내일 봬요" 계열
    멘트가 나간다. 거르는 자리는 두 곳이고 **둘 다 있어야** 한다 —
    [normalize.mjs](automation/studiomate/normalize.mjs) 의 `STATUS_RULES`(정규화) 와
    [shared/crm-rules.mjs](shared/crm-rules.mjs) 의 `NOT_ATTENDING`(대상 제외).
    `reservations` 에는 **남긴다**(대기 이력). 빼는 건 CRM 대상에서만이다.
  - ✅ **대기 → 출석 전이는 스스로 검증된다.** 대기자와 확정자는 `res_key` 가 같으므로
    (같은 사람·같은 수업), 대기가 승인돼 수업에 들어가면 다음날 D-1 스크랩이 같은 행을
    `예약대기 → 출석` 으로 덮는다. 즉 "어제 대기였는데 오늘도 대기인 사람"은 실제로 못 들어간
    사람이다. 그래서 `save_reservations` 의 `on conflict` 는 `예약대기` 를 **미확정**으로 취급해야
    한다(확정된 `출석` 을 재실행이 `예약대기` 로 되돌리면 이 근거가 사라진다).
  - **과거 날짜 조회 가능** → `reservations` 백필로 "14일 미방문"을 첫날부터 낼 수 있다.
  - 🔥 **수업 상세는 클릭한 자리에서 읽지 말고 `URLS.lectureDetail(slug, id)` 로 새로 열어
    읽는다.** 이 SPA 는 URL 을 먼저 바꾸고 내용은 API 응답 뒤에 다시 그리는데, 로딩 판정용
    `.lecture-detail-header__content__title` 은 **직전 수업 것이 그대로 남아 있어**
    `waitFor` 가 즉시 통과한다 → 이전 수업 명단을 새 id 로 한 번 더 읽는다.
    실측(2026-07-29 청담·판교): 해월쌤12:00 명단이 솔쌤09:30 의 id 로 또 저장되고
    **솔쌤10:30 수업 10명이 통째로 사라졌다.** 고유 id 8개를 다 방문해서 `누락` 검사도
    통과했다 — 조용히 한 수업이 빠진다. `?date=` 와 달리 상세의 `?id=` 는 **먹는다**.
    - 클릭은 **id 를 알아내는 용도로만** 쓴다(수업 블록에 `data-id`·`href` 가 없다 — 실측).
      id 가 없으면 폴백 키를 만들지 말고 **실패**시킨다(같은 수업이 두 키로 두 번 담긴다).
    - 상세는 **별도 탭**에서 연다. 같은 탭에서 열면 캘린더가 오늘로 되돌아가 날짜마다
      화살표를 처음부터 눌러야 한다(백필이 O(n²)).
  - 🔥 **예약자 목록은 `page.evaluate` 한 번으로 통째로 읽는다.** 행마다 `nth(i)` 로 왕복하면
    (100명 × 필드 3개 = 300왕복) 읽는 도중 Vue 가 목록을 다시 그려 **같은 행을 두 번 읽고
    다른 행을 통째로 빠뜨린다.** 실측(백필 첫 실행, 옥수 07-29): 44행을 읽었는데 서로 다른
    사람은 35명 — 8명이 조용히 사라졌고 재실행하니 43명이 정상이었다.
    ⚠️ **인원수 검증은 이걸 못 잡는다** — `count(li:not(.uncounted)) == N + M` 은 개수만 본다.
    그래서 `selectors.mjs` 의 `booking.*` 는 전부 **`li` 기준 하위 CSS 문자열**이어야 한다
    (함수로 두면 브라우저 안으로 넘길 수 없다). 같은 원칙이 앞으로 추가할 목록에도 적용된다.
- 🔥 **스크래퍼를 고쳤으면 같은 날짜를 2~3회 돌려 건수가 같은지 확인할 것.**
  2026-08-12 에 찾은 결함 4개(예약대기 오분류 · 행 단위 왕복 읽기 · 상세 stale 읽기 ·
  라벨 못 읽으면 검증 건너뜀)는
  **전부 에러 없이 초록불로 끝났고 인원수 검증도 통과했다.** 셋 다 비결정적이라
  (같은 날짜가 75/77/77) 한 번만 돌리면 정상으로 보인다. 배경과 재발 방지 규칙은
  [docs/CRM-SLACK.md](docs/CRM-SLACK.md) 1-8 절.
  - **개수 검증은 정체성 검증이 아니다.** `count(li:not(.uncounted)) == N + M` 은 몇 개인지만
    본다 — 같은 사람을 두 번 읽고 다른 사람을 빠뜨려도 통과한다.
  - **SPA 에서 "요소가 있다"는 "그 값이 최신"과 다르다.** 직전 화면이 남아 있으면
    `waitFor` 가 즉시 통과한다. 존재가 아니라 **대상이 일치하는지**로 판정할 것.
  - **수집 ≠ 저장이면 왜 줄었는지 로그에 사유를 찍을 것**(`parsed`·`duplicates`).
    이걸 안 찍어서 7건이 사라진 걸 한동안 못 봤다.
  - **검증을 조건부로 만들지 말 것.** `if (Number.isFinite(기대값))` 처럼 "기대값을 못 읽으면
    검증을 건너뛰는" 코드는, 화면이 아직 안 그려졌을 때 **빈 목록을 0명으로 통과시킨다.**
    검증할 수 없으면 통과가 아니라 **실패**다.
- **전 지점 스크랩 실패는 fatal 이다.** 로그인 실패를 "예약자 0명"으로 오해하면 아무 일도 안
  일어난 채 초록불만 남는다(옛 `run.mjs` 의 실제 문제). 1~2지점 실패는 나머지 진행 + `exit 1`.
- **규칙 변경 시 [automation/test/rules.test.mjs](automation/test/rules.test.mjs)가 먼저 깨져야
  한다.** `npm run test:rules`(DB 불필요, 수 초). 경계값(정확히 100회/99회, 7일/8일,
  잔여 30%/29%, 재실행 멱등)을 고정해 둔 자리다.
- **"14일 미방문"은 예약 스냅샷 이력이 쌓여야 나온다.** 관측일수 < 14 면 규칙이 자동으로
  잠기고 화면에 배너가 뜬다. 관측된 적 없는 회원은 "미방문"이 아니라 **"모름"**으로 표기한다
  (`경과일추정`). 여기서 추정치를 지어내지 말 것 — `used_count` 만으로는 "언제" 썼는지 모른다.
  - 기다리지 않고 채우려면 [automation/backfill.mjs](automation/backfill.mjs)
    (`npm run backfill`). 과거 날짜를 훑어 `reservations` 만 채운다.
    ⛔️ **백필은 `apply_attendance` 를 부르지 않는다** — 수업 상세의 "12회 남음"은 그 날짜의
    값이 아니라 **회원의 현재 잔여횟수**라, 과거 날짜로 members 를 갱신하면 같은 값을 수백 번
    덮어쓸 뿐이고 중간에 실패하면 어디까지 반영됐는지도 알 수 없다.
    오늘·미래 날짜는 거부하고, 끝낸 (사이트,날짜)를 진행 파일에 남겨 재실행 때 건너뛴다.

## 소통 규칙

- **사용자에게 묻는 질문과 선택지는 전부 한국어로 쓴다.** 선택지 라벨·설명도 한국어다
  (영어 원어가 꼭 필요한 고유명사만 괄호로 병기).

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
- ⛔️ **소스 파일에 raw 제어문자(특히 NUL)를 넣지 말 것.** 구분자가 필요하면 `\u0000`·
  `\u001f` 같은 **이스케이프**로 쓴다. 런타임 값은 같지만, raw 바이트로 두면 git 이 그 파일을
  **바이너리로 취급해 diff 가 통째로 안 보이고 ripgrep 도 건너뛴다** — 코드 리뷰 사각지대가
  된다. 실제로 [shared/crm-rules.mjs](shared/crm-rules.mjs) 가 NUL 6개 때문에 그 상태였다
  (2026-08-13 발견·수정). 검사: `git diff --stat` 에 `Bin` 이 뜨면 의심할 것.
- **규칙(`crm_rules`)에 파라미터를 새로 추가하면 코드 기본값으로 병합되게 둘 것.**
  DB 에 이미 저장된 행에는 그 키가 없어서, 병합하지 않으면 새 기능이 **조용히 꺼진 채**
  배포된다. 병합은 `shared/crm-rules.mjs` 의 `ruleMap()` 이 한다(값이 있는 키는 DB 가 이긴다).
