# 일간 CRM 자동화 — 운영 매뉴얼

매일 21:00(KST) GitHub Actions 가 스튜디오메이트를 읽어 **내일 수업 CRM 명단**을 지점 슬랙
채널로 보내고, 어제 출석분을 `members` 에 반영한다. 강사 피드백은 관리자 페이지의
**CRM 실행** 화면에서 받는다.

---

## 0. 한눈에 보는 흐름

```
21:00 KST  GitHub Actions (daily-update)
  ①  D-1 출석/결석 스크랩  →  apply_attendance      →  members 전체/잔여 갱신 (used_count 자동)
  ②  D-1 예약 스냅샷 저장  →  save_reservations     →  '예약' → '출석/결석' 확정
  ③  D+1 예약자 명단 스크랩 → save_reservations     →  내일 수업 로스터
  ④  규칙 평가             →  crm_messages / crm_dormant
  ⑤  지점별 슬랙 발송      →  crm_slack_posts
  ⑥  실패하면 #ops 알림

다음날  강사가 슬랙을 보고 수업 → 관리자가 "CRM 실행" 화면에서 멘트함/못함 체크
매주   관리자가 전체 회원 엑셀을 "데이터 업로드"에서 재업로드 (품질 교정)
```

**왜 D+1 명단은 잔여횟수를 스크랩하지 않나** — 같은 실행의 ①에서 `members` 를 이미 최신으로
갱신했고, 주 1회 엑셀 재업로드로 교정까지 되므로 **DB 값이 스크랩보다 정확**하다. 회원 상세
모달 진입을 없애면 클릭 수가 수백 회 줄어 timeout 위험도 사라진다.

---

## 1. 최초 1회 설정

### 1-1. DB (Supabase → SQL Editor, 순서대로)

```
① npm run db:backup members     ← 되돌리기 어려운 SQL 전에 반드시
② npm run db:backup sales
③ sql/2026-08_apply_attendance_v2.sql      ← 선행 필수 (아래 설명)
④ sql/2026-08_crm.sql
⑤ sql/2026-08_verify_crm.sql               ← 전 항목 ✓ 확인
```

**③이 왜 선행 필수인가.** 기존 `apply_attendance` 는 `이름+수강권명+연락처` 3열로만
매칭했다. 그런데 2026-08 `KEY_COLS` 개정 이후 **같은 사람의 같은 수강권 재등록 건이 각각 별개
행으로 남는다**(실측: 이가원 `언리미티드(판교) 30회` 19행). 그래서 옛 RPC 는 그 19행을 전부
같은 값으로 덮어써 `used_count` 합을 망가뜨렸다 — **마일스톤 규칙의 입력값이 통째로 틀어진다.**
v2 는 입력 1건당 members 1행만 고른다(수강권시작일 정확 일치 → 최신 등록건 순).

### 1-2. 슬랙 앱

1. <https://api.slack.com/apps> → **Create New App** → From scratch → 워크스페이스 선택
2. **OAuth & Permissions** → Bot Token Scopes 에 `chat:write`, `chat:write.public` 추가
3. **Install to Workspace** → `xoxb-…` 로 시작하는 **Bot User OAuth Token** 복사
4. 지점 채널 6개 + 운영 채널 1개를 만들고 **채널 ID** 를 복사
   (채널 이름 우클릭 → 링크 복사 → 끝의 `C0123ABCD`. 채널 세부정보 맨 아래에도 있다)
   > ⚠️ **이름(`#광교`)이 아니라 ID(`C0123ABCD`)** 를 쓴다. 이름은 바뀌면 조용히 실패하고,
   > 그러면 그 지점만 CRM 이 끊긴 채 아무도 모른다.
5. **비공개 채널**이면 그 채널에서 `/invite @봇이름` 으로 봇을 초대해야 한다
   (공개 채널은 `chat:write.public` 덕분에 초대 없이 보낼 수 있다).

### 1-3. GitHub Secrets (Settings → Secrets and variables → Actions)

| 이름 | 값 |
|---|---|
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | 관리자 계정 — **비밀** |
| `STUDIOMATE_PHONE` / `STUDIOMATE_PASSWORD` | ⚠️ 이메일이 아니라 **휴대폰 번호**로 로그인한다 |
| `SLACK_BOT_TOKEN` | `xoxb-…` |
| `SLACK_CHANNEL_CHEONGDAM` … `SLACK_CHANNEL_SONGPA` | 지점 채널 **ID** (6개) |
| `SLACK_CHANNEL_OPS` | 실패 알림 채널 **ID** |

`SUPABASE_URL` / `SUPABASE_ANON_KEY` 는 공개값이고 `automation/config.mjs` 에 기본값이 있어
생략해도 된다. `SM_SLUG_*` 도 마찬가지(공개 서브도메인) — 다른 스튜디오로 옮길 때만 쓴다.

### 1-4. 사이트 구조 (2026-08-10 실측)

**⚠️ 사이트와 지점이 1:1 이 아니다.**

| 사이트 | 지점 |
|---|---|
| `everybarre.studiomate.kr` | **청담 + 판교** (일간·룸별 뷰의 룸 컬럼이 지점) |
| `everybarre-gwanggyo` | 광교 |
| `everybarre-oksu` | 옥수 |
| `everybarre-banpo` | 반포 |
| `everybarre-songpa` | 송파 |

그래서 스크랩 단위는 "지점"이 아니라 **"사이트"**(`config.mjs` 의 `SITES`)이고,
각 예약행의 지점은 **수강권명에서 뽑는다**(`branchOf` — CLAUDE.md "지점은 수강권명 안에 있다").
수강권명에 지점 태그가 없으면 사이트의 `defaultBranch` 로 폴백한다.
사이트마다 세션이 따로라 **사이트별로 각각 로그인**한다(쿠키가 서브도메인 간 공유되지 않는다).

### 1-5. 스크래퍼 셀렉터

`automation/studiomate/selectors.mjs` **한 파일만** 고치면 된다. `scrape.mjs` 는 흐름만 담당하고
셀렉터를 전혀 모른다. 2026-08-10 기준으로 이미 실제 값이 채워져 있다.

화면 흐름:

```
/schedule (일간·룸별)  →  .event-item 클릭  →  /lecture/detail?id=…  →  뒤로
```

- **날짜는 URL 쿼리(`?date=`)로 못 바꾼다 — 무시된다.** 좌/우 화살표로만 이동하며,
  `gotoDate()` 가 현재 날짜를 읽어 목표까지 한 칸씩 이동하고 매번 검증한다.
- **수업 상세 한 페이지에 필요한 게 전부 있다** — 이름·연락처·수강권명·잔여횟수·수강권기간·
  예약상태. 회원 상세 모달에 따로 들어가지 않는다.
- **전체횟수는 화면 어디에도 없다**("12회 남음"만). 그래서 스크래퍼는 전체횟수를 빈 값으로
  보내고 `apply_attendance` v2 가 `coalesce` 로 DB 기존 값을 유지한다. 전체횟수는 등록 시점
  확정값이고 주간 엑셀 재업로드로 교정되므로 매일 갱신할 필요가 없다.
- 예약상태는 텍스트가 아니라 **readonly `input` 의 value** 다(Element UI 셀렉트).
  화면 원문: `예약` · `예약 확정` · `예약 대기 (1)` · `출석` · `결석`
  → `normStatus` 가 `예약 / 예약대기 / 출석 / 결석 / 노쇼 / 취소` 로 접는다.
- 예약자 행은 반드시 `li.members-list-item` 으로 잡는다 — `li` 만 쓰면 상태 드롭다운 옵션까지
  잡혀서 11명짜리 수업이 55개가 된다.

### 예약대기 (2026-08-12 실측 · 27개 수업 전수 확인)

수업 상세의 회원 목록은 **한 덩어리가 아니다.**

```
div.lecture-members
  h5 "예약회원 (11명)"                                  ← N
  div.lecture-members__list > ul > li.members-list-item   예약자
  h5 "예약 대기 회원 (2명)"                              ← M (대기자가 있을 때만 있음)
  div.lecture-members__list > ul > li.members-list-item   대기자 (별도 ul)
  h5 "예약 취소"                                         (표본 27개에선 행이 0개였다)
```

- 🔥 **라벨 N ≠ `li` 수.** 정확한 불변식은 **`count(li:not(.uncounted)) == N + M`** 이다.
  - **결석 행에는 `uncounted` 클래스가 붙고 라벨 N 에서 빠진다** (결석 ⇔ `uncounted` 1:1, 예외 0건).
  - 대기자는 자기 라벨 M 으로 따로 센다.
  - 이걸 몰라서 만석 수업이 "화면은 10명인데 11명이 읽혔습니다"로 실패했다.
- 대기자 `li` 에는 **구분용 클래스가 없다** — 예약자와 똑같다. 구분은 예약상태 값으로만 한다.
- 대기자는 `reservations` 에 `예약상태='예약대기'` 로 **남기고**, CRM 대상에서만 뺀다
  (`shared/crm-rules.mjs` 의 `NOT_ATTENDING`). 대기자에게 "내일 봬요" 멘트가 나가면 안 된다.
- ✅ **대기 → 출석 전이는 다음날 스스로 확인된다.** 대기자와 확정자는 `res_key` 가 같아서,
  승격돼 수업에 들어가면 D-1 스크랩이 같은 행을 `예약대기 → 출석` 으로 덮는다.
  (실측: 8/13 20:00 수업에서 몇 시간 새 예약 10→11 · 대기 2→1 로 승격이 일어났다.)
  그래서 `save_reservations` 의 `on conflict` 는 `예약대기` 를 `예약` 과 같은 **미확정**으로 본다.
- 실행 로그에 `· 그중 예약대기 N명(CRM 제외)` 이 찍힌다 — 몇 명이 빠졌는지 매일 보인다.

```bash
# 창을 띄워 놓고 직접 확인
HEADLESS=false ONLY_BRANCHES=광교 DRY_RUN=true node automation/run.mjs
```

셀렉터 값은 문자열(CSS), 함수(`async (scope) => string`), `null`(아직 모름) 셋 다 된다.
`null` 이면 그 필드만 비고 실행 요약에 `못 읽은 필드` 경고가 뜬다.

---

## 2. 검증 순서 (이 순서를 건너뛰지 말 것)

```bash
# ① 규칙 경계값 회귀 테스트 (수 초, DB 불필요)
npm run test:rules

# ② MOCK 으로 전 파이프라인 — 스튜디오메이트 없이
cp automation/mock.example.json automation/mock.local.json
MOCK_FILE=automation/mock.local.json MOCK_DATE=2026-08-05 DRY_RUN=true node automation/run.mjs
#   → 콘솔에 슬랙 메시지 전문이 그대로 찍힌다. 문구를 여기서 검수한다.

# ③ 실제 스크랩 + dry-run (셀렉터 채운 뒤, 한 지점만)
ONLY_BRANCHES=광교 DRY_RUN=true node automation/run.mjs

# ④ 반영 — MOCK 으로 먼저
MOCK_FILE=automation/mock.local.json DRY_RUN=false node automation/run.mjs
#   그리고 **한 번 더 실행**해서 행 수가 안 늘어나는지(멱등) 확인한다.
```

`DRY_RUN=true` 는 **전 단계 읽기 전용**이다 — `members`·`reservations`·`crm_messages` 저장과
슬랙 발송을 모두 하지 않는다. 슬랙만 따로 막으려면 `SLACK_DRY_RUN=true`.

> `DRY_RUN=1` / `yes` / 오타 같은 값은 **에러로 멈춘다.** 예전 코드는 그런 값을 조용히
> `true`(= 아무것도 안 함)로 읽어서, 밤새 아무 일도 안 일어났는데 아침에 초록불만 남았다.

---

## 3. 운영 전환

1. `workflow_dispatch` + `dry_run=true` 로 **3~5일** 수동 실행
   - `자동화 로그` 화면에서 지점×날짜 매트릭스에 빈칸이 없는지
   - 미매칭률이 5% 이하인지 (목표 매칭 ≥95%)
   - 슬랙 프리뷰 문구가 어색하지 않은지
2. `dry_run=false` 로 수동 1회 → 실제 슬랙 메시지 확인
3. `.github/workflows/daily-update.yml` 의 `schedule` 주석 해제

`schedule` 실행은 `DRY_RUN=false`(반영)로 **명시 분기**되어 있다 — `inputs` 폴백에 의존하지 않는다.

---

## 4. 장애 대응

| 증상 | 원인 / 조치 |
|---|---|
| `자동화 로그`의 마지막 실행이 24시간 초과(빨강) | 워크플로 실패 또는 schedule 미해제. Actions 탭 확인 |
| 지점×날짜 매트릭스에서 특정 지점만 계속 빈칸 | 그 지점 slug 오류 또는 화면 구조 변경. `ONLY_BRANCHES=그지점 DRY_RUN=true` 로 재현 |
| 전 지점 0건 | **로그인 실패**일 가능성이 높다. run.mjs 가 이 경우 fatal 로 멈추고 알린다 |
| 미매칭이 급증 | 스튜디오메이트 수강권명 표기가 바뀐 것. 주간 엑셀 재업로드로 대부분 해소 |
| 슬랙 `channel_not_found` | 채널 ID 오타 또는 채널 삭제 |
| 슬랙 `not_in_channel` | 비공개 채널인데 봇 미초대 → `/invite @봇이름` |
| 21:00 실행이 실패 | **재실행이 안전하다.** 모든 단계가 멱등이고, 슬랙은 새 메시지가 아니라 기존 메시지를 `chat.update` 한다 |
| 특정 날짜만 다시 돌리고 싶다 | `TARGET_DATE=2026-08-06`, 부분 실행은 `STEPS=roster,crm,slack` |

---

## 5. CRM 규칙

| 규칙 | 판정 | 슬랙 | 재발송 |
|---|---|---|---|
| `milestone` 마일스톤 | **전 지점 합산** 누적 사용횟수 + 그날 회차 ∈ `[10,30,50,100,150,200,300,500]` | ✅ | 평생 1회 |
| `trial` 체험 | 수강권명에 '체험' | ✅ | 매번 |
| `first-paid` 신규 등록 첫 수업 | 체험 이력 있음 + 유료 수강권 사용 0회 | ✅ | 평생 1회 |
| `expiring` 만료 임박 | 종료일 7일 이내 **AND** 잔여 ≥ 전체의 30% → "이월 가능" 안내 | ✅ | 7일 |
| `dormant-14` 14일 미방문 | 마지막 출석 후 14일 이상 + 잔여>0 + 기간 남음 | ❌ 대시보드 명단만 | — |

숫자·문구·활성 여부는 전부 **CRM 성과 화면 → 규칙별 성과 → 템플릿 편집**에서 배포 없이 고친다.
바꾼 내용은 **다음 실행(21:00)부터** 반영되고, 이미 보낸 메시지는 바뀌지 않는다.

**도입 초기 14일** 은 `14일 미방문` 규칙이 자동으로 잠긴다. 예약 스냅샷이 없어 "한 번도 안 온
사람"과 "아직 관측 안 된 사람"을 구분할 수 없기 때문이다. 화면에 관측 일수 배너가 뜨고,
관측 이력이 없는 회원은 "미방문"이 아니라 **"모름"** 으로 표기된다.

---

## 6. 개인정보 원칙

- **슬랙에는 이름 + 수업 정보까지만.** 연락처·생년월일·결제금액은 절대 넣지 않는다
  (채널 인원이 회원 DB 접근 권한자보다 넓다).
- **운영 알림(#ops)에는 건수와 단계만.** 미매칭 로그에는 실명이 섞인다.
- `automation/out/*.json` 은 회원 실명을 담는다 — 커밋 금지, **artifact 업로드 금지**.
- 미매칭 명단 화면에 CSV 내보내기 버튼을 두지 않는다.
- 슬랙은 **발송 전용**이다. 인터랙션(버튼) 엔드포인트를 만들지 않는다 — 서버를 도입하면
  정적 export + RLS 보안 모델이 통째로 바뀐다.

---

## 7. 파일 지도

```
shared/crm-core.mjs      순수 함수(동일인 판정·횟수·날짜). import 0개. 앱·자동화 공용
shared/crm-rules.mjs     규칙 엔진. DB·네트워크 접근 0. node --test 로 검증
automation/
  config.mjs             환경변수 + 지점(slug·슬랙채널) + preflight
  run.mjs                오케스트레이터
  studiomate/selectors.mjs   ⚠️ 화면이 바뀌면 여기만 고친다
  studiomate/scrape.mjs      흐름(셀렉터를 모른다)
  studiomate/normalize.mjs   원문 → DB 형태
  db.mjs · crm.mjs · slack.mjs · notify.mjs
  test/rules.test.mjs
sql/2026-08_apply_attendance_v2.sql · 2026-08_crm.sql · 2026-08_verify_crm.sql
lib/crm.ts               앱용 상수·타입·헬퍼
components/categories/Crm.tsx · CrmReport.tsx · Automation.tsx
```
