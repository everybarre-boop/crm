/* ============================================================================
   에블바레 공용 순수 함수 — 앱(lib/)과 자동화(automation/)가 **같은 공식**을 쓰기 위한 모듈
   ----------------------------------------------------------------------------
   ⛔️ 이 파일에는 import 문이 하나도 없어야 한다. (의존성 0, 순수 함수만)
      · 앱 번들에 supabase/react 가 딸려 들어가지 않는다
      · automation(.mjs)이 lib/*.ts 를 거치지 않고 그대로 import 할 수 있다
        → CLAUDE.md 의 격리 규칙("automation 은 app/·components/·lib/ 를 import 하지 않는다")을
          문구 그대로 지키면서 공식을 공유한다
      · 검사: grep -n "^import\|require(" shared/*.mjs  → 결과가 비어야 한다

   왜 공유하나 — `makePersonResolver` 는 단순한 "이름+연락처"가 아니다. 연락처가 빈 행을
   보수적으로 처리하고 동명이인을 행 단위로 쪼갠다. 이 공식을 SQL 이나 자동화 쪽에 다시
   구현하면 "코드가 만드는 값 ↔ DB 가 만드는 값"이 어긋난다 — 이 저장소가 dedup_key 로
   두 번 겪은 사고다(CLAUDE.md 참고). 그래서 구현은 여기 한 곳에만 둔다.

   타입은 shared/crm-core.d.mts 에 손으로 유지한다(tsconfig 의 allowJs:false 유지).
   ============================================================================ */

export const KEY_SEP = String.fromCharCode(31); // Unit Separator

/* ----------------------------------------------------------------------
   지점 — 별도 컬럼이 아니라 수강권명 안에 들어있다. (예: "체험권(광교)")
   그래서 지점 필터는 수강권명 부분일치로 거른다: 서버는 .ilike, 클라이언트는
   matchesBranch(). dedup_key 는 이미 수강권명을 포함하므로 지점이 다르면
   자동으로 별개 행이 되고, 지점을 KEY_COLS 에 따로 넣을 필요가 없다.
   ---------------------------------------------------------------------- */
export const BRANCHES = ['청담', '옥수', '광교', '반포', '판교', '송파'];
export const BRANCH_SRC_COL = '수강권명';

export function matchesBranch(rec, branch) {
  if (!branch) return true;
  return String(rec[BRANCH_SRC_COL] ?? '').includes(branch);
}

/** 수강권명에서 지점을 추론한다. 못 찾으면 ''. (자동화의 지점 분류에 쓴다) */
export function branchOf(수강권명) {
  const s = String(수강권명 ?? '');
  return BRANCHES.find((b) => s.includes(b)) ?? '';
}

/* ----------------------------------------------------------------------
   수강권 종류 = 수강권명에서 지점 꼬리표를 뗀 이름.
   예) "바레 그룹 40회 (광교)" → "바레 그룹 40회"
       "(광교) instructor course" → "instructor course"
   ---------------------------------------------------------------------- */
export function ticketType(수강권명) {
  let s = String(수강권명 ?? '');
  for (const b of BRANCHES) {
    s = s.replace(new RegExp('[（(][^（()）]*' + b + '[^（()）]*[)）]', 'g'), ' ');
  }
  return s.replace(/\s+/g, ' ').trim() || '(없음)';
}

// 체험 등록건: 수강권명에 "체험"이 들어있으면 체험으로 본다.
export function isTrial(rec) {
  return String(rec[BRANCH_SRC_COL] ?? '').includes('체험');
}

/* ----------------------------------------------------------------------
   1인 식별 — 이름 + 연락처(숫자만). 스튜디오메이트 매칭·회원별 집계의 기준.
   '010-1234-5678' 이든 '01012345678' 이든 같은 사람으로 묶인다.
   ---------------------------------------------------------------------- */
export function phoneDigits(v) {
  return String(v ?? '').replace(/[^0-9]/g, '');
}

/* ----------------------------------------------------------------------
   이름에 붙는 임시 표식 제거 — 사람 식별의 전처리.

   🔥 표식은 **운영 중에 붙었다 떼어진다** — 즉 같은 사람의 이름이 시점에 따라 달라진다.
      그대로 두면 personKey 가 갈려 한 사람이 둘로 세어진다:
        · 전 지점 합산 누적 사용횟수가 쪼개져 **마일스톤 회차가 틀린다**
        · 마지막 출석이 다른 사람 것으로 잡혀 **휴면(14일 미방문) 판정이 어긋난다**
        · 슬랙 멘트에 "손정미 미수금님, …" · "이유나 촬영X님, …" 으로 나간다

   실측 표식(2026-08-13 · 전 지점 엑셀 18,175행 · 고유 이름 5,555개 기준):
     · 미수금 계열   77명  "손정미 미수금" · "이지은 미수금P" · "조윤서미수금p" · "… 전액미수금"
                          결제 전 임시 발급 표식. 결제되면 지워진다.
     · 기수 계열    319명  "○○○ 15기" · "○○○ M1 13기" · "○○○ M2 2기"
                          강사 양성과정 기수. 과정 등록/수료 시점에 붙고 떼어진다.
     · 촬영 계열     25명  "○○○ 촬영X" · "○○○ 촬영x" · "○○○ 촬영 X"
                          촬영 동의 여부. 회원이 의사를 바꾸면 달라진다.

   ⚠️ 떼고 나서 이름이 비면 **원본을 그대로 둔다** — 과잉 정규화로 사람을 잃지 않기 위함.
      "체험1" · "체험2" 처럼 이름 전체가 표식인 자리 계정이 실재한다.
   ⚠️ '체험'은 **떼지 않는다.** 이름 전체가 "체험1/체험2/체험3"인 자리 계정이 있고,
      "○○○ 체험" 과 구분할 안전한 규칙이 없다. 잘못 떼면 서로 다른 자리 계정이 하나로 뭉친다.
   ⚠️ 낱글자 'D' · 'P' 표식(23명)도 **떼지 않는다.** 뜻이 확인되지 않았는데, 만약 같은
      연락처를 쓰는 다른 가족을 구분하는 표식이라면 떼는 순간 **두 사람이 한 명으로 뭉친다.**
      뜻이 확인되면 그때 추가할 것 — 조용히 틀리는 쪽으로 기울지 않는다.
   ⚠️ SQL 쪽 짝은 public.norm_person_name() 이다(sql/2026-08_name_normalize.sql).
      한쪽만 고치면 "코드가 만드는 값 ↔ DB 가 만드는 값"이 어긋난다 — 둘 다 고칠 것.
   ---------------------------------------------------------------------- */
const NAME_MARKERS = [
  // 미수금 / 전액미수금 / 미수금P — 앞뒤 공백 없이 붙는 표기도 있다("조윤서미수금p")
  /\s*(전액)?\s*미수금\s*[Pp]?/g,
  // 15기 · M1 13기 · M2 2기 — 숫자를 요구해서 이름의 '기'(예: '정기')를 건드리지 않는다
  /\s*(?:M\s*\d+\s*)?\d+\s*기(?=\s|$)/g,
  // 촬영X · 촬영x · 촬영 X — 한국어 이름에 '촬영'이 들어가는 경우는 없다
  /\s*촬영\s*[XxOo]?(?=\s|$)/g,
];

export function normPersonName(name) {
  const raw = String(name ?? '').trim();
  let cleaned = raw;
  for (const re of NAME_MARKERS) cleaned = cleaned.replace(re, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  return cleaned || raw;
}

export function personKey(rec) {
  return normPersonName(rec['이름']) + KEY_SEP + phoneDigits(rec['연락처']);
}

/* ----------------------------------------------------------------------
   동일인 판정 — 지점이 달라도 이름+연락처가 같으면 한 사람으로 합친다.
   (판교 이가원 · 반포 이가원 · 옥수 이가원 → 한 사람으로 묶여 사용횟수가 전 지점 합산)

   personKey() 만 쓰면 **연락처가 빈 행이 별개 인물로 쪼개진다**(실측 385행 · 112명).
   그래서 전체 행을 한 번 훑어 이름별 연락처 목록을 만들고:
     · 연락처가 있으면      → 이름+연락처
     · 연락처가 비었고 그 이름의 연락처가 **딱 하나뿐**이면 → 그 사람으로 붙인다
     · 그 이름에 연락처가 **하나도 없으면** → 이름으로 묶는다(다른 사람이라는 근거가 없다)
     · 그 이름에 연락처가 **여럿이면(동명이인)** → 판정 불가 → 행마다 따로 센다

   ⚠️ 마지막 규칙이 중요하다. 판정 불가 행을 전부 `이름+''` 하나로 보내면
      **서로 다른 사람이 한 명으로 뭉친다** — 연락처 없는 '김민정' 5행이 각 30회면
      가짜 1명이 150회가 되어 "100회 이상" 필터에 걸리고, 총회원은 5명이 1명이 된다.
      쪼개는 기준은 dedup_key → 없으면 행 객체별 일련번호(같은 조회 안에서만 유효).
      **집계용 조회에는 되도록 dedup_key 를 select 에 포함시킬 것.**

   사용법: const keyOf = makePersonResolver(memberRows, salesRows); keyOf(rec)
   ---------------------------------------------------------------------- */
export function makePersonResolver(...rowSets) {
  const phonesByName = new Map();
  for (const rows of rowSets) {
    if (!rows) continue;
    for (const r of rows) {
      const name = normPersonName(r['이름']);
      if (!name) continue;
      const ph = phoneDigits(r['연락처']);
      if (!ph) continue;
      let set = phonesByName.get(name);
      if (!set) phonesByName.set(name, (set = new Set()));
      set.add(ph);
    }
  }
  // 판정 불가 행에 줄 일련번호(dedup_key 가 없을 때만). 행 객체 기준이라 같은 행을
  // 여러 번 물어봐도 같은 키가 나온다.
  const fallbackIds = new WeakMap();
  let fallbackSeq = 0;
  return (rec) => {
    const name = normPersonName(rec['이름']);
    const ph = phoneDigits(rec['연락처']);
    if (ph) return name + KEY_SEP + ph;
    const set = phonesByName.get(name);
    if (set && set.size === 1) return name + KEY_SEP + [...set][0]; // 유일하니 그 사람으로
    if (!set) return name + KEY_SEP + ''; // 이 이름엔 연락처가 아예 없다 → 이름으로 묶는다
    // 동명이인 + 연락처 빈 행 — 누구인지 알 수 없으므로 다른 사람과 절대 합치지 않는다.
    const dk = String(rec['dedup_key'] ?? '');
    if (dk) return name + KEY_SEP + '?' + KEY_SEP + dk;
    let id = fallbackIds.get(rec);
    if (!id) fallbackIds.set(rec, (id = '#' + ++fallbackSeq));
    return name + KEY_SEP + '?' + KEY_SEP + id;
  };
}

/* ----------------------------------------------------------------------
   등록일 대체 — 예약사이트 내보내기에 `등록일` 컬럼이 없어(2026-07-21 이후) DB 전 행이
   빈 값이다. 기간별 집계가 통째로 0이 되므로, 없으면 `수강권시작일`을 쓴다.
   ---------------------------------------------------------------------- */
export function regDate(rec) {
  const v = String(rec['등록일'] ?? '').trim();
  return v || String(rec['수강권시작일'] ?? '').trim();
}

/* ======================================================================
   숫자 파싱 · 사용횟수
   "3", "3회", " 3 " 처럼 텍스트로 저장된 횟수에서 정수만 뽑는다.
   DB 의 used_count 생성 컬럼과 같은 규칙(숫자 외 문자 제거).
   ====================================================================== */
export function toInt(v) {
  if (v == null) return 0;
  const n = parseInt(String(v).replace(/[^0-9-]/g, ''), 10);
  return isNaN(n) ? 0 : n;
}

// 사용횟수 = 전체횟수 − 잔여횟수. ⚠️ 이건 "수강권 1건짜리" 값이다(사람 합계가 아님).
export function usedCount(rec) {
  return toInt(rec['전체횟수']) - toInt(rec['잔여횟수']);
}

/* ----------------------------------------------------------------------
   🔥 사람 단위 누적 사용횟수 — **행을 그냥 더하면 안 된다.**

   members 의 한 행은 "사람"도 "수강권"도 아니고 **(수강권 등록건 × 결제건 × 그때의 이름)**
   이다. 같은 수강권 한 장이 여러 행으로 남는 경로가 실재한다:
     ① 이름 표식   '구태희' / '구태희 미수금' — 표식이 붙었다 떼어지는 사이에 업로드하면
                    dedup_key 의 `이름`이 달라 **행이 둘** 생긴다(makePersonResolver 는
                    이 둘을 한 사람으로 합친다 → 합치는 순간 같은 수강권이 두 번 세어진다).
     ② 결제 분할   미수금 완납·추가 결제로 `결제일시/결제금액`이 다른 행이 또 생긴다.
                    KEY_COLS 에 결제 컬럼이 있어서(2026-08 개정) 이건 설계상 정상이다.
   ⚠️ 이 행들은 **같은 잔여횟수를 각자 들고 있다.** 그래서 `Σ (전체−잔여)` 를 하면
      한 번 나온 수업이 2~3번 세어진다.

   실측 사고(2026-08-14 반포): 구태희 — 체험권 2행(표식 중복) + 20회권 3행(표식·결제 중복).
     행 합계 1+1+1+3+3 = 9 → "내일이 10회차" 로 슬랙 발송. **실제 출석은 4회.**
     등록건 기준으로 접으면 체험 1 + 20회권 3 = 4 로 실제와 일치한다.
     같은 날 발송된 마일스톤 5건 중 3건이 이 오차였다(전 회원 583명이 부풀려져 있었다).

   그래서: **"수강권 등록건"(수강권명 + 수강권시작일) 하나에 대표 행 1개**만 남기고,
   대표 행끼리 더한다. 재등록(같은 수강권명 + 다른 시작일)은 별개 등록건이므로 그대로 더해진다.
   대표 행은 **사용횟수가 가장 큰 행** — 출석은 되돌아가지 않으므로 가장 최근 상태이고,
   apply_attendance v2 가 중복 행 중 1행만 갱신한다는 사실과도 맞는다(나머지는 옛 잔여를 든다).
   ---------------------------------------------------------------------- */
export function ticketKey(rec) {
  return String(rec['수강권명'] ?? '').trim() + KEY_SEP + String(rec['수강권시작일'] ?? '').trim();
}

/** 수강권 등록건별 대표 행 1개만 남긴다. (사용횟수 최대 → 같으면 최신 등록건) */
export function dedupeTicketRows(rows) {
  const best = new Map();
  for (const r of rows || []) {
    const k = ticketKey(r);
    const prev = best.get(k);
    if (!prev) {
      best.set(k, r);
      continue;
    }
    const a = usedCount(r);
    const b = usedCount(prev);
    if (a > b || (a === b && pickTicketRow([prev, r]) === r)) best.set(k, r);
  }
  return [...best.values()];
}

/* 사람 단위 사용횟수 감사(監査) — 값 하나와 "그 값을 믿어도 되는지"를 같이 낸다.
   마일스톤처럼 **사실을 단언하는 멘트**는 결손이 하나라도 있으면 보내지 않는다.
     누적       등록건별 대표 행의 사용횟수 합 (음수는 0으로 바닥 — 아래 참고)
     등록건수   서로 다른 (수강권명, 수강권시작일) 수
     행수       원본 행 수 (행수 > 등록건수 면 중복 행이 있었다는 뜻)
     결손       전체횟수가 빈 등록건 수 — "몇 회짜리인지"를 모르면 사용횟수도 모른다
                (실측 152행. toInt('')=0 이라 그냥 두면 사용횟수가 **음수**로 나온다)
     시작일결손 수강권시작일을 못 읽은 등록건 수 — 등록건을 구분할 수 없다
     최초시작일 yyyymmdd 정수. 예약 스냅샷이 이 사람의 전 이력을 덮는지 판단하는 근거 */
export function usageAudit(rows) {
  const list = rows || [];
  const tickets = dedupeTicketRows(list);
  let 누적 = 0;
  let 결손 = 0;
  let 시작일결손 = 0;
  let 최초시작일 = null;
  for (const t of tickets) {
    if (String(t['전체횟수'] ?? '').trim() === '') 결손++;
    else 누적 += Math.max(0, usedCount(t));
    const d = ymdNum(t['수강권시작일']);
    if (d === null) 시작일결손++;
    else if (최초시작일 === null || d < 최초시작일) 최초시작일 = d;
  }
  return { 누적, 등록건수: tickets.length, 행수: list.length, 결손, 시작일결손, 최초시작일 };
}

/** 사람 단위 누적 사용횟수. 화면·집계는 이걸 쓴다(행 단위 Σ usedCount 금지). */
export function personUsedCount(rows) {
  return usageAudit(rows).누적;
}

/* ----------------------------------------------------------------------
   텍스트 날짜 파싱. 다양한 표기를 관대하게 처리한다:
   "2026-07-16", "2026. 7. 16.(목)", "2026/7/16 14:30" 모두 인식.
   ⚠️ ymdNum 의 정규식은 sql/2026-08_apply_attendance_v2.sql 의
      public.ymd_num() 과 **같은 공식**이다. 한쪽만 바꾸지 말 것.
   ---------------------------------------------------------------------- */
export function ymKey(dateStr) {
  const m = String(dateStr ?? '').match(/(\d{4})\D+(\d{1,2})/);
  if (!m) return '';
  return `${m[1]}-${m[2].padStart(2, '0')}`;
}

export function ymdNum(dateStr) {
  const m = String(dateStr ?? '').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!m) return null;
  return Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]);
}

/** yyyymmdd 정수 → 'YYYY-MM-DD'. 못 만들면 ''. */
export function ymdText(n) {
  if (n == null || isNaN(Number(n))) return '';
  const v = Number(n);
  const y = Math.floor(v / 10000);
  const mo = Math.floor((v % 10000) / 100);
  const d = v % 100;
  if (!y || !mo || !d) return '';
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/* ----------------------------------------------------------------------
   KST 기준 날짜 — GitHub Actions 는 UTC 라 반드시 보정해야 한다.
   한국은 서머타임이 없으므로 UTC+9 고정으로 안전하다.
   dateKST(0) = 오늘, dateKST(-1) = 어제, dateKST(1) = 내일
   ---------------------------------------------------------------------- */
export function dateKST(offsetDays = 0, base = new Date()) {
  const kst = new Date(base.getTime() + (9 * 60 + offsetDays * 24 * 60) * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' + n일 → 'YYYY-MM-DD'. (UTC 로 계산해 타임존 영향 없음) */
export function addDays(ymd, n) {
  const v = ymdNum(ymd);
  if (v === null) return '';
  const d = new Date(Date.UTC(Math.floor(v / 10000), Math.floor((v % 10000) / 100) - 1, v % 100));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** a → b 까지의 일수(b - a). 둘 중 하나라도 날짜가 아니면 null. */
export function daysBetween(a, b) {
  const na = ymdNum(a);
  const nb = ymdNum(b);
  if (na === null || nb === null) return null;
  const utc = (n) =>
    Date.UTC(Math.floor(n / 10000), Math.floor((n % 10000) / 100) - 1, n % 100);
  return Math.round((utc(nb) - utc(na)) / 86400000);
}

/* ----------------------------------------------------------------------
   "지금 사용 가능한 수강권" 판정 = 잔여횟수 > 0 이고, 수강권종료일이 있으면 아직 안 지남.
   (현재 회원 = 이런 수강권을 하나라도 가진 사람.)
   today 는 Date 또는 'YYYY-MM-DD' 둘 다 받는다(자동화는 KST 문자열을 넘긴다).
   ---------------------------------------------------------------------- */
export function isUsableTicket(rec, today = new Date()) {
  if (toInt(rec['잔여횟수']) <= 0) return false;
  const end = ymdNum(rec['수강권종료일']);
  if (end !== null) {
    const todayNum =
      today instanceof Date
        ? today.getFullYear() * 10000 + (today.getMonth() + 1) * 100 + today.getDate()
        : ymdNum(today);
    if (todayNum !== null && end < todayNum) return false;
  }
  return true;
}

/* ----------------------------------------------------------------------
   같은 사람의 같은 수강권명이 여러 행일 때(재등록) 대표 1행 고르기.
   = "지금 쓰고 있는 최신 등록건". 정렬: 수강권시작일 desc → 결제일시 desc → dedup_key
   ⚠️ sql/2026-08_apply_attendance_v2.sql 의 _match_attendance 가 members 를 고르는
      순서와 같은 규칙이다(그쪽은 수강권시작일 정확일치를 한 단계 더 앞에 둔다).
   ---------------------------------------------------------------------- */
export function pickTicketRow(rows) {
  if (!rows || !rows.length) return null;
  let best = null;
  let bestRank = null;
  for (const r of rows) {
    const rank = [ymdNum(r['수강권시작일']) ?? -1, ymdNum(r['결제일시']) ?? -1];
    if (
      bestRank === null ||
      rank[0] > bestRank[0] ||
      (rank[0] === bestRank[0] && rank[1] > bestRank[1])
    ) {
      best = r;
      bestRank = rank;
    }
  }
  return best;
}

/* ======================================================================
   포맷 · 문자열
   ====================================================================== */
export function fmtNum(n) {
  if (n == null || n === '' || isNaN(Number(n))) return n == null ? '' : String(n);
  return Number(n).toLocaleString('ko-KR');
}

/* ----------------------------------------------------------------------
   멘트 템플릿 치환. `{{이름}}` `{{ 마일스톤 }}` 형태.
   ⚠️ vars 에 **없는** 키는 일부러 `{{키}}` 그대로 남긴다 — 편집 화면 미리보기에서
      오타(`{{잔여회수}}`)가 눈에 보이게 하기 위함이다. 값이 빈 문자열인 것과 구분된다.
   ---------------------------------------------------------------------- */
export function renderTemplate(tpl, vars) {
  const v = vars || {};
  return String(tpl ?? '').replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(v, key) ? String(v[key] ?? '') : whole,
  );
}

/** 슬랙 mrkdwn 이스케이프. 회원 이름에 특수문자가 있어도 파싱이 깨지지 않게. (& 를 먼저) */
export function slackEscape(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
