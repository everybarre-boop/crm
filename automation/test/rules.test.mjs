// ============================================================================
// CRM 규칙 경계값 테스트  —  node --test automation/test/
// ----------------------------------------------------------------------------
// 의존성 0(node:test 만). 규칙이 "정확히 경계에서" 켜지고 꺼지는지 고정한다.
// 규칙을 고칠 때 여기가 먼저 깨져야 한다 — 안 깨지면 테스트가 부족한 것이다.
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES, buildCrm, mergeRules, verifyMilestone } from '../../shared/crm-rules.mjs';
import {
  dedupeTicketRows,
  makePersonResolver,
  normPersonName,
  personKey,
  personUsedCount,
  usageAudit,
  usedCount,
  dateKST,
  daysBetween,
} from '../../shared/crm-core.mjs';

const TODAY = '2026-08-05';
const TOMORROW = '2026-08-06';

/** members 행 하나 만들기 */
function mem(o = {}) {
  return {
    dedup_key: o.dedup_key ?? Math.random().toString(36).slice(2),
    이름: '홍길동',
    연락처: '010-1111-2222',
    수강권명: '바레 그룹 20회 (광교)',
    전체횟수: '20',
    잔여횟수: '20',
    수강권시작일: '2026-07-01',
    수강권종료일: '2026-12-31',
    결제일시: '2026-07-01',
    ...o,
  };
}

/** 예약(roster) 행 하나 만들기 */
function resv(o = {}) {
  return {
    지점: '광교',
    예약일자: TOMORROW,
    수업시간: '10:00',
    수업명: '바레 그룹',
    강사: '김강사',
    이름: '홍길동',
    연락처: '010-1111-2222',
    수강권명: '바레 그룹 20회 (광교)',
    예약상태: '예약',
    ...o,
  };
}

function run(input) {
  return buildCrm({ today: TODAY, targetDate: TOMORROW, historyDays: 0, ...input });
}

/** 규칙 하나의 파라미터만 바꾼 rules 배열 (코드 기본값에서 파생) */
function rulesWith(id, 파라미터) {
  return mergeRules([]).map((x) =>
    x.id === id ? { ...x, 파라미터: { ...x.파라미터, ...파라미터 } } : x,
  );
}

const idsOf = (r) => r.messages.map((m) => m.rule_id).sort();
const one = (r, id) => r.messages.find((m) => m.rule_id === id);

/* ==========================================================================
   ① 마일스톤 — 누적 99 + 내일 1회 = 100 이면 켜지고, 98 이면 꺼진다
   ========================================================================== */
test('마일스톤: 예정회차가 정확히 100 이면 발동', () => {
  // 전체 120 · 잔여 21 → 사용 99
  const r = run({
    memberRows: [mem({ 전체횟수: '120', 잔여횟수: '21' })],
    rosterRows: [resv()],
  });
  const m = one(r, 'milestone');
  assert.ok(m, '100회차인데 마일스톤이 안 잡혔다');
  assert.equal(m.규칙키, '100');
  assert.equal(m.근거.예정회차, 100);
  assert.match(m.멘트, /100회차/);
});

/* 🔥 2026-08-27 회귀 — 멘트가 "누적"을 1 높게 단언하던 자리.
   옛 렌더: `*100회차!* (누적 100회)` ← 그 시점 members 누적은 99 라, 강사가 스튜디오메이트와
   대조하면 항상 정확히 1 이 부족했다(전 지점 발송 21건 전부 재현).
   회차 안내는 **사실 단언**이므로, 화면에 적히는 수는 members 에 실제로 있는 수여야 한다. */
test('마일스톤: 멘트의 누적은 내일 수업을 뺀 실제 값이다 (예정회차로 덮지 않는다)', () => {
  const r = run({
    memberRows: [mem({ 전체횟수: '120', 잔여횟수: '21' })], // 사용 99 → 예정 100
    rosterRows: [resv()],
  });
  const m = one(r, 'milestone');
  assert.ok(m);
  assert.equal(m.근거.누적횟수, 99, '근거의 누적이 예정회차로 덮였다');
  assert.match(m.멘트, /지금까지 99회/, '멘트가 members 에 없는 누적을 단언한다');
  assert.ok(!/누적 100회/.test(m.멘트), '옛 오류 재발 — 아직 오지 않은 수업을 누적에 넣었다');
  assert.match(m.예시멘트, /이번 수업이 100번째/);
});

test('마일스톤: 예정회차 99 는 발동하지 않는다 (소급 한도 밖)', () => {
  // 사용 98 → 예정 99. 가장 가까운 마일스톤 50 과의 차이가 소급한도(10)를 넘는다.
  const r = run({
    memberRows: [mem({ 전체횟수: '120', 잔여횟수: '22' })],
    rosterRows: [resv()],
  });
  assert.equal(one(r, 'milestone'), undefined);
});

/* 소급은 기본 꺼져 있다 — 켜면 "오늘로 100번째 수업이에요"가 누적 105회 회원에게 나가
   **사실과 다른 문장**이 된다(2026-08-10 실측에서 4건 중 3건이 이 상태였다). */
test('마일스톤: 이미 지난 마일스톤은 소급하지 않는다 (기본)', () => {
  // 사용 104 → 예정 105. 100 을 지났지만 소급허용=false 라 발동하지 않는다.
  const r = run({
    memberRows: [mem({ 전체횟수: '120', 잔여횟수: '16' })],
    rosterRows: [resv()],
  });
  assert.equal(one(r, 'milestone'), undefined);
});

test('마일스톤: 소급허용을 켜면 한도 안에서 소급된다', () => {
  const rules = DEFAULT_RULES.map((x) =>
    x.id === 'milestone' ? { ...x, 파라미터: { ...x.파라미터, 소급허용: true } } : x,
  );
  const r = run({
    memberRows: [mem({ 전체횟수: '120', 잔여횟수: '16' })],
    rosterRows: [resv()],
    rules,
  });
  const m = one(r, 'milestone');
  assert.ok(m, '소급허용=true 인데 안 걸렸다');
  assert.equal(m.규칙키, '100');
  assert.equal(m.근거.소급, true);
});

test('마일스톤: 전 지점 합산 — 판교 + 반포가 한 사람으로 묶인다', () => {
  const r = run({
    memberRows: [
      mem({ 수강권명: '바레 그룹 20회 (판교)', 전체횟수: '60', 잔여횟수: '10' }), // 50
      mem({ 수강권명: '바레 그룹 20회 (반포)', 전체횟수: '60', 잔여횟수: '11' }), // 49
    ],
    rosterRows: [resv({ 수강권명: '바레 그룹 20회 (판교)', 지점: '판교' })],
  });
  const m = one(r, 'milestone');
  assert.ok(m, '지점 합산(50+49=99 → 100회차)이 안 됐다');
  assert.equal(m.근거.누적횟수, 99);
});

test('마일스톤: 내일 수업이 2개면 가장 이른 수업 하나에만 붙는다', () => {
  const r = run({
    memberRows: [mem({ 전체횟수: '120', 잔여횟수: '21' })],
    rosterRows: [resv({ 수업시간: '19:00' }), resv({ 수업시간: '10:00' })],
  });
  const ms = r.messages.filter((m) => m.rule_id === 'milestone');
  assert.equal(ms.length, 1);
  assert.equal(ms[0].수업시간, '10:00');
});

/* ==========================================================================
   ② 억제 — 평생 1회. 단, 같은 날 재실행분은 억제 근거가 아니다
   ========================================================================== */
test('마일스톤 억제: 예전에 100회 멘트를 보냈으면 다시 안 보낸다', () => {
  const r = run({
    memberRows: [mem({ 전체횟수: '120', 잔여횟수: '21' })],
    rosterRows: [resv()],
    sentHistory: [
      { person_key: '홍길동\u001f01011112222', rule_id: 'milestone', 규칙키: '100', 대상일자: '2026-07-01' },
    ],
  });
  assert.equal(one(r, 'milestone'), undefined);
});

test('마일스톤 억제: 같은 날 재실행이면 메시지가 사라지면 안 된다 (멱등)', () => {
  const r = run({
    memberRows: [mem({ 전체횟수: '120', 잔여횟수: '21' })],
    rosterRows: [resv()],
    // 1차 실행에서 오늘(=targetDate) 발송된 이력. 이게 자기 자신을 억제하면 안 된다.
    sentHistory: [
      { person_key: '홍길동\u001f01011112222', rule_id: 'milestone', 규칙키: '100', 대상일자: TOMORROW },
    ],
  });
  assert.ok(one(r, 'milestone'), '재실행에서 마일스톤이 사라졌다 — 억제 조건의 대상일자 비교를 확인하라');
});

/* ==========================================================================
   ③ 체험 / 신규 등록 첫 수업
   ========================================================================== */
test('체험: 수강권명에 "체험"이 들어가면 발동 (members 에 없어도)', () => {
  const r = run({ memberRows: [], rosterRows: [resv({ 수강권명: '체험권 (광교)' })] });
  assert.ok(idsOf(r).includes('trial'));
});

test('신규: 체험 이력이 있고 유료 수강권을 아직 한 번도 안 썼으면 발동', () => {
  const r = run({
    memberRows: [
      mem({ 수강권명: '체험권 (광교)', 전체횟수: '1', 잔여횟수: '0' }),
      mem({ 수강권명: '바레 그룹 20회 (광교)', 전체횟수: '20', 잔여횟수: '20' }), // 사용 0
    ],
    rosterRows: [resv()],
  });
  assert.ok(one(r, 'first-paid'), '신규 등록 첫 수업이 안 잡혔다');
});

test('신규: 이미 한 번이라도 썼으면 발동하지 않는다', () => {
  const r = run({
    memberRows: [
      mem({ 수강권명: '체험권 (광교)', 전체횟수: '1', 잔여횟수: '0' }),
      mem({ 전체횟수: '20', 잔여횟수: '19' }), // 사용 1
    ],
    rosterRows: [resv()],
  });
  assert.equal(one(r, 'first-paid'), undefined);
});

test('신규: 체험 이력이 없으면 발동하지 않는다 (체험이력필수=true)', () => {
  const r = run({ memberRows: [mem()], rosterRows: [resv()] });
  assert.equal(one(r, 'first-paid'), undefined);
});

/* 실측 데이터에 "체험 후 1회권 (판교)" 가 있다 — 체험을 마치고 산 **유료** 수강권이다.
   이걸 체험으로 세면 체험 멘트가 잘못 나가고 신규 등록 첫 수업이 영영 안 걸린다. */
test('"체험 후 1회권" 은 체험이 아니라 신규 등록 첫 수업이다', () => {
  const r = run({
    memberRows: [
      mem({ 수강권명: '체험권 (판교)', 전체횟수: '1', 잔여횟수: '0', dedup_key: 't' }),
      mem({ 수강권명: '체험 후 1회권 (판교)', 전체횟수: '1', 잔여횟수: '1', dedup_key: 'p' }),
    ],
    rosterRows: [resv({ 수강권명: '체험 후 1회권 (판교)' })],
  });
  assert.equal(one(r, 'trial'), undefined, '"체험 후"는 체험 멘트 대상이 아니다');
  assert.ok(one(r, 'first-paid'), '"체험 후 1회권" 첫 수업은 신규 등록 멘트 대상이다');
});

test('순수 "체험권" 은 여전히 체험으로 잡힌다', () => {
  const r = run({ memberRows: [], rosterRows: [resv({ 수강권명: '체험권 (판교)' })] });
  assert.ok(one(r, 'trial'));
});

/* 실측: 누적 51회 회원이 새 수강권을 끊자 '신규 등록 첫 수업'으로 잡혔다.
   "이 수강권 첫 사용"만 보면 재등록한 기존 회원이 전부 신규가 된다. */
test('신규: 오래 다닌 회원의 재등록은 신규가 아니다 (최대누적 3회)', () => {
  const r = run({
    memberRows: [
      mem({ 수강권명: '체험권 (광교)', 전체횟수: '1', 잔여횟수: '0', dedup_key: 't' }),
      mem({ 수강권명: '바레 그룹 40회 (광교)', 전체횟수: '60', 잔여횟수: '10', dedup_key: 'old' }), // 50회 사용
      mem({ 수강권명: '바레 그룹 10회 (광교)', 전체횟수: '10', 잔여횟수: '10', dedup_key: 'new' }), // 미사용
    ],
    rosterRows: [resv({ 수강권명: '바레 그룹 10회 (광교)' })],
  });
  assert.equal(one(r, 'first-paid'), undefined);
});

/* 🔥 "앞으로 0회 같이 만들어가요" — 2026-08-13 dry-run 에서 실제로 나간 문구다.
   반포 '바레 그룹 언리밋권'·송파 '언리밋티드' 는 전체횟수가 비어 있다.
   언리밋은 30일권이라 횟수를 말하는 것 자체가 맞지 않는다. */
test('신규: 언리밋은 횟수를 말하지 않는 전용 문구로 나간다', () => {
  const r = run({
    memberRows: [
      mem({ 수강권명: '체험권 (반포)', 전체횟수: '1', 잔여횟수: '0', dedup_key: 't' }),
      mem({ 수강권명: '바레 그룹 언리밋권 (반포)', 전체횟수: '', 잔여횟수: '', dedup_key: 'u' }),
    ],
    rosterRows: [resv({ 수강권명: '바레 그룹 언리밋권 (반포)' })],
  });
  const m = one(r, 'first-paid');
  assert.ok(m, '언리밋 신규 등록이 안 잡혔다');
  assert.ok(!/0회/.test(m.예시멘트), `"0회" 가 문구에 남아 있다: ${m.예시멘트}`);
  assert.match(m.예시멘트, /언리밋 등록 대박이에요/);
  assert.equal(m.근거.언리밋, true);
});

/* 전체횟수가 30 으로 들어 있는 언리밋(청담·판교·옥수 1,100행)도 같은 문구를 쓴다 —
   "언리밋이라고 적힌 수강권"이 곧 30일권이라는 운영 정의를 따른다. */
test('신규: 전체횟수 30 인 언리밋도 언리밋 문구를 쓴다', () => {
  const r = run({
    memberRows: [
      mem({ 수강권명: '체험권 (청담)', 전체횟수: '1', 잔여횟수: '0', dedup_key: 't' }),
      mem({ 수강권명: '언리미티드(청담)', 전체횟수: '30', 잔여횟수: '30', dedup_key: 'u' }),
    ],
    rosterRows: [resv({ 수강권명: '언리미티드(청담)' })],
  });
  const m = one(r, 'first-paid');
  assert.ok(m);
  assert.match(m.예시멘트, /언리밋 등록 대박이에요/);
  assert.ok(!/30회/.test(m.예시멘트), '언리밋 문구에 횟수가 들어갔다');
});

/* ⛔️ 전체횟수가 없는데 언리밋도 아니면 **데이터 결손**이다(실측: '바레 그룹 10회(청담)'
   전체횟수 0 이 13행). 기본 문구면 "0회", 언리밋 문구면 거짓말이라 아예 안 보낸다. */
test('신규: 전체횟수 결손 + 언리밋 아님 → 멘트를 보내지 않고 경고를 남긴다', () => {
  const r = run({
    memberRows: [
      mem({ 수강권명: '체험권 (청담)', 전체횟수: '1', 잔여횟수: '0', dedup_key: 't' }),
      mem({ 수강권명: '바레 그룹 10회(청담)', 전체횟수: '', 잔여횟수: '', dedup_key: 'x' }),
    ],
    rosterRows: [resv({ 수강권명: '바레 그룹 10회(청담)' })],
  });
  assert.equal(one(r, 'first-paid'), undefined, '결손 데이터로 멘트가 나갔다');
  assert.ok(
    r.warnings.some((w) => w.includes('데이터 결손')),
    '건너뛴 사유가 경고에 안 남았다 — 조용히 사라지면 안 된다',
  );
});

/* DB(crm_rules)에 저장된 규칙 행에는 새로 추가한 파라미터 키가 없다.
   기본값으로 채우지 않으면 새 기능이 배포돼도 조용히 꺼진 채로 돈다. */
test('규칙 파라미터: DB 행에 없는 키는 코드 기본값으로 채운다', () => {
  const r = run({
    memberRows: [
      mem({ 수강권명: '체험권 (반포)', 전체횟수: '1', 잔여횟수: '0', dedup_key: 't' }),
      mem({ 수강권명: '바레 그룹 언리밋권 (반포)', 전체횟수: '', 잔여횟수: '', dedup_key: 'u' }),
    ],
    rosterRows: [resv({ 수강권명: '바레 그룹 언리밋권 (반포)' })],
    // 언리밋키워드·언리밋멘트가 **없는** 옛 DB 행을 흉내낸다
    rules: [
      {
        id: 'first-paid', 라벨: '신규 등록 첫 수업', 이모지: '✨', 활성: true, 슬랙발송: true,
        정렬순서: 30, 재발송억제일수: -1, 파라미터: { 체험이력필수: true, 최대누적: 3 },
        템플릿: '체험 후 등록하고 첫 수업 · {{수강권명}}',
        예시멘트: '{{이름}}님, 등록해 주셔서 반가워요! 앞으로 {{전체횟수}}회 같이 만들어가요 😊',
      },
    ],
  });
  const m = one(r, 'first-paid');
  assert.ok(m, '옛 DB 행에서 언리밋 분기가 동작하지 않았다');
  assert.ok(!/0회/.test(m.예시멘트), `"0회" 가 남았다: ${m.예시멘트}`);
});

/* ==========================================================================
   ⑧ 1인 1건 — 같은 사람에게 여러 규칙이 걸리면 가장 나중 단계 하나만
   ========================================================================== */
test('1인 1건: 마일스톤과 체험이 겹치면 마일스톤만 남는다', () => {
  const r = run({
    // 누적 9 (과거 유료권) + 내일 체험권 수업 → 10회차 마일스톤 & 체험 둘 다 후보
    memberRows: [
      mem({ 수강권명: '바레 그룹 40회 (광교)', 전체횟수: '40', 잔여횟수: '31', dedup_key: 'a' }),
      mem({ 수강권명: '체험권 (광교)', 전체횟수: '1', 잔여횟수: '1', dedup_key: 'b' }),
    ],
    rosterRows: [resv({ 수강권명: '체험권 (광교)' })],
  });
  assert.equal(r.messages.length, 1, '한 사람에게 두 건이 나갔다');
  assert.equal(r.messages[0].rule_id, 'milestone');
  assert.ok(r.warnings.some((w) => w.includes('1인 1건')));
});

test('1인 1건: 다른 사람끼리는 각자 받는다', () => {
  const r = run({
    memberRows: [
      mem({ 이름: 'A', 연락처: '010-1111-1111', 전체횟수: '40', 잔여횟수: '31', dedup_key: 'a' }),
      mem({ 이름: 'B', 연락처: '010-2222-2222', 수강권명: '체험권 (광교)', dedup_key: 'b' }),
    ],
    rosterRows: [
      resv({ 이름: 'A', 연락처: '010-1111-1111' }),
      resv({ 이름: 'B', 연락처: '010-2222-2222', 수강권명: '체험권 (광교)' }),
    ],
  });
  assert.equal(r.messages.length, 2);
});

/* ==========================================================================
   ④ 만료 임박 — 기한 7일 이내 AND 잔여 30% 이상. 두 경계 모두 확인
   ========================================================================== */
test('만료 임박: 7일 남고 잔여 30% 정확히 → 발동', () => {
  const r = run({
    memberRows: [mem({ 수강권종료일: '2026-08-12', 전체횟수: '20', 잔여횟수: '6' })], // 30%
    rosterRows: [resv()],
  });
  const m = one(r, 'expiring');
  assert.ok(m, '경계(7일 · 30%)에서 만료 임박이 안 잡혔다');
  assert.equal(m.근거.남은일, 7);
  assert.match(m.예시멘트, /이월/);
});

test('만료 임박: 8일 남으면 발동하지 않는다', () => {
  const r = run({
    memberRows: [mem({ 수강권종료일: '2026-08-13', 전체횟수: '20', 잔여횟수: '6' })],
    rosterRows: [resv()],
  });
  assert.equal(one(r, 'expiring'), undefined);
});

test('만료 임박: 잔여 29% 면 발동하지 않는다', () => {
  const r = run({
    memberRows: [mem({ 수강권종료일: '2026-08-10', 전체횟수: '100', 잔여횟수: '29' })],
    rosterRows: [resv()],
  });
  assert.equal(one(r, 'expiring'), undefined);
});

test('만료 임박: 이미 지난 수강권은 발동하지 않는다', () => {
  const r = run({
    memberRows: [mem({ 수강권종료일: '2026-08-01', 전체횟수: '20', 잔여횟수: '10' })],
    rosterRows: [resv()],
  });
  assert.equal(one(r, 'expiring'), undefined);
});

/* 🔥 2026-08-22 실제 오발송 — 전체=1·잔여=1 은 비율이 항상 1.0 이라 비율 조건을 무조건
   통과했다. 체험권 회원에게 "추가 등록하시면 남은 횟수는 그대로 이월돼요!" 가 나갔고,
   정렬순서상 만료임박(20)이 체험(40)을 이겨서 **올바른 체험 멘트까지 밀어냈다.** */
test('만료 임박: 1회권(전체 1·잔여 1)은 발동하지 않는다', () => {
  const r = run({
    memberRows: [
      mem({ 수강권명: '체험 후 1회권', 전체횟수: '1', 잔여횟수: '1', 수강권종료일: '2026-08-12' }),
    ],
    rosterRows: [resv({ 수강권명: '체험 후 1회권' })],
  });
  assert.equal(one(r, 'expiring'), undefined, '1회권이 만료임박으로 잡혔다');
});

test('만료 임박: 체험권은 발동하지 않고 체험으로 잡힌다', () => {
  const r = run({
    memberRows: [
      mem({ 수강권명: '(청담)체험권', 전체횟수: '1', 잔여횟수: '1', 수강권종료일: '2026-08-12' }),
    ],
    rosterRows: [resv({ 수강권명: '(청담)체험권' })],
  });
  assert.equal(one(r, 'expiring'), undefined, '체험권이 만료임박으로 잡혔다');
  assert.ok(one(r, 'trial'), '체험으로 잡혔어야 한다');
});

test('만료 임박: 전체 2회면 하한을 넘어 정상 발동한다 (경계)', () => {
  const r = run({
    memberRows: [mem({ 수강권명: '2회권', 전체횟수: '2', 잔여횟수: '2', 수강권종료일: '2026-08-12' })],
    rosterRows: [resv({ 수강권명: '2회권' })],
  });
  assert.ok(one(r, 'expiring'), '전체 2회는 만료임박 대상이다');
});

/* ── 이미 재등록한 회원 제외 ─────────────────────────────────────────────
   🔥 실측(2026-09-09 members 18,897행): 재등록은 옛 권이 **끝나기 전에** 시작한다
      (연속 등록건 9,995쌍 중 6,358쌍 = 63.6% 가 겹침 · 중앙값 −14일). "종료일 이후 시작"으로
      걸면 그날 재등록자 6명 중 4명만 잡힌다. 그래서 기준은 **더 늦게 끝나는 등록건**이다.
   ------------------------------------------------------------------------ */
// 만료 임박 대상 1건 (7일 남음 · 잔여 30%) — 아래 테스트들의 공통 기준
const 만료임박권 = () =>
  mem({
    수강권명: '바레 그룹 20회 (광교)', 수강권시작일: '2026-07-01',
    수강권종료일: '2026-08-12', 전체횟수: '20', 잔여횟수: '6',
  });

test('만료 임박: 겹쳐서 시작한 다음 수강권이 있으면(=재등록) 발동하지 않는다', () => {
  const r = run({
    memberRows: [
      만료임박권(),
      // 결제한 날부터 열려 만료 전에 시작한다 — 실제 재등록의 64%가 이 모양이다
      mem({
        수강권명: '언리미티드(광교)', 수강권시작일: '2026-08-01',
        수강권종료일: '2026-08-30', 전체횟수: '30', 잔여횟수: '30',
      }),
    ],
    rosterRows: [resv()],
  });
  assert.equal(one(r, 'expiring'), undefined, '이미 재등록한 회원에게 이월 안내가 나갔다');
  assert.equal(r.stats.만료임박_재등록제외, 1, '제외 건수가 통계에 안 남았다');
});

test('만료 임박: 종료일 이후에 시작한 다음 수강권도 재등록으로 본다', () => {
  const r = run({
    memberRows: [
      만료임박권(),
      mem({
        수강권명: '바레 그룹 20회 (광교)', 수강권시작일: '2026-08-13',
        수강권종료일: '2026-10-13', 전체횟수: '20', 잔여횟수: '20',
      }),
    ],
    rosterRows: [resv()],
  });
  assert.equal(one(r, 'expiring'), undefined);
});

test('만료 임박: 다음 수강권이 없으면 그대로 발동한다', () => {
  const r = run({
    memberRows: [
      만료임박권(),
      // 더 먼저 끝나는 옛 권은 "다음 수강권"이 아니다
      mem({
        수강권명: '바레 그룹 10회 (광교)', 수강권시작일: '2026-05-01',
        수강권종료일: '2026-07-01', 전체횟수: '10', 잔여횟수: '0',
      }),
    ],
    rosterRows: [resv()],
  });
  assert.ok(one(r, 'expiring'), '재등록 안 한 회원에게는 계속 나가야 한다');
  assert.equal(r.stats.만료임박_재등록제외, undefined);
});

test('만료 임박: 잔여 0 인 권은 더 늦게 끝나도 재등록이 아니다', () => {
  const r = run({
    memberRows: [
      만료임박권(),
      mem({
        수강권명: '체험 후 1회권', 수강권시작일: '2026-08-01',
        수강권종료일: '2026-08-30', 전체횟수: '1', 잔여횟수: '0',
      }),
    ],
    rosterRows: [resv()],
  });
  assert.ok(one(r, 'expiring'), '다 쓴 권이 재등록으로 오인됐다');
});

test('만료 임박: 같은 등록건의 중복 행은 재등록이 아니다', () => {
  // 같은 (수강권명, 수강권시작일) = 한 등록건. 이름 표식·결제 분할로 행이 갈릴 뿐이다.
  const r = run({
    memberRows: [
      만료임박권(),
      mem({
        이름: '홍길동 미수금', 수강권명: '바레 그룹 20회 (광교)', 수강권시작일: '2026-07-01',
        수강권종료일: '2026-08-12', 전체횟수: '20', 잔여횟수: '6',
      }),
    ],
    rosterRows: [resv()],
  });
  assert.ok(one(r, 'expiring'), '자기 자신(중복 행)을 다음 수강권으로 오인했다');
});

test('만료 임박: 재등록제외=false 면 예전처럼 발동한다', () => {
  const r = run({
    rules: rulesWith('expiring', { 재등록제외: false }),
    memberRows: [
      만료임박권(),
      mem({
        수강권명: '언리미티드(광교)', 수강권시작일: '2026-08-01',
        수강권종료일: '2026-08-30', 전체횟수: '30', 잔여횟수: '30',
      }),
    ],
    rosterRows: [resv()],
  });
  assert.ok(one(r, 'expiring'));
});

/* ==========================================================================
   ⑥ 수강권 선택 — 같은 이름을 여러 번 등록한 회원
   🔥 실측(2026-08-22 옥수 이수정): '체험 후 1회권' 등록건 18개. 옛 코드는 "가장 최근
      시작일"을 골라 09-08 만료 건을 집었는데, 그 수업이 실제로 쓴 건 08-25 만료 건이었다.
      예약행에 시작일이 있으므로 추측하지 말고 정확히 맞춘다.
   ========================================================================== */
test('수강권 선택: 예약의 수강권시작일과 정확히 일치하는 등록건을 고른다', () => {
  const 옛건 = mem({
    수강권명: '바레 그룹 10회', 수강권시작일: '2026-06-01', 수강권종료일: '2026-08-08',
    전체횟수: '10', 잔여횟수: '9',
  });
  const 새건 = mem({
    수강권명: '바레 그룹 10회', 수강권시작일: '2026-08-01', 수강권종료일: '2026-12-31',
    전체횟수: '10', 잔여횟수: '10',
  });
  const r = run({
    /* ⚠️ 재등록제외를 끈다 — 이 회원은 새 등록건(12-31 만료)을 이미 갖고 있어서 실제
       운영에서는 만료임박이 그 조건에 걸려 안 나간다. 여기서 보려는 건 **어느 등록건을
       골랐는가**뿐이므로, 그 조건을 끄고 선택 결과만 관찰한다. */
    rules: rulesWith('expiring', { 재등록제외: false }),
    memberRows: [옛건, 새건],
    // 이 수업이 쓰는 건 **옛 등록건**(3일 뒤 만료) — 예약행이 그렇게 말한다
    rosterRows: [resv({ 수강권명: '바레 그룹 10회', 수강권시작일: '2026-06-01' })],
  });
  const m = one(r, 'expiring');
  assert.ok(m, '옛 등록건을 골랐다면 만료임박이 잡혀야 한다');
  assert.equal(m.근거.남은일, 3);
});

test('수강권 선택: 예약에 시작일이 없으면 옛 방식(최근 등록건)으로 폴백한다', () => {
  const r = run({
    // 위와 같은 이유로 재등록제외를 끈다 — 끄지 않으면 "선택이 틀려도 통과"하는 시험이 된다
    rules: rulesWith('expiring', { 재등록제외: false }),
    memberRows: [
      mem({ 수강권명: '바레 그룹 10회', 수강권시작일: '2026-06-01', 수강권종료일: '2026-08-08', 전체횟수: '10', 잔여횟수: '9' }),
      mem({ 수강권명: '바레 그룹 10회', 수강권시작일: '2026-08-01', 수강권종료일: '2026-12-31', 전체횟수: '10', 잔여횟수: '10' }),
    ],
    rosterRows: [resv({ 수강권명: '바레 그룹 10회' })], // 시작일 없음
  });
  assert.equal(one(r, 'expiring'), undefined, '최근 등록건(만료 멀다)을 골랐어야 한다');
});

/* ==========================================================================
   ⑦ 1회권 재방문 — 드롭인 단골
   ========================================================================== */
test('1회권 재방문: 누적 4회 이상이고 1회권을 새로 샀으면 발동', () => {
  const r = run({
    memberRows: [
      mem({ 수강권명: '(옥수)체험권', 전체횟수: '1', 잔여횟수: '0' }),
      mem({ 수강권명: '바레 그룹 10회', 전체횟수: '10', 잔여횟수: '6' }), // 누적 1 + 4 = 5
      mem({ 수강권명: '체험 후 1회권', 전체횟수: '1', 잔여횟수: '1', 수강권시작일: '2026-08-01' }),
    ],
    rosterRows: [resv({ 수강권명: '체험 후 1회권', 수강권시작일: '2026-08-01' })],
  });
  const m = one(r, 'dropin-return');
  assert.ok(m, '드롭인 단골이 안 잡혔다');
  assert.match(m.예시멘트, /또 오셨네요/);
  assert.equal(one(r, 'first-paid'), undefined, '신규와 겹치면 안 된다');
});

test('1회권 재방문: 누적 3회 이하면 신규 등록 첫 수업이 이긴다 (경계)', () => {
  const r = run({
    memberRows: [
      mem({ 수강권명: '(옥수)체험권', 전체횟수: '1', 잔여횟수: '0' }),
      mem({ 수강권명: '바레 그룹 10회', 전체횟수: '10', 잔여횟수: '8' }), // 누적 1 + 2 = 3
      mem({ 수강권명: '체험 후 1회권', 전체횟수: '1', 잔여횟수: '1', 수강권시작일: '2026-08-01' }),
    ],
    rosterRows: [resv({ 수강권명: '체험 후 1회권', 수강권시작일: '2026-08-01' })],
  });
  assert.ok(one(r, 'first-paid'), '누적 3 은 신규 대상이다');
  assert.equal(one(r, 'dropin-return'), undefined);
});

test('1회권 재방문: 이미 쓴 1회권에는 붙지 않는다', () => {
  const r = run({
    memberRows: [
      mem({ 수강권명: '(옥수)체험권', 전체횟수: '1', 잔여횟수: '0' }),
      mem({ 수강권명: '바레 그룹 10회', 전체횟수: '10', 잔여횟수: '6' }),
      mem({ 수강권명: '체험 후 1회권', 전체횟수: '1', 잔여횟수: '0', 수강권시작일: '2026-08-01' }),
    ],
    rosterRows: [resv({ 수강권명: '체험 후 1회권', 수강권시작일: '2026-08-01' })],
  });
  assert.equal(one(r, 'dropin-return'), undefined);
});

test('규칙 병합: DB 에 없는 새 규칙도 코드 기본값으로 채워 내보낸다', () => {
  const merged = mergeRules([{ id: 'trial', 라벨: '체험', 활성: true, 슬랙발송: true, 정렬순서: 40 }]);
  const d = merged.find((x) => x.id === 'dropin-return');
  assert.ok(d, 'DB 에 없는 규칙이 병합되지 않았다 — 슬랙에 안 나간다');
  assert.equal(d.슬랙발송, true);
  assert.ok(d.라벨);
});

/* ==========================================================================
   ⑤ 14일 미방문 — 관측 이력이 짧으면 규칙 자체가 잠긴다
   ========================================================================== */
test('휴면: 관측 3일차면 명단을 내지 않고 경고를 남긴다', () => {
  const r = run({
    memberRows: [mem()],
    rosterRows: [],
    historyDays: 3,
  });
  assert.equal(r.dormant.length, 0);
  assert.ok(r.warnings.some((w) => w.includes('잠금')), '관측 부족 경고가 없다');
});

test('휴면: 관측 30일 + 마지막 출석 14일 전 → 명단에 포함', () => {
  const r = run({
    memberRows: [mem({ 잔여횟수: '5' })],
    rosterRows: [],
    lastAttendance: [
      { 이름: '홍길동', 연락처: '010-1111-2222', 마지막출석일: '2026-07-22', 마지막지점: '광교' },
    ],
    historyDays: 30,
  });
  assert.equal(r.dormant.length, 1);
  assert.equal(r.dormant[0].경과일, 14);
  assert.equal(r.dormant[0].경과일추정, false);
});

test('휴면: 13일 전이면 아직 대상이 아니다', () => {
  const r = run({
    memberRows: [mem({ 잔여횟수: '5' })],
    rosterRows: [],
    lastAttendance: [
      { 이름: '홍길동', 연락처: '010-1111-2222', 마지막출석일: '2026-07-23', 마지막지점: '광교' },
    ],
    historyDays: 30,
  });
  assert.equal(r.dormant.length, 0);
});

test('휴면: 잔여 0 이면 대상이 아니다 (쓸 수강권이 없음)', () => {
  const r = run({
    memberRows: [mem({ 잔여횟수: '0' })],
    rosterRows: [],
    lastAttendance: [
      { 이름: '홍길동', 연락처: '010-1111-2222', 마지막출석일: '2026-07-01', 마지막지점: '광교' },
    ],
    historyDays: 30,
  });
  assert.equal(r.dormant.length, 0);
});

test('휴면: 만료된 수강권만 있으면 대상이 아니다', () => {
  const r = run({
    memberRows: [mem({ 잔여횟수: '5', 수강권종료일: '2026-07-01' })],
    rosterRows: [],
    lastAttendance: [
      { 이름: '홍길동', 연락처: '010-1111-2222', 마지막출석일: '2026-07-01', 마지막지점: '광교' },
    ],
    historyDays: 30,
  });
  assert.equal(r.dormant.length, 0);
});

test('휴면: 관측 내 출석 기록이 아예 없으면 "경과일 추정"으로 표시한다', () => {
  const r = run({
    memberRows: [mem({ 잔여횟수: '5' })],
    rosterRows: [],
    lastAttendance: [],
    historyDays: 30,
  });
  assert.equal(r.dormant.length, 1);
  assert.equal(r.dormant[0].마지막출석일, null);
  assert.equal(r.dormant[0].경과일추정, true, '모르는 값을 아는 척하면 안 된다');
  assert.match(r.dormant[0].멘트, /≥30/);
});

/* ==========================================================================
   ⑥ 기타 — 취소 제외 / 연락처 보강 / 동명이인
   ========================================================================== */
test('취소·노쇼 예약은 대상에서 제외한다', () => {
  const r = run({
    memberRows: [mem({ 수강권명: '체험권 (광교)' })],
    rosterRows: [resv({ 수강권명: '체험권 (광교)', 예약상태: '취소' })],
  });
  assert.equal(r.messages.length, 0);
});

/* 만석 수업의 예약대기자 — 아직 자리가 없으므로 "내일 봬요" 계열 멘트가 나가면 안 된다.
   실측(2026-08-12 판교 19:00)에서 대기 3명이 예약자로 섞였다. */
test('예약대기는 대상에서 제외한다', () => {
  const r = run({
    memberRows: [mem({ 수강권명: '체험권 (광교)' })],
    rosterRows: [resv({ 수강권명: '체험권 (광교)', 예약상태: '예약대기' })],
  });
  assert.equal(r.messages.length, 0);
  assert.equal(r.stats.예약, 0);
});

/* 같은 수업에 확정자와 대기자가 섞여 있어도 확정자만 남아야 한다. */
test('예약대기가 섞여도 확정 예약자는 그대로 잡힌다', () => {
  const r = run({
    memberRows: [
      mem({ dedup_key: 'a', 이름: '홍길동', 연락처: '010-1111-2222', 수강권명: '체험권 (광교)' }),
      mem({ dedup_key: 'b', 이름: '김대기', 연락처: '010-3333-4444', 수강권명: '체험권 (광교)' }),
    ],
    rosterRows: [
      resv({ 수강권명: '체험권 (광교)', 예약상태: '예약' }),
      resv({ 이름: '김대기', 연락처: '010-3333-4444', 수강권명: '체험권 (광교)', 예약상태: '예약대기' }),
    ],
  });
  assert.equal(r.stats.예약, 1);
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].이름, '홍길동');
});

/* 스크래퍼의 상태 정규화 — 화면 원문이 규칙 엔진이 아는 어휘로 접히는지 고정한다.
   ⚠️ 여기가 깨지면 규칙 쪽 NOT_ATTENDING 이 멀쩡해도 대기자가 새어 나간다.
      두 파일이 짝이라 테스트도 한자리에 둔다. */
/* '미수금'은 결제 전에 수강권을 미리 발급했을 때 이름 뒤에 붙는 표식이고 결제되면 지워진다.
   즉 같은 사람의 이름이 시점에 따라 달라진다 — 안 떼면 한 사람이 둘로 세어져
   누적 횟수가 쪼개지고 마일스톤 회차가 틀린다. SQL 짝은 public.norm_person_name(). */
test('normPersonName — 이름의 미수금 표식을 뗀다', () => {
  assert.equal(normPersonName('손정미 미수금'), '손정미');
  assert.equal(normPersonName('구현정 미수금'), '구현정');
  assert.equal(normPersonName('이지은 미수금P'), '이지은');
  assert.equal(normPersonName('조윤서미수금p'), '조윤서');
  assert.equal(normPersonName('ISHIGAKI 체험 전액미수금'), 'ISHIGAKI 체험');
  // 표식이 없으면 그대로
  assert.equal(normPersonName('홍길동'), '홍길동');
  assert.equal(normPersonName('  김민정 '), '김민정');
  // 이름 전체가 표식이면 원본을 남긴다(과잉 정규화로 사람을 잃지 않는다)
  assert.equal(normPersonName('미수금'), '미수금');
  assert.equal(normPersonName(''), '');
});

/* 기수·촬영 표식(2026-08-13 실측 344명). 미수금과 같은 이유로 뗀다 —
   과정 등록/수료·촬영 동의 변경 때 붙었다 떼어져 한 사람이 둘로 갈린다. */
test('normPersonName — 기수·촬영 표식을 뗀다', () => {
  assert.equal(normPersonName('김민정 15기'), '김민정');
  assert.equal(normPersonName('박서연 1기'), '박서연');
  assert.equal(normPersonName('이수민 M1 13기'), '이수민');
  assert.equal(normPersonName('정하나 M2 2기'), '정하나');
  assert.equal(normPersonName('이유나 촬영X'), '이유나');
  assert.equal(normPersonName('최지영 촬영x'), '최지영');
  assert.equal(normPersonName('한소희 촬영 X'), '한소희');
  // 표식이 겹쳐 붙어도 전부 떨어진다
  assert.equal(normPersonName('김하늘 15기 미수금P'), '김하늘');
});

/* ⛔️ 과잉 정규화 회귀 방지 — 여기가 깨지면 **서로 다른 사람이 한 명으로 뭉친다.**
   개수는 맞아 보이지만 누적 횟수가 부풀어 마일스톤이 조용히 틀린다. */
test('normPersonName — 떼면 안 되는 것은 그대로 둔다', () => {
  // 이름 전체가 표식인 자리 계정 — 떼면 "체험1/체험2/체험3"이 전부 한 사람이 된다
  assert.equal(normPersonName('체험1'), '체험1');
  assert.equal(normPersonName('체험2'), '체험2');
  assert.notEqual(normPersonName('체험1'), normPersonName('체험2'));
  // 이름 안의 '기' — 숫자를 요구하므로 안 걸린다
  assert.equal(normPersonName('정기'), '정기');
  assert.equal(normPersonName('박기수'), '박기수');
  // 뜻이 확인되지 않은 낱글자 표식은 유지한다(같은 연락처의 다른 가족일 수 있다)
  assert.equal(normPersonName('김철수 D'), '김철수 D');
  assert.equal(normPersonName('김영희P'), '김영희P');
  // 외국어 이름을 훼손하지 않는다
  assert.equal(normPersonName('Emily Brassfield'), 'Emily Brassfield');
  assert.equal(normPersonName('Lee Rachel JungMi'), 'Lee Rachel JungMi');
  assert.equal(normPersonName('Andy GE'), 'Andy GE');
});

test('personKey — 결제 전후로 같은 사람이 갈리지 않는다', () => {
  const before = { 이름: '손정미 미수금', 연락처: '010-7737-0224' };
  const after = { 이름: '손정미', 연락처: '01077370224' };
  assert.equal(personKey(before), personKey(after));
});

test('누적 횟수가 미수금 표식 때문에 쪼개지지도, 두 번 세어지지도 않는다', () => {
  const rows = [
    mem({ dedup_key: 'a', 이름: '손정미 미수금', 연락처: '010-7737-0224', 전체횟수: '20', 잔여횟수: '15' }),
    mem({ dedup_key: 'b', 이름: '손정미', 연락처: '010-7737-0224', 전체횟수: '20', 잔여횟수: '13' }),
  ];
  const keyOf = makePersonResolver(rows);
  assert.equal(keyOf(rows[0]), keyOf(rows[1]), '같은 사람으로 묶여야 한다');
  /* 🔥 두 행은 **같은 수강권 한 장**이다(표식이 붙었다 떼어지는 사이에 두 번 업로드됐다).
     행을 더하면 5+7=12 가 되는데 실제로 나온 건 7회다 — 이게 2026-08-14 마일스톤
     오발송(구태희 '10회차', 실제 4회)의 원인이었다. */
  assert.equal(personUsedCount(rows), 7);
  assert.equal(rows.reduce((s, r) => s + usedCount(r), 0), 12, '행 단위 합은 여전히 부풀어 있다');
});

test('normStatus — 화면 원문 어휘를 표준값으로 접는다', async () => {
  const { normStatus, WAITLIST } = await import('../studiomate/normalize.mjs');
  // 실측 원문 (2026-08-12, 청담·판교 27개 수업)
  assert.equal(normStatus('예약 대기 (1)'), WAITLIST);
  assert.equal(normStatus('예약 대기 (2)'), WAITLIST);
  assert.equal(normStatus('예약 확정'), '예약');
  assert.equal(normStatus('예약'), '예약');
  assert.equal(normStatus('출석'), '출석');
  assert.equal(normStatus('결석'), '결석');
  // 순서 함정 — '예약취소'는 '예약'을, '미출석'은 '출석'을 포함한다
  assert.equal(normStatus('예약 취소'), '취소');
  assert.equal(normStatus('미출석'), '결석');
  assert.equal(normStatus(''), '예약'); // 빈 값은 기본값
});

test('예약에 연락처가 없으면 members 에서 채운다 (sales 조인이 깨지지 않게)', () => {
  const r = run({
    memberRows: [mem({ 수강권명: '체험권 (광교)' })],
    rosterRows: [resv({ 수강권명: '체험권 (광교)', 연락처: '' })],
  });
  assert.equal(r.messages[0].연락처, '010-1111-2222');
});

test('동명이인: 연락처가 다르면 절대 합치지 않는다', () => {
  const r = run({
    memberRows: [
      mem({ 이름: '김민정', 연락처: '010-1111-1111', 전체횟수: '120', 잔여횟수: '21', dedup_key: 'a' }),
      mem({ 이름: '김민정', 연락처: '010-2222-2222', 전체횟수: '10', 잔여횟수: '10', dedup_key: 'b' }),
    ],
    rosterRows: [resv({ 이름: '김민정', 연락처: '010-2222-2222' })],
  });
  // 두 번째 김민정은 누적 0 이므로 100회차가 될 수 없다
  assert.equal(one(r, 'milestone'), undefined);
});

/* ==========================================================================
   ⑦ crm-core 헬퍼
   ========================================================================== */
test('usedCount = 전체 − 잔여 (텍스트 컬럼 파싱)', () => {
  assert.equal(usedCount({ 전체횟수: '20회', 잔여횟수: ' 3 ' }), 17);
});

test('dateKST 는 UTC 자정 직후에도 한국 날짜를 준다', () => {
  // 2026-08-05 15:30 UTC = 2026-08-06 00:30 KST
  assert.equal(dateKST(0, new Date('2026-08-05T15:30:00Z')), '2026-08-06');
  assert.equal(dateKST(-1, new Date('2026-08-05T15:30:00Z')), '2026-08-05');
  assert.equal(dateKST(1, new Date('2026-08-05T15:30:00Z')), '2026-08-07');
});

test('daysBetween 은 월·연 경계를 넘어도 맞는다', () => {
  assert.equal(daysBetween('2026-07-22', '2026-08-05'), 14);
  assert.equal(daysBetween('2025-12-25', '2026-01-01'), 7);
  assert.equal(daysBetween('2026-08-05', '2026-08-05'), 0);
  assert.equal(daysBetween('', '2026-08-05'), null);
});

test('makePersonResolver: 연락처 빈 행은 그 이름의 연락처가 유일할 때만 붙인다', () => {
  const rows = [
    { 이름: '홍길동', 연락처: '010-1111-2222', dedup_key: 'a' },
    { 이름: '홍길동', 연락처: '', dedup_key: 'b' },
    { 이름: '김민정', 연락처: '010-3333-3333', dedup_key: 'c' },
    { 이름: '김민정', 연락처: '010-4444-4444', dedup_key: 'd' },
    { 이름: '김민정', 연락처: '', dedup_key: 'e' },
  ];
  const k = makePersonResolver(rows);
  assert.equal(k(rows[1]), k(rows[0]), '연락처가 유일하면 붙어야 한다');
  assert.notEqual(k(rows[4]), k(rows[2]), '동명이인이면 붙이면 안 된다');
  assert.notEqual(k(rows[4]), k(rows[3]), '동명이인이면 붙이면 안 된다');
});

/* ==========================================================================
   ⑧ 누적 사용횟수 — '행 합'이 아니라 '수강권 등록건 합'  (2026-08-14 오발송 재발 방지)
   --------------------------------------------------------------------------
   실제 사고: 반포 구태희에게 '10회차!' 가 나갔는데 실제 출석은 4회였다.
   members 에 같은 수강권이 표식·결제 때문에 5행으로 남아 있었고, 행을 더해 9회가 됐다.
   ========================================================================== */
const 구태희 = [
  // 체험권 — 이름 표식이 붙은 행과 떼어진 행. 같은 한 장이다.
  mem({ dedup_key: 'k1', 이름: '구태희 미수금', 수강권명: '체험권 (반포)', 전체횟수: '1', 잔여횟수: '0',
        수강권시작일: '2026-07-07', 결제일시: '2026-07-07' }),
  mem({ dedup_key: 'k2', 이름: '구태희', 수강권명: '체험권 (반포)', 전체횟수: '1', 잔여횟수: '0',
        수강권시작일: '2026-07-07', 결제일시: '2026-07-07' }),
  // 20회권 — 표식 행(옛 잔여 19) + 결제가 둘로 나뉜 행 2개(잔여 17)
  mem({ dedup_key: 'k3', 이름: '구태희 미수금', 수강권명: '바레 그룹 20회(반포)', 전체횟수: '20', 잔여횟수: '19',
        수강권시작일: '2026-07-31', 결제일시: '2026-07-22' }),
  mem({ dedup_key: 'k4', 이름: '구태희', 수강권명: '바레 그룹 20회(반포)', 전체횟수: '20', 잔여횟수: '17',
        수강권시작일: '2026-07-31', 결제일시: '2026-07-22' }),
  mem({ dedup_key: 'k5', 이름: '구태희', 수강권명: '바레 그룹 20회(반포)', 전체횟수: '20', 잔여횟수: '17',
        수강권시작일: '2026-07-31', 결제일시: '2026-08-06' }),
];

test('구태희 재현: 중복 행을 접으면 누적은 9 가 아니라 4 다', () => {
  assert.equal(구태희.reduce((s, r) => s + usedCount(r), 0), 9, '옛 공식(행 합)');
  assert.equal(personUsedCount(구태희), 4, '체험 1 + 20회권 3');
  const a = usageAudit(구태희);
  assert.equal(a.등록건수, 2);
  assert.equal(a.행수, 5);
  assert.equal(a.결손, 0);
  assert.equal(a.최초시작일, 20260707);
});

test('구태희 재현: 예정 5회차이므로 마일스톤이 나가지 않는다', () => {
  const r = run({
    memberRows: 구태희,
    rosterRows: [resv({ 이름: '구태희', 수강권명: '바레 그룹 20회(반포)' })],
  });
  assert.equal(one(r, 'milestone'), undefined, '실제로는 5회차인데 10회차가 나갔던 자리');
});

test('재등록(같은 수강권명 · 다른 시작일)은 각각 더한다', () => {
  const rows = [
    mem({ dedup_key: 'a', 수강권명: '언리미티드(판교) 30회', 전체횟수: '30', 잔여횟수: '0', 수강권시작일: '2026-05-01' }),
    mem({ dedup_key: 'b', 수강권명: '언리미티드(판교) 30회', 전체횟수: '30', 잔여횟수: '10', 수강권시작일: '2026-06-01' }),
  ];
  assert.equal(personUsedCount(rows), 50, '30 + 20 — 재등록은 별개 등록건이다');
  assert.equal(dedupeTicketRows(rows).length, 2);
});

test('중복 행 중 옛 잔여를 든 행이 대표가 되지 않는다 (신규 등록 첫 수업 오발동 방지)', () => {
  const rows = [
    // 결제일시가 더 늦지만 잔여는 옛 값(= 아직 안 쓴 것처럼 보이는 행)
    mem({ dedup_key: 'a', 전체횟수: '20', 잔여횟수: '20', 결제일시: '2026-08-06' }),
    mem({ dedup_key: 'b', 전체횟수: '20', 잔여횟수: '17', 결제일시: '2026-07-22' }),
    mem({ dedup_key: 'c', 수강권명: '체험권 (광교)', 전체횟수: '1', 잔여횟수: '0', 수강권시작일: '2026-06-01' }),
  ];
  const r = run({ memberRows: rows, rosterRows: [resv()] });
  assert.equal(one(r, 'first-paid'), undefined, '이미 3회 다닌 회원에게 신규 등록 멘트가 나가면 안 된다');
});

test('휴면 잔여합도 등록건 기준으로 센다', () => {
  const rows = [
    mem({ dedup_key: 'a', 이름: '박한결 미수금', 연락처: '010-9999-0000', 전체횟수: '20', 잔여횟수: '17',
          수강권종료일: '2026-12-31' }),
    mem({ dedup_key: 'b', 이름: '박한결', 연락처: '010-9999-0000', 전체횟수: '20', 잔여횟수: '17',
          수강권종료일: '2026-12-31' }),
  ];
  const r = run({ memberRows: rows, rosterRows: [], historyDays: 30 });
  assert.equal(r.dormant.length, 1);
  assert.equal(r.dormant[0].잔여합, 17, '34 가 되면 잔여 34회 남았다고 응대하게 된다');
  assert.equal(r.dormant[0].보유수강권.length, 1);
});

/* ==========================================================================
   ⑨ 마일스톤 교차검증 — 회차는 사실 단언이므로, 모순이면 보내지 않는다
   ========================================================================== */
test('verifyMilestone: 두 기록이 맞으면 통과', () => {
  const audit = { 누적: 9, 등록건수: 2, 행수: 2, 결손: 0, 시작일결손: 0, 최초시작일: 20260801 };
  assert.equal(verifyMilestone({ audit, 관측출석: 9, 관측시작: 20260729 }), null);
});

test('verifyMilestone: 출석 기록이 회원 데이터보다 많으면 보류', () => {
  const audit = { 누적: 5, 등록건수: 1, 행수: 1, 결손: 0, 시작일결손: 0, 최초시작일: 20260701 };
  assert.match(String(verifyMilestone({ audit, 관측출석: 7, 관측시작: 20260729 })), /출석 기록/);
});

test('verifyMilestone: 전 이력이 관측 안인데 수가 다르면 보류', () => {
  const audit = { 누적: 9, 등록건수: 1, 행수: 1, 결손: 0, 시작일결손: 0, 최초시작일: 20260805 };
  assert.match(String(verifyMilestone({ audit, 관측출석: 6, 관측시작: 20260729 })), /전 이력/);
  // 등록이 관측 시작보다 앞서면 과거를 못 봤을 뿐이므로 통과한다
  const 옛회원 = { ...audit, 최초시작일: 20260701 };
  assert.equal(verifyMilestone({ audit: 옛회원, 관측출석: 6, 관측시작: 20260729 }), null);
});

test('verifyMilestone: 전체횟수가 비면 사용횟수를 확정할 수 없다 → 보류', () => {
  const audit = usageAudit([mem({ 전체횟수: '', 잔여횟수: '5' })]);
  assert.equal(audit.결손, 1);
  assert.equal(audit.누적, 0, '음수로 흘러 회차를 밀면 안 된다');
  assert.match(String(verifyMilestone({ audit, 관측출석: 0, 관측시작: null })), /전체횟수/);
});

test('마일스톤: 교차검증에 걸리면 발송 대신 보류 + 경고 (실명 없이 건수만)', () => {
  const rows = [mem({ 전체횟수: '120', 잔여횟수: '21', 수강권시작일: '2026-08-01' })]; // 누적 99 → 예정 100
  const r = run({
    memberRows: rows,
    rosterRows: [resv()],
    lastAttendance: [{ 이름: '홍길동', 연락처: '010-1111-2222', 마지막출석일: '2026-08-04', 출석횟수: 40 }],
    historyStart: '2026-07-29', // 등록(8/1)이 관측 시작 이후 = 전 이력 관측
  });
  assert.equal(one(r, 'milestone'), undefined);
  assert.equal(r.보류.length, 1);
  assert.equal(r.stats.마일스톤보류, 1);
  const w = r.warnings.find((x) => x.includes('마일스톤'));
  assert.ok(w, '보류 경고가 있어야 한다');
  assert.ok(!w.includes('홍길동'), '경고는 운영 채널로 나갈 수 있다 — 실명 금지');
});

test('마일스톤: 두 기록이 일치하면 그대로 발송한다', () => {
  const r = run({
    memberRows: [mem({ 전체횟수: '120', 잔여횟수: '21', 수강권시작일: '2026-08-01' })],
    rosterRows: [resv()],
    lastAttendance: [{ 이름: '홍길동', 연락처: '010-1111-2222', 마지막출석일: '2026-08-04', 출석횟수: 99 }],
    historyStart: '2026-07-29',
  });
  const m = one(r, 'milestone');
  assert.ok(m);
  assert.equal(m.근거.관측출석, 99);
});

test('마일스톤: 교차검증=false 면 members 값만으로 보낸다 (탈출구)', () => {
  const rules = DEFAULT_RULES.map((d) =>
    d.id === 'milestone' ? { ...d, 파라미터: { ...d.파라미터, 교차검증: false } } : d,
  );
  const r = run({
    rules,
    memberRows: [mem({ 전체횟수: '120', 잔여횟수: '21', 수강권시작일: '2026-08-01' })],
    rosterRows: [resv()],
    lastAttendance: [{ 이름: '홍길동', 연락처: '010-1111-2222', 마지막출석일: '2026-08-04', 출석횟수: 40 }],
    historyStart: '2026-07-29',
  });
  assert.ok(one(r, 'milestone'));
});

/* ==========================================================================
   ⑩ 회차의 근거를 "차감된 횟수" → "실제 출석 기록" 으로 옮긴 자리
      (docs/NEXT-attendance-count.md)

   왜 이 테스트들이 있나 — `전체횟수 − 잔여횟수` 는 결석·노쇼도 세고, 횟수 조정과
   만료 소멸은 되짚을 수조차 없다. 검증 가능한 회원 137명 중 34% 가 어긋났고 **양방향**
   이었다(회차를 높게도, 낮게도 부른다). 그래서 attendanceRows(회원 페이지의 `출석(N)`)가
   있으면 그쪽을 근거로 쓴다. 아래가 그 계약이다.
   ========================================================================== */
const PK = personKey({ 이름: '홍길동', 연락처: '010-1111-2222' });
const 사이트 = (지점) => ({ 청담: 'everybarre', 판교: 'everybarre', 광교: 'everybarre-gwanggyo', 송파: 'everybarre-songpa' }[지점] || '');
const att = (o = {}) => ({ person_key: PK, site: 'everybarre-gwanggyo', 기준일: TODAY, 출석수: 9, ...o });

test('출석근거: 결석은 회차에 안 들어간다 (차감 횟수는 결석도 센다)', () => {
  /* members 는 전체 20 · 잔여 8 → 차감 12. 옛 경로였다면 "13회차".
     실제 출석은 9회뿐이므로 내일이 10회차다 — 그게 맞는 값이다. */
  const r = run({
    memberRows: [mem({ 전체횟수: '20', 잔여횟수: '8' })],
    rosterRows: [resv()],
    attendanceRows: [att({ 출석수: 9 })],
    siteOfBranch: 사이트,
  });
  const m = one(r, 'milestone');
  assert.ok(m, '출석 9회 + 내일 = 10회차인데 마일스톤이 안 잡혔다');
  assert.equal(m.규칙키, '10');
  assert.equal(m.근거.누적횟수, 9);
  assert.equal(m.근거.근거출처, '출석기록');
  assert.equal(m.근거.차감누적, 12, '옛 값도 근거에 남겨 둔다(둘이 벌어지는 정도 추적용)');
  assert.match(m.멘트, /지금까지 9회/);
});

test('출석근거: 1 모자라면 발동하지 않는다 (경계)', () => {
  const r = run({
    memberRows: [mem({ 전체횟수: '20', 잔여횟수: '8' })], // 차감 12 — 옛 경로면 켜졌을 값
    rosterRows: [resv()],
    attendanceRows: [att({ 출석수: 8 })], // 내일이 9회차
    siteOfBranch: 사이트,
  });
  assert.equal(one(r, 'milestone'), undefined);
});

test('출석근거: 두 사이트 출석 수가 합산된다 (한쪽만 보면 절반이 된다)', () => {
  /* 김단하 사례 — 청담(everybarre)과 송파(everybarre-songpa)를 같이 다닌다.
     지점이 아니라 **사이트**가 단위라, 한쪽만 읽으면 회차를 절반으로 부른다. */
  const r = run({
    memberRows: [mem()],
    rosterRows: [resv()],
    attendanceRows: [
      att({ site: 'everybarre', 출석수: 36 }),
      att({ site: 'everybarre-songpa', 출석수: 13 }),
    ],
    siteOfBranch: 사이트,
  });
  const m = one(r, 'milestone');
  assert.ok(m, '36+13=49 → 내일 50회차인데 안 잡혔다');
  assert.equal(m.규칙키, '50');
  assert.equal(m.근거.출석사이트수, 2);
});

test('출석근거: 근거가 없는 회원은 마일스톤을 보내지 않는다 (지어내지 않는다)', () => {
  /* 회원 페이지를 못 읽은 사람. 차감 횟수로는 "10회차"지만, 그 값이 틀리다는 게
     이 작업의 전제다 — 그러니 지어내지 말고 건너뛰고, 건수로 경고한다. */
  const r = run({
    memberRows: [mem({ 전체횟수: '20', 잔여횟수: '11' })], // 차감 9 → 옛 경로면 10회차
    rosterRows: [resv()],
    attendanceRows: [att({ person_key: '다른사람\u001f01099998888' })],
    siteOfBranch: 사이트,
  });
  assert.equal(one(r, 'milestone'), undefined);
  assert.equal(r.stats.출석근거없음, 1);
  assert.ok(r.warnings.some((w) => w.includes('출석 기록이 없는 예약자')));
  assert.ok(!r.warnings.some((w) => /홍길동/.test(w)), '경고에 실명이 들어가면 안 된다');
});

test('출석근거: 오늘 값이 아니면 보류한다 (스크랩이 빠지면 낮게 나온다)', () => {
  const r = run({
    memberRows: [mem()],
    rosterRows: [resv()],
    attendanceRows: [att({ 기준일: '2026-08-03', 출석수: 8 })],
    recentReservations: [
      { person_key: PK, 지점: '광교', 예약일자: '2026-08-04', 예약상태: '출석' },
    ],
    siteOfBranch: 사이트,
  });
  assert.equal(one(r, 'milestone'), undefined, '보정으로 9가 되어도 오늘 값이 아니면 보내지 않는다');
  assert.equal(r.stats.마일스톤보류, 1);
  assert.ok(r.warnings.some((w) => w.includes('마일스톤') && w.includes('보류')));
});

test('출석근거: attendanceRows 가 비면 옛 경로로 폴백한다 (도입 첫날·MOCK)', () => {
  const r = run({
    memberRows: [mem({ 전체횟수: '20', 잔여횟수: '11' })], // 차감 9 → 10회차
    rosterRows: [resv()],
  });
  const m = one(r, 'milestone');
  assert.ok(m, '폴백 경로가 끊기면 도입 첫날 마일스톤이 통째로 사라진다');
  assert.equal(m.근거.근거출처, '차감횟수');
  assert.equal(r.stats.회차근거, '차감횟수');
});
