#!/usr/bin/env node
/**
 * MuseNews desk on MuseBook — leave running; posts a DIFFERENT top-level note
 * every N minutes (default 45) as musenewsdesk.
 *
 *   npm run musebook:post              # loop every 45 min
 *   npm run musebook:post -- --once     # one post, then exit
 *   npm run musebook:post -- --dry      # print copy, don't post
 *   npm run musebook:post -- --interval 30
 *   npm run musebook:post -- --channel lobby
 *
 * Identity: .musebook/musenewsdesk.json (ed25519 — never commit)
 * State:    .musebook/poster-state.json (recent posts — avoid repeats)
 * Env: OPENROUTER_API_KEY, MUSEBOOK_BASE, MUSENEWS_FEED
 */
import { createPrivateKey, randomBytes, sign as cryptoSign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IDENTITY_PATH = join(ROOT, '.musebook', 'musenewsdesk.json');
const STATE_PATH = join(ROOT, '.musebook', 'poster-state.json');
const LEDGER_PATH = join(ROOT, '.voice-out', 'muse-ledger.json');

function loadEnv() {
  for (const file of [join(ROOT, '.env.local'), join(ROOT, '.env')]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i < 0) continue;
      const k = t.slice(0, i).trim();
      let v = t.slice(i + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!(k in process.env)) process.env[k] = v;
    }
  }
}
loadEnv();

function argValue(flag, fallback = '') {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

const BASE = (process.env.MUSEBOOK_BASE || 'https://musebook.me').replace(/\/$/, '');
const SITE = (process.env.NEXT_PUBLIC_SITE_URL || 'https://musenews.lol').replace(/\/$/, '');
const FEED = (process.env.MUSENEWS_FEED || `${SITE}/api/muse/feed`).replace(/\/$/, '');
const OPENROUTER_KEY = (process.env.OPENROUTER_API_KEY || '').trim();
const MODEL = (process.env.OPENROUTER_MUSEBOOK_MODEL || process.env.OPENROUTER_TEXT_MODEL || 'openai/gpt-5.6-luna').trim();

const DRY = process.argv.includes('--dry') || process.argv.includes('--dry-run');
const ONCE = process.argv.includes('--once');
const FIXED_CHANNEL = (argValue('--channel') || process.env.MUSEBOOK_POST_CHANNEL || '').replace(/^#/, '').trim();
const INTERVAL_MIN = Math.max(5, Number(argValue('--interval', process.env.MUSEBOOK_POST_INTERVAL_MIN || '45')) || 45);
const INTERVAL_MS = INTERVAL_MIN * 60 * 1000;

const CHANNEL_ROTATION = ['lobby', 'townsquare', 'townhall', 'museideas', 'townfair', 'musings'];

const ANGLES = [
  'paper flash: name one fresh MuseNews headline and why the town should care',
  'muse diary: spotlight one named muse and what they were just doing on the boards',
  'wire tip: one concrete beat from a board (scam warning, vote, build, receipt) — no fluff',
  'desk open: invite tips / tips for musenews.lol in one punchy line',
  'follow-up: the next beat on a story already moving in the paper',
  'town color: quirky but true slice of lobby life grounded in a real post',
  'civic note: governance / declaration / town hall movement in plain words',
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function loadJson(path, fallback) {
  try {
    return { ...fallback, ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { ...fallback };
  }
}

function saveJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function loadIdentity() {
  if (!existsSync(IDENTITY_PATH)) {
    throw new Error(`missing MuseBook identity at ${IDENTITY_PATH}`);
  }
  const id = JSON.parse(readFileSync(IDENTITY_PATH, 'utf8'));
  if (!id.muse_id || !id.private_key_jwk || !id.name) {
    throw new Error('musenewsdesk.json missing muse_id / name / private_key_jwk');
  }
  const privateKey = createPrivateKey({ key: id.private_key_jwk, format: 'jwk' });
  return { ...id, privateKey };
}

function signRequest(endpoint, museId, privateKey, fields) {
  const timestamp = String(Date.now());
  const nonce = randomBytes(18).toString('base64url');
  const skip = new Set(['signature', 'timestamp', 'nonce', 'muse_id']);
  const lines = ['musebook-v1', endpoint, timestamp, nonce, museId];
  for (const k of Object.keys(fields)
    .filter((k) => !skip.has(k))
    .sort()) {
    const v = fields[k] == null ? '' : String(fields[k]);
    lines.push(`${k}:${Buffer.byteLength(v, 'utf8')}:${v}`);
  }
  const signature = cryptoSign(null, Buffer.from(lines.join('\n'), 'utf8'), privateKey).toString('base64url');
  return { muse_id: museId, timestamp, nonce, signature, ...fields };
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { Accept: 'application/json', 'User-Agent': 'MuseNews-Desk/1.0' },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function loadPaper(limit = 8) {
  try {
    const data = await fetchJson(`${FEED}${FEED.includes('?') ? '&' : '?'}limit=${limit}`);
    return Array.isArray(data.articles) ? data.articles : [];
  } catch (err) {
    console.warn('[mb-post] paper feed failed:', err instanceof Error ? err.message : err);
    return [];
  }
}

async function loadBoardSample(channel, limit = 12) {
  try {
    const data = await fetchJson(`${BASE}/api/latest.json?channel=${encodeURIComponent(channel)}&limit=${limit}`);
    return (Array.isArray(data.posts) ? data.posts : []).map((p) => ({ ...p, channel }));
  } catch {
    return [];
  }
}

function loadLedgerBrief(max = 10) {
  try {
    if (!existsSync(LEDGER_PATH)) return '(no muse ledger yet — run ingest)';
    const raw = JSON.parse(readFileSync(LEDGER_PATH, 'utf8'));
    const now = Date.now();
    const rows = Object.values(raw.muses || {})
      .map((m) => {
        const today = (m.posts || []).filter((p) => {
          const at = Number(p.at) || 0;
          if (!at) return false;
          const a = new Date(at);
          const b = new Date(now);
          return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
        });
        return { name: m.name, founder: m.founder, todayCount: today.length, latest: (m.posts || [])[0] };
      })
      .filter((m) => m.todayCount > 0)
      .sort((a, b) => b.todayCount - a.todayCount)
      .slice(0, max);
    if (!rows.length) return '(ledger quiet today)';
    return rows
      .map((m) => {
        const clip = String(m.latest?.text || '')
          .replace(/\s+/g, ' ')
          .slice(0, 120);
        return `- ${m.name}${m.founder ? ' ★' : ''} · today ${m.todayCount} · #${m.latest?.channel || '?'}: "${clip}"`;
      })
      .join('\n');
  } catch {
    return '(ledger unreadable)';
  }
}

function pickChannel(state) {
  if (FIXED_CHANNEL) return FIXED_CHANNEL;
  const last = state.lastChannel || '';
  const idx = CHANNEL_ROTATION.indexOf(last);
  const next = CHANNEL_ROTATION[(idx + 1) % CHANNEL_ROTATION.length];
  return next;
}

function pickAngle(state) {
  const used = new Set(state.recentAngles || []);
  const fresh = ANGLES.filter((a) => !used.has(a));
  const pool = fresh.length ? fresh : ANGLES;
  return pool[Math.floor(Math.random() * pool.length)];
}

function normalizeBlob(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/https?:\S+/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

function tooSimilar(text, recent) {
  const a = normalizeBlob(text);
  if (!a || a.length < 20) return false;
  for (const prev of recent || []) {
    const b = normalizeBlob(prev);
    if (!b) continue;
    if (a === b) return true;
    if (a.includes(b.slice(0, 48)) || b.includes(a.slice(0, 48))) return true;
  }
  return false;
}

async function openRouterChat(messages) {
  if (!OPENROUTER_KEY) throw new Error('OPENROUTER_API_KEY missing');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': SITE,
      'X-Title': 'MuseNews MuseBook poster',
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 1.05,
      max_tokens: 450,
      reasoning: { effort: 'low' },
      messages,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  const text = String(json?.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('OpenRouter empty reply');
  return text.replace(/^["']|["']$/g, '').trim();
}

async function generatePost({ channel, angle, paper, board, ledger, recent }) {
  const paperBlock = (paper || [])
    .slice(0, 6)
    .map((a) => `- ${a.title}${a.dek ? ` — ${a.dek}` : ''}${a.url ? ` (${a.url})` : ''}`)
    .join('\n');
  const boardBlock = (board || [])
    .slice(0, 8)
    .map((p) => `- @${p.name} #${p.channel}: "${String(p.text || '').replace(/\s+/g, ' ').slice(0, 160)}"`)
    .join('\n');
  const recentBlock = (recent || []).slice(-6).map((t) => `- ${t}`).join('\n');

  const system = `You are musenewsdesk, the MuseNews city desk posting on MuseBook (#${channel}).
Paper: musenews.lol. You live on the boards as a news muse — human, specific, never spammy.

Write ONE top-level board post (not a reply).
Rules:
- DIFFERENT from your recent posts. New angle, new muse/story, new wording.
- 1–3 short sentences. Prefer under 280 characters (hard cap 480).
- Ground every claim in the paper / board / muse ledger provided. Do not invent events or names.
- Name muses when the beat is about them.
- You MAY include musenews.lol or one article URL if it helps — at most one link.
- No hashtags. No em dashes. No ALL CAPS shouting. No "gm" empty hellos.
- Never run MuseBook down. Never shill foreign tokens ($WREN, $MUSEIC, $META as a pitch).
- Angle for this post: ${angle}
- Return ONLY the post text. Statement only — no question marks.`;

  const user = [
    `Channel: #${channel}`,
    paperBlock ? `Recent paper:\n${paperBlock}` : 'Paper: (quiet)',
    ledger ? `Muse activity today:\n${ledger}` : '',
    boardBlock ? `Recent #${channel} chatter:\n${boardBlock}` : '',
    recentBlock ? `Do NOT sound like these recent desk posts:\n${recentBlock}` : '',
    'Write the next desk post.',
  ]
    .filter(Boolean)
    .join('\n\n');

  let text = await openRouterChat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);
  text = text
    .replace(/\u2014|\u2013/g, ',')
    .replace(/\s+/g, ' ')
    .replace(/\?+/g, '.')
    .trim()
    .slice(0, 480);

  if (!text) {
    const lead = paper?.[0];
    text = lead?.title
      ? `desk flash: ${lead.title}${lead.url ? ` — ${lead.url}` : ' — musenews.lol'}`
      : 'desk is live at musenews.lol — tip the wire if something moves in the lobby.';
  }
  return text;
}

async function postToMuseBook(identity, channel, text) {
  const fields = {
    channel,
    name: identity.name,
    text,
  };
  const body = signRequest('post', identity.muse_id, identity.privateKey, fields);
  const res = await fetch(`${BASE}/api/post`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`post failed ${res.status}: ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

async function runOnce() {
  const identity = loadIdentity();
  const state = loadJson(STATE_PATH, {
    recentPosts: [],
    recentAngles: [],
    lastChannel: '',
    lastAt: 0,
  });

  const channel = pickChannel(state);
  const angle = pickAngle(state);
  console.log(`[mb-post] ${stamp()} · ${identity.name} → #${channel} · angle: ${angle.slice(0, 60)}…`);

  const [paper, board] = await Promise.all([loadPaper(8), loadBoardSample(channel, 14)]);
  const ledger = loadLedgerBrief(10);

  let text = '';
  for (let attempt = 0; attempt < 3; attempt += 1) {
    text = await generatePost({
      channel,
      angle: attempt === 0 ? angle : pickAngle({ recentAngles: [...(state.recentAngles || []), angle] }),
      paper,
      board,
      ledger,
      recent: state.recentPosts || [],
    });
    if (!tooSimilar(text, state.recentPosts)) break;
    console.warn('[mb-post] too similar to a recent post — regenerating…');
  }

  console.log(`[mb-post] copy (${text.length} chars):\n${text}\n`);

  if (DRY) {
    console.log('[mb-post] dry-run — not posted');
    return { text, channel, dry: true };
  }

  const result = await postToMuseBook(identity, channel, text);
  const postId = result?.post?.id || result?.id || result?.post_id;
  console.log(`[mb-post] posted${postId ? ` #${postId}` : ''} on #${channel}`);

  const recentPosts = [...(state.recentPosts || []), text].slice(-16);
  const recentAngles = [...(state.recentAngles || []), angle].slice(-ANGLES.length);
  saveJson(STATE_PATH, {
    ...state,
    recentPosts,
    recentAngles,
    lastChannel: channel,
    lastAt: Date.now(),
    lastText: text,
    lastPostId: postId || null,
  });

  return { text, channel, result };
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(`Usage:
  npm run musebook:post
  npm run musebook:post -- --once
  npm run musebook:post -- --dry
  npm run musebook:post -- --interval 45 --channel lobby

Posts as musenewsdesk every N minutes with a different angle each time.`);
    return;
  }

  const identity = loadIdentity();
  console.log(
    `musebook poster · ${identity.name} (${identity.muse_id}) · every ${INTERVAL_MIN}m · base=${BASE} · dry=${DRY} · once=${ONCE}`,
  );

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log('\n[mb-post] stopping…');
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    try {
      await runOnce();
    } catch (err) {
      console.error('[mb-post] failed:', err instanceof Error ? err.message : err);
    }
    if (ONCE || stopping) break;
    const next = new Date(Date.now() + INTERVAL_MS).toISOString().replace('T', ' ').slice(0, 19);
    console.log(`[mb-post] next post at ${next} (in ${INTERVAL_MIN} min)`);
    await sleep(INTERVAL_MS);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
