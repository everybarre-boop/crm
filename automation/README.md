# 일간 CRM 자동화 (automation/)

매일 21:00(KST) GitHub Actions 가 **한 번** 실행되어:

1. **어제(D-1)** 출석/결석을 확정해 `members` 사용횟수를 갱신하고
2. **내일(D+1)** 지점별 예약자 명단을 가져와
3. CRM 규칙을 평가해 멘트를 만들고
4. 지점별 슬랙 채널에 통합 메시지 1건을 보낸다.

> 📖 **운영 매뉴얼(슬랙 앱 설치·Secrets·장애 대응·규칙 표)은 [docs/CRM-SLACK.md](../docs/CRM-SLACK.md).**
> 이 파일은 개발자용 요약이다.

## 보안 원칙 (반드시 준수)

- **`service_role` 키를 쓰지 않는다.** 관리자 계정(`ADMIN_EMAIL`/`ADMIN_PASSWORD`)으로
  로그인해 **RLS 안에서** 동작한다. 매칭·갱신은 DB의 `apply_attendance` / `save_reservations`
  RPC(SECURITY DEFINER, 내부에서 관리자 이메일 재검증)가 처리한다.
- 비밀값은 **저장소에 두지 않는다.** GitHub → Settings → Secrets and variables → Actions.
- `automation/` 코드는 앱(`app/`·`components/`·`lib/`)에서 **import 금지** — 클라이언트 번들에
  섞이면 안 된다. 반대로 `automation/ → shared/*.mjs` 는 허용된다(의존성 0인 순수 함수).
- **슬랙에는 이름 + 수업 정보까지만.** 연락처·생년월일·결제금액 금지. 운영 알림에는 건수만.
- 스크랩 결과·미매칭 로그엔 회원 PII 가 담긴다 → `automation/out/`, `*.local.json` 은
  `.gitignore` 로 커밋 차단. **Actions artifact 로도 올리지 말 것.**

## 구조 — 셀렉터를 한 파일에 가둔 이유

```
config.mjs                 환경변수 + 지점(slug·슬랙채널) + preflight()
run.mjs                    오케스트레이터 (8단계)
studiomate/selectors.mjs   ⚠️ 화면이 바뀌면 고치는 유일한 파일 (URL·셀렉터·상태 라벨)
studiomate/scrape.mjs      흐름(로그인·순회·추출). 셀렉터를 전혀 모른다 — 필드맵만 순회
studiomate/normalize.mjs   원문 문자열 → DB 형태 (시간·날짜·상태·횟수)
db.mjs                     Supabase 읽기/쓰기 (PostgREST + RLS)
crm.mjs                    규칙 평가 배선 + 지점별 슬랙 발송
slack.mjs                  Block Kit 조립 + chat.postMessage/update (순수 fetch)
notify.mjs                 워크플로 `if: failure()` 용 실패 알림 CLI
test/rules.test.mjs        규칙 경계값 회귀 테스트 (node --test, 의존성 0)
```

판정 로직은 여기 없다. 전부 [`shared/crm-rules.mjs`](../shared/crm-rules.mjs)(순수 함수)에 있고,
동일인 판정·횟수 계산은 [`shared/crm-core.mjs`](../shared/crm-core.mjs)를 앱과 **공유**한다.
같은 공식을 SQL 이나 자동화 쪽에 다시 구현하면 "코드가 만드는 값 ↔ DB 가 만드는 값"이 어긋난다
— `dedup_key` 로 두 번 겪은 사고다(CLAUDE.md).

## 선행 조건 (1회)

Supabase SQL Editor 에서 **순서대로**:

1. `npm run db:backup members` · `npm run db:backup sales` (되돌리기 어려운 SQL 전)
2. `sql/2026-08_apply_attendance_v2.sql` — **선행 필수.** 재등록 다중행을 전부 덮어쓰던 버그 수정
3. `sql/2026-08_crm.sql` — `reservations`·`crm_*` 테이블 + RPC + 뷰 + 규칙 seed
4. `sql/2026-08_verify_crm.sql` — 전 항목 ✓ 확인

## 로컬 실행

```bash
# ① 규칙 경계값 테스트 (DB 불필요, 수 초)
npm run test:rules

# ② MOCK 으로 전 파이프라인 — 슬랙 메시지 전문이 콘솔에 그대로 찍힌다
cp automation/mock.example.json automation/mock.local.json
MOCK_FILE=automation/mock.local.json MOCK_DATE=2026-08-05 DRY_RUN=true node automation/run.mjs

# ③ 실제 스크랩 + dry-run (셀렉터 채운 뒤, 한 지점만)
ONLY_BRANCHES=광교 DRY_RUN=true node automation/run.mjs

# ④ 반영 (재실행해도 행 수가 안 늘어나는지 = 멱등 확인)
DRY_RUN=false node automation/run.mjs
```

> Windows PowerShell: `$env:MOCK_FILE='...'; $env:DRY_RUN='true'; node automation/run.mjs`

### 환경변수

| | |
|---|---|
| `DRY_RUN` | **전 단계 읽기 전용**. 기본 `true`. `true/1/yes/on` · `false/0/no/off` 만 허용하고 **그 외 값은 에러로 멈춘다**(옛 코드는 오타를 조용히 `true` 로 읽어 밤새 아무 일도 안 일어났는데 초록불만 남았다) |
| `SLACK_DRY_RUN` | 슬랙만 따로 막는다. 기본은 `DRY_RUN` 상속 |
| `SLACK_POST_EMPTY` | 0명인 지점도 메시지를 보낼지. 기본 `false`(매일 "0명"은 노이즈) |
| `MOCK_FILE` / `MOCK_DATE` | 스튜디오메이트 없이 검증. `MOCK_DATE` 로 "오늘"을 고정해야 날짜 의존 규칙(만료 D-7)을 재현할 수 있다 |
| `TARGET_DATE` | D+1 강제(장애 후 수동 재실행) |
| `STEPS` | 부분 실행. `attendance,roster,crm,slack` 중 골라 쉼표 구분 |
| `ONLY_BRANCHES` | 지점 한정 |
| `HEADLESS` | `false` 로 두면 브라우저 창이 보인다(셀렉터 작업용) |

## 남은 구현 — 스튜디오메이트 셀렉터

`studiomate/selectors.mjs` **한 파일만** 채우면 된다. 값은 세 가지를 허용한다:

- 문자열 → CSS 셀렉터 (첫 매치의 `textContent`)
- 함수 → `async (scope, page) => string` (속성 읽기·정규식 등 예외 케이스)
- `null` → "아직 모름". 그 필드는 빈 값이 되고 실행 요약에 `못 읽은 필드` 경고가 뜬다
  → **한 번에 다 채우지 않아도 파이프라인을 돌려볼 수 있다.**

```bash
HEADLESS=false ONLY_BRANCHES=광교 STEPS=roster DRY_RUN=true node automation/run.mjs
npx playwright codegen https://<slug>.studiomate.kr
```

채우는 순서는 **roster(단순) → attendance(수강권 모달까지, 복잡)**.

## 실패 처리

- 지점 1~2곳 실패 → 나머지는 진행하고 `exit 1` + 운영 채널 알림 (사람이 판단)
- **전 지점 실패 → 즉시 중단.** 로그인 실패/DOM 변경을 "예약자 0명"으로 오해하면 아무 일도
  안 일어난 채 초록불만 남는다(옛 run.mjs 의 실제 문제)
- 워크플로는 `if: failure()` 로 `notify.mjs` 를 한 번 더 부른다. run.mjs 가 이미 알렸으면
  `automation/out/.notified` 마커를 보고 중복 발송을 건너뛴다

## 재실행 멱등성 — 21:00 실패 후 22:00 재실행이 안전하다

| 단계 | 근거 |
|---|---|
| `apply_attendance` | 입력 1건당 members 1행만 갱신(v2) |
| `save_reservations` | `res_key` UNIQUE upsert. 확정 상태를 '예약'으로 되돌리지 않음 |
| `crm_messages` | `(대상일자,지점,person_key,rule_id,규칙키)` UNIQUE upsert. 발송여부·피드백 컬럼은 payload 에 없어 보존됨 |
| 마일스톤 억제 | 억제 조회에 `대상일자 <> targetDate` — 없으면 재실행 시 자기 자신이 억제 근거가 되어 메시지가 사라진다 |
| `crm_dormant` | PK upsert + `갱신일` 청소. `최초감지일`은 payload 에 없어 보존됨 |
| 슬랙 | `crm_slack_posts` UNIQUE → 새 메시지가 아니라 `chat.update` |
