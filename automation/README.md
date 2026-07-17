# 일간 자동 갱신 (automation/)

스튜디오메이트 당일 예약자의 **전체/잔여 횟수**를 읽어 `members` 에 반영한다.
PC 가 꺼져 있어도 **GitHub Actions** 가 매일 클라우드에서 실행한다.
`sql/2026-07-16_update_gwanggyo_counts.sql`(사람이 손으로 하던 작업)의 자동화 버전.

## 보안 원칙 (반드시 준수)

- **`service_role` 키를 쓰지 않는다.** 관리자 계정(`ADMIN_EMAIL`/`ADMIN_PASSWORD`)으로
  로그인해 **RLS 안에서** 동작한다. 복잡한 매칭·갱신은 DB의 `apply_attendance` RPC
  (SECURITY DEFINER, 내부에서 관리자 이메일 재검증)가 처리한다.
- 비밀값은 **저장소에 두지 않는다.** GitHub → Settings → Secrets and variables → Actions.
  로컬 실행은 `automation/.env`(gitignore) 를 쓴다.
- `automation/` 코드는 앱(`app/`·`components/`·`lib/supabase.ts`)에서 **import 금지** —
  클라이언트 번들에 섞이면 안 된다(정적 export + RLS 모델 유지).
- 스크랩 결과·미매칭 로그엔 회원 PII 가 담긴다 → `automation/out/`, `*.local.json` 은
  `.gitignore` 로 커밋 차단돼 있다.

## 선행 조건 (1회)

1. Supabase SQL Editor 에서 순서대로 실행:
   - `sql/2026-07_verify_dedup.sql` — `members.dedup_key` 실재 확인(먼저 점검)
   - `sql/2026-07_apply_attendance.sql` — RPC + `daily_runs` 로그 테이블
2. `npm install` (playwright 포함), 로컬 스크랩 검증 시 `npx playwright install chromium`

## 로컬 실행

`automation/.env` (커밋 안 됨) 예시:

```
SUPABASE_URL=https://jxsdopvxtzpbyxxctcem.supabase.co
SUPABASE_ANON_KEY=<공개 anon 키>
ADMIN_EMAIL=basegolf.official@gmail.com
ADMIN_PASSWORD=<관리자 비밀번호>
STUDIOMATE_EMAIL=...
STUDIOMATE_PASSWORD=...
SM_SLUG_GWANGGYO=everybarre-gwanggyo
```

```bash
# 1) 파이프라인만 검증 (스튜디오메이트 없이, 반드시 dry-run)
cp automation/mock.example.json automation/mock.local.json
MOCK_FILE=automation/mock.local.json DRY_RUN=true node automation/run.mjs

# 2) 실제 스크랩 + dry-run (studiomate.mjs 셀렉터를 채운 뒤)
DRY_RUN=true node automation/run.mjs

# 3) 실제 반영
DRY_RUN=false node automation/run.mjs
```

> Windows PowerShell 은 `$env:MOCK_FILE='...'; $env:DRY_RUN='true'; node automation/run.mjs`

## 남은 구현 — 스튜디오메이트 셀렉터

`automation/studiomate.mjs` 의 `SELECTORS` 와 `scrapeBranch()` TODO 를 실제 화면에 맞춰
채워야 한다. 클릭 경로는 codegen 으로 뽑으면 쉽다:

```bash
npx playwright codegen https://<slug>.studiomate.kr
```

채우기 전에는 `scrapeBranch` 가 명시적으로 에러를 던지므로, 먼저 **MOCK 으로 파이프라인
(로그인 → RPC → 로그)** 을 검증한다.

## GitHub Actions

`.github/workflows/daily-update.yml`.
처음엔 **workflow_dispatch(수동) + DRY_RUN=true** 로 며칠 돌려 `daily_runs` 의 미매칭을
확인하고, 안정되면 `schedule` 주석을 풀고 반영(DRY_RUN=false)으로 전환한다.
Secrets: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`,
`STUDIOMATE_EMAIL`, `STUDIOMATE_PASSWORD`, `SM_SLUG_*`.
