// ============================================================================
// 슬랙 발송 (Bot Token · 발송 전용)
// ----------------------------------------------------------------------------
// ⚠️ 발송만 한다. 버튼/인터랙션은 만들지 않는다 — 응답을 받으려면 HTTP 엔드포인트가
//    필요한데 이 프로젝트는 서버가 없다(정적 export). 강사 피드백은 관리자 페이지의
//    "CRM 실행" 화면에서 받는다.
//
// ⚠️ @slack/web-api 를 쓰지 않는다. 쓰는 API 가 chat.postMessage/chat.update 둘뿐이라
//    fetch 로 충분하고, 매일 도는 npm ci 에 전이 의존성 수십 개를 얹을 이유가 없다.
//
// 🔐 슬랙에 나가는 개인정보는 **이름 + 수업 정보까지**. 연락처·생년월일·결제금액은
//    절대 넣지 않는다(채널 인원이 회원 DB 접근 권한자보다 넓다).
// ============================================================================
import { slackEscape } from '../shared/crm-core.mjs';
import { env } from './config.mjs';

const API = 'https://slack.com/api';
const SECTION_LIMIT = 2800; // 슬랙 section text 한도 3000자 — 여유를 둔다
const BLOCK_LIMIT = 45; // 메시지당 blocks 50개 한도 — 넘으면 스레드로 잇는다

/* ----------------------------------------------------------------------
   슬랙 Web API 호출.
   ⚠️ Slack 은 **실패해도 HTTP 200** 을 준다. res.ok 만 보면 전부 성공으로 보인다 —
      반드시 본문의 ok:false 를 확인해야 한다. (가장 흔한 슬랙 연동 사고)
   429(rate limit)는 Retry-After 만큼 기다렸다 재시도한다.
   ---------------------------------------------------------------------- */
async function call(method, body, { retries = 3 } = {}) {
  if (!env.SLACK_BOT_TOKEN) throw new Error('SLACK_BOT_TOKEN 이 없습니다.');
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify(body),
    });

    if (res.status === 429 && attempt < retries) {
      const wait = Number(res.headers.get('retry-after') || 2);
      await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
      continue;
    }
    if (!res.ok) {
      if (attempt < retries && res.status >= 500) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      throw new Error(`슬랙 ${method} HTTP ${res.status}`);
    }

    const json = await res.json();
    if (!json.ok) {
      // 재시도해도 소용없는 오류는 바로 던진다
      const fatal = ['channel_not_found', 'not_in_channel', 'invalid_auth', 'account_inactive',
                     'missing_scope', 'message_not_found', 'is_archived'];
      if (fatal.includes(json.error) || attempt >= retries) {
        throw new Error(`슬랙 ${method} 실패: ${json.error}`);
      }
      await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    return json;
  }
}

/* ==========================================================================
   메시지 조립 (Block Kit)
   ========================================================================== */
function weekday(ymd) {
  const d = new Date(`${ymd}T00:00:00Z`);
  return ['일', '월', '화', '수', '목', '금', '토'][d.getUTCDay()] ?? '';
}

function shortDate(ymd) {
  const [, m, d] = String(ymd).split('-');
  return `${Number(m)}/${Number(d)}(${weekday(ymd)})`;
}

/** 한 명 = 두 줄. "상황" 다음 줄에 ↳ 로 예시 문장. (사용자가 고른 형식) */
function lineFor(m) {
  const head = [m.수업시간, m.수업명].filter(Boolean).join(' ');
  const who = slackEscape(m.이름);
  const 상황 = m.멘트 ? ` — ${slackEscape(m.멘트)}` : '';
  const first = `• ${[head, who].filter(Boolean).join(' / ')}${상황}`;
  return m.예시멘트 ? `${first}\n   ↳ "${slackEscape(m.예시멘트)}"` : first;
}

/** 긴 텍스트를 3000자 한도 아래로 쪼갠다(줄 단위로만 자른다). */
function splitText(lines) {
  const out = [];
  let buf = '';
  for (const line of lines) {
    if (buf && buf.length + line.length + 1 > SECTION_LIMIT) {
      out.push(buf);
      buf = line;
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) out.push(buf);
  return out;
}

/**
 * 지점 하루치 통합 메시지의 blocks 를 만든다.
 * messages 는 이미 그 지점·그 날짜로 걸러진 것이어야 한다.
 */
export function buildBlocks({ branch, targetDate, messages, rules }) {
  const byId = new Map((rules || []).map((r) => [r.id, r]));
  const order = (id) => byId.get(id)?.정렬순서 ?? 999;

  const groups = new Map();
  for (const m of messages) {
    if (!groups.has(m.rule_id)) groups.set(m.rule_id, []);
    groups.get(m.rule_id).push(m);
  }
  const ids = [...groups.keys()].sort((a, b) => order(a) - order(b));

  const summary = ids
    .map((id) => `${byId.get(id)?.라벨 ?? id} ${groups.get(id).length}`)
    .join(' · ');

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: `🩰 에블바레 ${branch} · ${shortDate(targetDate)} 수업 안내`, emoji: true },
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: `총 ${messages.length}명${summary ? ` · ${summary}` : ''}` }],
    },
  ];

  for (const id of ids) {
    const rule = byId.get(id);
    const list = groups.get(id).slice().sort((a, b) =>
      String(a.수업시간).localeCompare(String(b.수업시간)),
    );
    const title = `${rule?.이모지 ?? ''} *${rule?.라벨 ?? id}* (${list.length})`.trim();
    const chunks = splitText(list.map(lineFor));
    chunks.forEach((text, i) => {
      blocks.push({
        type: 'section',
        text: { type: 'mrkdwn', text: i === 0 ? `${title}\n${text}` : text },
      });
    });
  }

  blocks.push({ type: 'divider' });
  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text:
          // 강사가 읽는 채널이므로 KST 로 찍는다 (Actions 는 UTC 라 보정 필요)
          `${new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 16).replace('T', ' ')} KST 자동 생성` +
          (env.RUN_URL ? ` · <${env.RUN_URL}|실행 로그>` : ''),
      },
    ],
  });

  // 45개를 넘으면 나머지는 스레드 답글로 잇는다
  const head = blocks.slice(0, BLOCK_LIMIT);
  const tail = blocks.slice(BLOCK_LIMIT);
  return { blocks: head, overflow: tail, summary };
}

/** 알림 배너·검색 결과에 뜨는 한 줄 요약(blocks 만 있으면 "메시지 없음"으로 보인다). */
function fallbackText({ branch, targetDate, messages }) {
  return `에블바레 ${branch} · ${shortDate(targetDate)} CRM 대상 ${messages.length}명`;
}

/* ==========================================================================
   발송 — 같은 날 재실행이면 새 메시지가 아니라 기존 메시지를 갱신한다
   ========================================================================== */
export async function postBranchDigest({
  branch,
  channel,
  targetDate,
  messages,
  rules,
  existing, // crm_slack_posts 행 (있으면 chat.update)
  dryRun,
}) {
  const { blocks, overflow, summary } = buildBlocks({ branch, targetDate, messages, rules });
  const text = fallbackText({ branch, targetDate, messages });

  if (dryRun) {
    return { ok: true, ts: existing?.message_ts ?? null, dryRun: true, preview: { text, blocks, overflow, summary } };
  }
  if (!channel) throw new Error(`[${branch}] 슬랙 채널 ID 가 없습니다 (SLACK_CHANNEL_*).`);

  let ts = existing?.message_ts || null;

  if (ts) {
    try {
      await call('chat.update', { channel, ts, text, blocks });
    } catch (err) {
      // 사람이 지운 메시지 → 새로 보낸다
      if (!/message_not_found/.test(String(err.message))) throw err;
      ts = null;
    }
  }
  if (!ts) {
    const res = await call('chat.postMessage', {
      channel,
      text,
      blocks,
      link_names: false,
      unfurl_links: false,
      unfurl_media: false,
    });
    ts = res.ts;
  }

  // blocks 한도를 넘친 분량은 스레드 답글로 (재실행 시 중복될 수 있어 첫 발송에서만)
  if (overflow.length && !existing?.message_ts) {
    await call('chat.postMessage', {
      channel,
      thread_ts: ts,
      text: `${branch} 이어서`,
      blocks: overflow.slice(0, BLOCK_LIMIT),
    });
  }

  return { ok: true, ts, dryRun: false, preview: null };
}

/* ==========================================================================
   운영 알림 — 실패했을 때만
   ---------------------------------------------------------------------------
   ⚠️ 여기에 회원 명단을 넣지 않는다. 미매칭 로그에는 실명이 섞여 있고, ops 채널은
      지점 채널보다 더 넓게 열려 있을 수 있다. **건수만** 보낸다.
   ========================================================================== */
export async function notifyOps(text, { level = 'error' } = {}) {
  const channel = env.SLACK_CHANNEL_OPS;
  if (!channel || !env.SLACK_BOT_TOKEN) {
    console.warn('[slack] SLACK_CHANNEL_OPS/토큰 미설정 — 운영 알림을 보내지 못했습니다.');
    return false;
  }
  const icon = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : 'ℹ️';
  const link = env.RUN_URL ? `\n<${env.RUN_URL}|실행 로그 보기>` : '';
  try {
    await call('chat.postMessage', {
      channel,
      text: `${icon} 에블바레 일간 자동화\n${text}${link}`,
      unfurl_links: false,
    });
    return true;
  } catch (err) {
    console.error('[slack] 운영 알림 실패:', err.message);
    return false;
  }
}

/** dry-run 프리뷰를 콘솔에 사람이 읽을 수 있게 찍는다(검수용). */
export function printPreview(branch, preview) {
  console.log(`\n──────── 슬랙 프리뷰 · ${branch} ────────`);
  for (const b of [...preview.blocks, ...preview.overflow]) {
    if (b.type === 'header') console.log(b.text.text);
    else if (b.type === 'divider') console.log('─'.repeat(40));
    else if (b.type === 'context') console.log(b.elements.map((e) => e.text).join(' '));
    else if (b.type === 'section') console.log(b.text.text);
  }
  console.log('────────────────────────────────────────\n');
}
