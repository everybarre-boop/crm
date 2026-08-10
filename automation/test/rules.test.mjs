// ============================================================================
// CRM 규칙 경계값 테스트  —  node --test automation/test/
// ----------------------------------------------------------------------------
// 의존성 0(node:test 만). 규칙이 "정확히 경계에서" 켜지고 꺼지는지 고정한다.
// 규칙을 고칠 때 여기가 먼저 깨져야 한다 — 안 깨지면 테스트가 부족한 것이다.
// ============================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCrm } from '../../shared/crm-rules.mjs';
import { makePersonResolver, usedCount, dateKST, daysBetween } from '../../shared/crm-core.mjs';

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

test('마일스톤: 스크랩 누락으로 100 을 지나쳤으면 소급 보정(한도 10 이내)', () => {
  // 사용 104 → 예정 105. 100 을 이미 지났지만 5 차이라 소급 발송.
  const r = run({
    memberRows: [mem({ 전체횟수: '120', 잔여횟수: '16' })],
    rosterRows: [resv()],
  });
  const m = one(r, 'milestone');
  assert.ok(m, '소급 보정이 안 걸렸다');
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
      { person_key: '홍길동01011112222', rule_id: 'milestone', 규칙키: '100', 대상일자: '2026-07-01' },
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
      { person_key: '홍길동01011112222', rule_id: 'milestone', 규칙키: '100', 대상일자: TOMORROW },
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
