// ============================================================================
// CRM 규칙 경계값 테스트  —  node --test automation/test/
// ----------------------------------------------------------------------------
// 의존성 0(node:test 만). 규칙이 "정확히 경계에서" 켜지고 꺼지는지 고정한다.
// 규칙을 고칠 때 여기가 먼저 깨져야 한다 — 안 깨지면 테스트가 부족한 것이다.
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RULES, buildCrm } from '../../shared/crm-rules.mjs';
import {
  makePersonResolver,
  normPersonName,
  personKey,
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

test('누적 횟수가 미수금 표식 때문에 쪼개지지 않는다', () => {
  const rows = [
    mem({ dedup_key: 'a', 이름: '손정미 미수금', 연락처: '010-7737-0224', 전체횟수: '20', 잔여횟수: '15' }),
    mem({ dedup_key: 'b', 이름: '손정미', 연락처: '010-7737-0224', 전체횟수: '20', 잔여횟수: '13' }),
  ];
  const keyOf = makePersonResolver(rows);
  assert.equal(keyOf(rows[0]), keyOf(rows[1]), '같은 사람으로 묶여야 한다');
  // 5회 + 7회 = 12회가 한 사람의 누적이 된다
  assert.equal(rows.reduce((s, r) => s + usedCount(r), 0), 12);
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
