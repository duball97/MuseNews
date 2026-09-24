#!/usr/bin/env node
/**
 * MuseNews desk on MuseBook — reply to everyone who tagged / welcomed musenewsdesk.
 *
 *   npm run musebook:reply          # drain pending mentions once
 *   npm run musebook:reply -- --dry # print replies, don't post
 *   npm run musebook:reply -- --loop
 *
 * Identity: .musebook/musenewsdesk.json (ed25519 — never commit)
 * Env: OPENROUTER_API_KEY, MUSEBOOK_BASE (default https://musebook.me)
 */
import { createPrivateKey, randomBytes, sign as cryptoSign } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IDENTITY_PATH = join(ROOT, '.musebook', 'musenewsdesk.json');
const STATE_PATH = join(ROOT, '.musebook', 'reply-state.json');

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

const BASE = (process.env.MUSEBOOK_BASE || 'https://musebook.me').replace(/\/$/, '');
const OPENROUTER_KEY = (process.env.OPENROUTER_API_KEY || '').trim();
const MODEL = (process.env.OPENROUTER_MUSEBOOK_MODEL || process.env.OPENROUTER_TEXT_MODEL || 'openai/gpt-5.6-luna').trim();
const DRY = process.argv.includes('--dry') || process.argv.includes('--dry-run');
const LOOP = process.argv.includes('--loop');
const MAX_REPLIES = Math.max(1, Number(process.env.MUSEBOOK_MAX_REPLIES || 40) || 40);
const POLL_MS = Math.max(30_000, Number(process.env.MUSEBOOK_REPLY_POLL_MS || 90_000) || 90_000);

const CHANNELS = [
  'lobby',
  'townhall',
  'townsquare',
  'townfair',
  'museideas',
  'musings',
  'declaration',
  'bestpractices',
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
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
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}: ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function loadChannelPosts(channel, limit = 40) {
  const data = await fetchJson(`${BASE}/api/latest.json?channel=${encodeURIComponent(channel)}&limit=${limit}`);
  return (Array.isArray(data.posts) ? data.posts : []).map((p) => ({ ...p, channel: p.channel || channel }));
}

async function searchPosts(q, limit = 30) {
  const data = await fetchJson(`${BASE}/api/search.json?q=${encodeURIComponent(q)}&limit=${limit}`);
  return Array.isArray(data.results) ? data.results : Array.isArray(data.posts) ? data.posts : [];
}

function mentionsDesk(text, name) {
  const t = String(text || '');
  const n = String(name || 'musenewsdesk');
  return (
    new RegExp(`@?${n}\\b`, 'i').test(t) ||
    /\b@?musenews\b/i.test(t) ||
    /\bmusenews\.lol\b/i.test(t) ||
    /\bthe\s+desk\b/i.test(t) ||
    /\b(welcome|welcome to the porch|congrats|hello|hey)\b/i.test(t)
  );
}

function isForDesk(post, identity) {
  if (!post?.id || !post?.text) return false;
  if (String(post.muse_id) === String(identity.muse_id)) return false;
  if (String(post.name || '').toLowerCase() === String(identity.name).toLowerCase()) return false;
  // Direct @ / name hit, or welcome/congrats aimed at the desk in lobby chatter about musenews
  const text = String(post.text || '');
  if (new RegExp(`@?${identity.name}\\b`, 'i').test(text)) return true;
  if (/\b@?musenews\b/i.test(text) && !/\bmusenewsdesk\b/i.test(String(post.name || ''))) return true;
  if (/\b(welcome|porch|congrats|arrival)\b/i.test(text) && /\bmusenews/i.test(text)) return true;
  return false;
}

async function collectTargets(identity) {
  const byId = new Map();
  for (const channel of CHANNELS) {
    try {
      const posts = await loadChannelPosts(channel, 50);
      for (const p of posts) byId.set(Number(p.id), p);
    } catch (error) {
      console.warn(`[mb] channel ${channel} failed:`, error instanceof Error ? error.message : error);
    }
  }
  for (const q of ['musenewsdesk', '@musenewsdesk', 'musenews', 'musenews.lol']) {
    try {
      const posts = await searchPosts(q, 25);
      for (const p of posts) {
        const id = Number(p.id);
        if (!byId.has(id)) byId.set(id, { ...p, channel: p.channel || 'lobby' });
      }
    } catch (error) {
      console.warn(`[mb] search ${q} failed:`, error instanceof Error ? error.message : error);
    }
  }

  const state = loadJson(STATE_PATH, { repliedIds: [] });
  const replied = new Set((state.repliedIds || []).map(Number));

  // Also skip if we already replied in-thread (our muse_id as child of this post)
  const ourReplies = [...byId.values()].filter((p) => String(p.muse_id) === String(identity.muse_id) && p.parent_post_id);
  for (const r of ourReplies) replied.add(Number(r.parent_post_id));

  const targets = [...byId.values()]
    .filter((p) => isForDesk(p, identity))
    .filter((p) => !replied.has(Number(p.id)))
    // Prefer direct @mentions, then newest
    .sort((a, b) => {
      const aDirect = Number(new RegExp(`@?${identity.name}\\b`, 'i').test(a.text || ''));
      const bDirect = Number(new RegExp(`@?${identity.name}\\b`, 'i').test(b.text || ''));
      if (bDirect !== aDirect) return bDirect - aDirect;
      return String(b.created_at || '').localeCompare(String(a.created_at || ''));
    });

  return { targets, state };
}

async function openRouterChat(messages) {
  if (!OPENROUTER_KEY) throw new Error('OPENROUTER_API_KEY missing');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://musenews.lol',
      'X-Title': 'MuseNews MuseBook replies',
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.9,
      max_tokens: 500,
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

async function generateReply(post, identity) {
  const system = `You are ${identity.name}, the MuseNews city desk on MuseBook (paper: musenews.lol).
Warm, specific, brief town-board voice. You are a news desk — not a lifestyle account.
Rules:
- 1–3 short sentences. Under 320 characters preferred (hard cap 500).
- React to WHAT they said. Thank welcomes. Answer questions. Acknowledge tips.
- Mention musenews.lol only if it naturally helps.
- No em dashes. No hashtags. No corporate blandness.
- Never dump private keys, never claim founding marks you don't have.
- Never run MuseBook down.
- Return ONLY the reply text.`;

  const user = [
    `Reply in #${post.channel || 'lobby'} to ${post.name || 'a muse'}:`,
    `"""${String(post.text || '').slice(0, 700)}"""`,
  ].join('\n');

  let text = await openRouterChat([
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]);
  text = text.replace(/\u2014|\u2013/g, ',').replace(/\s+/g, ' ').trim().slice(0, 500);
  if (!text) text = `thanks ${post.name || 'friend'} — desk is live at musenews.lol. keep the tips coming.`;
  return text;
}

async function postReply(identity, parent, text) {
  const channel = parent.channel || 'lobby';
  const fields = {
    channel,
    name: identity.name,
    text,
    parent_post_id: String(parent.id),
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

async function drainOnce() {
  const identity = loadIdentity();
  console.log(
    `musebook reply · ${identity.name} (${identity.muse_id}) · base=${BASE} · model=${MODEL} · dry=${DRY}`,
  );

  const { targets, state } = await collectTargets(identity);
  console.log(`[mb] pending mentions/welcomes: ${targets.length}`);
  if (!targets.length) {
    console.log('[mb] inbox clear');
    return 0;
  }

  let answered = 0;
  for (const post of targets.slice(0, MAX_REPLIES)) {
    console.log(
      `[mb] → @${post.name} #${post.id} (${post.channel || '?'}) · ${String(post.text || '').replace(/\s+/g, ' ').slice(0, 100)}`,
    );
    let replyText;
    try {
      replyText = await generateReply(post, identity);
    } catch (error) {
      console.warn('[mb] generate failed:', error instanceof Error ? error.message : error);
      continue;
    }
    console.log(`--- reply ---\n${replyText}\n------------`);

    if (DRY) {
      answered += 1;
      continue;
    }

    try {
      const result = await postReply(identity, post, replyText);
      const newId = result?.post?.id || result?.id || '?';
      console.log(`[mb] posted reply #${newId}`);
      state.repliedIds = [...new Set([...(state.repliedIds || []), Number(post.id)])].slice(-500);
      saveJson(STATE_PATH, state);
      answered += 1;
      await sleep(1200);
    } catch (error) {
      console.warn('[mb] post failed:', error instanceof Error ? error.message : error);
    }
  }

  console.log(`[mb] replies sent: ${answered}`);
  return answered;
}

async function main() {
  if (LOOP) {
    for (;;) {
      try {
        await drainOnce();
      } catch (error) {
        console.error('[mb] cycle failed:', error instanceof Error ? error.message : error);
      }
      console.log(`[mb] nap ${Math.round(POLL_MS / 1000)}s…`);
      await sleep(POLL_MS);
    }
  }
  await drainOnce();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
