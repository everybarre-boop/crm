// ============================================================================
// 출석 수 읽기 — 누구를 어느 사이트에서 읽을지(계획) + 실제로 읽어 저장(실행)
// ----------------------------------------------------------------------------
// 야간 실행(run.mjs 의 attcount 단계)과 일괄 보정(attcount-backfill.mjs)이 같이 쓴다.
//
// 🔥 왜 따로 뺐나 — 2026-11-26 임동우 사고.
//    출석 수는 **사이트별**인데, 예전 attcount 는 내일 예약이 잡힌 사이트만 읽었다.
//    회원 id 를 예약자 행에서만 얻었기 때문이다. 그래서 예전에 다닌 사이트(옥수·광교)의
//    출석은 한 번도 읽히지 않았고, 사람 합계가 264회로 표시됐다(125명 · 빠진 사이트 143곳).
//    → 이제는 그 사람이 **수강권을 가진 모든 사이트**를 읽는다. id 를 모르는 사이트는
//      상단 검색창(연락처)으로 찾는다(studiomate/scrape.mjs 의 findMemberIds).
// ============================================================================
import { siteOfBranch } from './config.mjs';
import { saveAttendance } from './db.mjs';
import {
  KEY_SEP,
  makePersonResolver,
  personKey,
  rekeyPerson,
  ticketSitesByPerson,
} from '../shared/crm-core.mjs';

/**
 * @param people          [{ 이름, 연락처, site?, 회원id? }] — site·회원id 가 있으면(예약자 행) 그대로 쓴다.
 * @param memberRows      members [{ dedup_key, 이름, 연락처, 수강권명 }] — 수강권이 있는 사이트를 뽑는다.
 * @param attendanceRows  crm_attendance [{ person_key, site, 회원id }] — 이미 아는 회원 id.
 * @param reread          false 면 이미 행이 있는 (사람, 사이트)는 건너뛴다 — 일괄 보정은 **빠진 곳만** 채운다.
 * @returns Map<site, { byId: Map<회원id, {회원id, 이름, person_key}>, toFind: [{이름, 연락처, person_key}] }>
 */
export function planAttendanceReads({ people, memberRows, attendanceRows, reread = true }) {
  const keyOf = makePersonResolver(memberRows, people);
  const sitesOf = ticketSitesByPerson(memberRows, siteOfBranch, keyOf);
  const knownId = new Map(); // `${사람}\0${site}` → 회원id
  for (const a of attendanceRows) {
    knownId.set(`${rekeyPerson(a.person_key, keyOf)}\u0000${a.site}`, String(a.회원id));
  }

  /* 별칭 = 같은 사람으로 합쳐진 members 의 다른 이름들(개명 · 'M' 'MP' 같은 표식).
     개명은 사이트마다 따로 반영돼서, 대표 이름('손소영M')으로만 확인하면 옛 이름이 남은 사이트
     ('손소영')를 "다른 사람"으로 버린다(2026-11-26 일괄 보정에서 실측). */
  const aliases = new Map();
  for (const m of memberRows) {
    const k = keyOf(m);
    const n = String(m.이름 ?? '').trim();
    if (!n) continue;
    if (!aliases.has(k)) aliases.set(k, new Set());
    aliases.get(k).add(n);
  }
  const 별칭Of = (p) => [...(aliases.get(keyOf(p)) || [])];

  const plan = new Map();
  const slot = (site) => {
    if (!plan.has(site)) plan.set(site, { byId: new Map(), toFind: [] });
    return plan.get(site);
  };
  const done = new Set();
  const add = (site, 회원id, p) =>
    slot(site).byId.set(회원id, { 회원id, 이름: p.이름 || '', 별칭: 별칭Of(p), person_key: personKey(p) });

  // 1) 예약자 행에서 이미 id 를 아는 사이트
  for (const p of people) {
    const id = String(p.회원id ?? '').trim();
    if (!p.site || !id) continue;
    add(p.site, id, p);
    done.add(`${keyOf(p)}\u0000${p.site}`);
  }
  // 2) 그 사람이 수강권을 가진 나머지 사이트
  for (const p of people) {
    const k = keyOf(p);
    for (const site of sitesOf.get(k) || []) {
      const kk = `${k}\u0000${site}`;
      if (done.has(kk)) continue;
      done.add(kk);
      const id = knownId.get(kk);
      if (id && !reread) continue;
      if (id) add(site, id, p);
      else slot(site).toFind.push({ 이름: p.이름 || '', 연락처: p.연락처 || '', 별칭: 별칭Of(p), person_key: personKey(p) });
    }
  }
  return plan;
}

/** crm_attendance 의 person_key(이름⋮숫자연락처) → { 이름, 연락처 } */
export function personOfKey(pk) {
  const [이름, 연락처 = ''] = String(pk ?? '').split(KEY_SEP);
  return { 이름, 연락처 };
}

/** 연도별 출석을 아직 안 읽은 (site, 회원id) 를 가려내는 판정기.
    crm_attendance 에 행이 없거나(처음 보는 회원) 연도기준일이 비어 있으면 읽어야 한다. */
export function makeNeedsYears(attendanceRows) {
  const has = new Set(
    attendanceRows.filter((a) => a.연도기준일).map((a) => `${a.site}\u0000${a.회원id}`),
  );
  return (site, 회원id) => !has.has(`${site}\u0000${회원id}`);
}

/**
 * 계획대로 사이트별로 로그인 → (id 찾기) → 회원 페이지 읽기 → 저장.
 * 한 사이트가 통째로 실패해도 나머지는 계속한다(onSiteError 로 넘긴다).
 * 🔐 회원별 실패 로그에는 실명이 섞인다 — 콘솔(러너 로그)에만 남긴다. 슬랙엔 건수만.
 * @param needsYears (site, 회원id) → bool — true 인 회원은 연도별 출석(이용내역 엑셀)까지 읽는다.
 */
export async function readAttendancePlan(
  page,
  plan,
  { today, dryRun, ensureLogin, fresh = new Set(), onSiteError, needsYears = () => false },
) {
  const { findMemberIds, scrapeMembers } = await import('./studiomate.mjs');
  const tot = { read: 0, failed: 0, notFound: 0, skipped: 0, years: 0, yearsFailed: 0 };

  for (const [site, { byId, toFind }] of plan) {
    const isFresh = (id) => fresh.has(`${site}\u0000${id}`);
    const todo = [...byId.values()].filter((t) => !isFresh(t.회원id));
    tot.skipped += byId.size - todo.length;
    if (!todo.length && !toFind.length) {
      if (byId.size) console.log(`[attcount] ${site}: ${byId.size}명 전부 오늘 이미 읽음 — 건너뜀`);
      continue;
    }
    try {
      await ensureLogin(page, site);
      const t0 = Date.now();

      const { found, failures: 못찾음 } = await findMemberIds(page, site, toFind);
      for (const f of found) {
        if (byId.has(f.회원id) || isFresh(f.회원id)) continue;
        byId.set(f.회원id, f);
        todo.push(f);
      }
      tot.notFound += 못찾음.length;

      for (const t of todo) t.withYears = needsYears(site, t.회원id);
      const { rows, failures } = await scrapeMembers(page, site, todo);
      const 연도실패 = rows.filter((r) => r.연도오류);
      tot.years += rows.filter((r) => r.연도별).length;
      tot.yearsFailed += 연도실패.length;
      const pkOf = new Map(todo.map((t) => [t.회원id, t.person_key]));
      const saved = await saveAttendance(
        rows.map((r) => ({ ...r, 기준일: today, person_key: pkOf.get(r.회원id) || '' })),
        { dryRun },
      );
      tot.read += rows.length;
      tot.failed += failures.length;
      console.log(
        `[attcount] ${site}: ${todo.length}명 중 ${rows.length}명 읽음` +
          (toFind.length ? ` (그중 검색으로 id 찾음 ${found.length}/${toFind.length})` : '') +
          (dryRun ? ' (dry-run · 저장 안 함)' : ` / 저장 ${saved}건`) +
          ` · ${((Date.now() - t0) / 1000).toFixed(0)}초` +
          (failures.length ? `  ⚠️ 읽기 실패 ${failures.length}명` : '') +
          (못찾음.length ? `  ⚠️ id 못 찾음 ${못찾음.length}명` : '') +
          (연도실패.length ? `  ⚠️ 연도별 실패 ${연도실패.length}명` : ''),
      );
      for (const f of failures.slice(0, 5)) console.warn(`     · ${f.이름}: ${f.error.slice(0, 120)}`);
      for (const f of 연도실패.slice(0, 5)) console.warn(`     · (연도별) ${f.이름}: ${f.연도오류.slice(0, 120)}`);
      for (const f of 못찾음.slice(0, 5)) console.warn(`     · (검색) ${f.이름}: ${f.error.slice(0, 120)}`);
    } catch (err) {
      onSiteError(site, err);
    }
  }
  return tot;
}
