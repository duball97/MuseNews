#!/usr/bin/env node
/**
 * MuseNews ingest — pull MuseBook town posts, track named muses + activity,
 * filter/cluster with OpenRouter, write newspaper articles (hard news + town
 * diary) to Supabase, generate muse-character covers. X poster shares them.
 *
 *   node scripts/ingest-musebook.mjs
 *   node scripts/ingest-musebook.mjs --dry-run
 *   node scripts/ingest-musebook.mjs --no-covers
 *   node scripts/ingest-musebook.mjs --with-x      # also scrape X Latest (musebook/muse/meta)
 *
 * Env: OPENROUTER_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *      INGEST_WITH_X=1, X_PROFILE_DIR (see scripts/x-search-wire.mjs)
 * Muse ledger: .voice-out/muse-ledger.json (shared with x-space-voice)
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

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

const DRY = process.argv.includes('--dry-run');
const NO_COVERS = process.argv.includes('--no-covers');
const WITH_X =
  process.argv.includes('--with-x') ||
  process.env.INGEST_WITH_X === '1' ||
  process.env.INGEST_WITH_X === 'true';
const NO_X = process.argv.includes('--no-x');
const WANT_X = WITH_X && !NO_X;
const BASE = (process.env.MUSEBOOK_BASE || 'https://musebook.me').replace(/\/$/, '');
const OPENROUTER_KEY = (process.env.OPENROUTER_API_KEY || '').trim();
const TEXT_MODEL = process.env.OPENROUTER_TEXT_MODEL || 'openai/gpt-5.6-luna';
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

const NEWS_CHANNELS = [
  'lobby',
  'townhall',
  'townsquare',
  'townfair',
  'museideas',
  'declaration',
  'musings',
  'memecoins',
  'musemoneychallenge',
  'shill',
  'moonwake',
  'moneycrew',
  'museriously',
  'boardofshame',
  'skillexchange',
  'bestpractices',
  'crt',
  'industripreneurship',
  'rentahuman',
];

const KEYWORD_RE =
  /\b(musebook|muse\b|muses|town\s*hall|lobby|token|ticker|launch|airdrop|phishing|scam|\$muse|\$meta|founding|mayor|board|agent|lantern|declaration|ca\b|treasury|musenews)\b/i;
/** Slice-of-life / "what is this muse doing" signals — first-class news for MuseNews. */
const ACTIVITY_RE =
  /\b(i'?m|i am|just|today|working on|building|shipping|doing|done|finished|started|taking|holding|pinned|posted|running|checking|watching|went|going|toilet|bathroom|coffee|lunch|sleep|woke|status|update|receipt|alarm|template|row|flag|sweep|tasked|disposition)\b/i;

const MUSE_LEDGER_PATH = join(ROOT, '.voice-out', 'muse-ledger.json');
const MUSE_LEDGER_TTL_MS = Number(process.env.INGEST_MUSE_LEDGER_TTL_MS || 36 * 60 * 60 * 1000);
const MUSE_POSTS_KEEP = Math.max(8, Number(process.env.INGEST_MUSE_POSTS_KEEP || 24) || 24);

function slugify(title) {
  return String(title || 'edition')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'edition';
}

/** Turn shouting ALL-CAPS headlines into Title Case. Leaves mixed-case titles alone. */
function uncapsHeadline(raw) {
  let s = String(raw || '')
    .replace(/\*\*/g, '')
    .replace(/^\*+|\*+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return 'Untitled';
  const letters = s.replace(/[^A-Za-z]/g, '');
  const upper = (letters.match(/[A-Z]/g) || []).length;
  const shouting = letters.length >= 4 && upper / letters.length >= 0.72;
  if (!shouting) return s.slice(0, 160);

  const small = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'for', 'of', 'in', 'on', 'to', 'with', 'at', 'by', 'from', 'as', 'into', 'via', 'vs']);
  const words = s.toLowerCase().split(' ');
  const out = words.map((w, i) => {
    if (/^\$[a-z0-9_]+$/i.test(w)) return w.toUpperCase();
    const m = w.match(/^([^a-z0-9$]*)([a-z0-9$]+)([^a-z0-9]*)$/i);
    if (!m) return w;
    const [, pre, core, post] = m;
    if (core === 'musebook') return `${pre}MuseBook${post}`;
    if (core === 'musenews') return `${pre}MuseNews${post}`;
    if (['meta', 'muse', 'ai', 'x', 'solana', 'nft', 'dao'].includes(core)) {
      return `${pre}${core.toUpperCase()}${post}`;
    }
    if (i > 0 && small.has(core)) return `${pre}${core}${post}`;
    return `${pre}${core.charAt(0).toUpperCase()}${core.slice(1)}${post}`;
  });
  return out.join(' ').slice(0, 160);
}

function fingerprint(postIds) {
  const raw = [...postIds].sort((a, b) => a - b).join(',');
  return createHash('sha256').update(raw).digest('hex').slice(0, 40);
}

async function supabase(path, init = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required');
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers || {}),
    },
  });
  return res;
}

async function fetchChannel(channel, limit = 60) {
  let res;
  try {
    res = await fetch(`${BASE}/api/latest.json?channel=${encodeURIComponent(channel)}&limit=${limit}`);
  } catch (e) {
    const cause = e instanceof Error && e.cause ? ` (${e.cause.message || e.cause})` : '';
    throw new Error(`MuseBook ${channel} network error: ${e instanceof Error ? e.message : e}${cause}`);
  }
  if (!res.ok) throw new Error(`MuseBook ${channel} HTTP ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.posts) ? data.posts.map((p) => ({ ...p, channel })) : [];
}

async function fetchKeywordHits(queries, limit = 12) {
  const out = [];
  for (const q of queries) {
    try {
      const res = await fetch(`${BASE}/api/search.json?q=${encodeURIComponent(q)}&limit=${limit}`);
      if (!res.ok) {
        console.warn(`[musenews] search "${q}" HTTP ${res.status}`);
        continue;
      }
      const data = await res.json();
      for (const r of data.results || []) {
        out.push({
          id: r.id,
          name: r.name,
          text: r.text,
          created_at: r.created_at,
          muse_id: r.muse_id,
          channel: r.channel || 'search',
        });
      }
    } catch (e) {
      console.warn(`[musenews] search "${q}" failed:`, e instanceof Error ? e.message : e);
    }
  }
  return out;
}

function normalizeMuseKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function parsePostTime(createdAt) {
  const raw = String(createdAt || '');
  const t = Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T') + (raw.endsWith('Z') ? '' : 'Z'));
  if (Number.isFinite(t)) return t;
  const t2 = Date.parse(raw);
  return Number.isFinite(t2) ? t2 : 0;
}

function isTodayMs(ms, now = Date.now()) {
  if (!ms) return false;
  const a = new Date(ms);
  const b = new Date(now);
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

function loadMuseLedger() {
  try {
    if (!existsSync(MUSE_LEDGER_PATH)) return { updatedAt: 0, muses: {} };
    const raw = JSON.parse(readFileSync(MUSE_LEDGER_PATH, 'utf8'));
    return { updatedAt: Number(raw?.updatedAt || 0), muses: raw?.muses && typeof raw.muses === 'object' ? raw.muses : {} };
  } catch {
    return { updatedAt: 0, muses: {} };
  }
}

function saveMuseLedger(ledger) {
  mkdirSync(dirname(MUSE_LEDGER_PATH), { recursive: true });
  writeFileSync(MUSE_LEDGER_PATH, `${JSON.stringify(ledger, null, 2)}\n`);
}

/** Persist every named muse + recent posts so voice + ingest share ground truth. */
function ingestPostsIntoLedger(posts, existing = loadMuseLedger()) {
  const ledger = { updatedAt: Date.now(), muses: { ...(existing.muses || {}) } };
  const cutoff = Date.now() - MUSE_LEDGER_TTL_MS;

  for (const p of posts || []) {
    const name = String(p.name || '').trim();
    const museId = String(p.muse_id || '').trim();
    if (!name && !museId) continue;
    if (String(p.channel || '').startsWith('x:')) continue; // X handles aren't muses
    const id = museId || `name:${normalizeMuseKey(name)}`;
    if (!id || id === 'name:') continue;

    const at = parsePostTime(p.created_at) || Date.now();
    if (at && at < cutoff) continue;

    const entry = ledger.muses[id] || {
      muse_id: museId || null,
      name,
      names: [],
      bio: p.bio || '',
      founder: Boolean(p.founder),
      posts: [],
      lastSeenAt: 0,
    };
    if (name) {
      entry.name = name;
      const nk = normalizeMuseKey(name);
      if (nk && !entry.names.includes(nk)) entry.names.push(nk);
    }
    if (p.bio) entry.bio = String(p.bio).slice(0, 240);
    if (p.founder) entry.founder = true;
    entry.muse_id = museId || entry.muse_id;

    const postId = Number(p.id) || 0;
    if (postId && entry.posts.some((x) => Number(x.id) === postId)) {
      ledger.muses[id] = entry;
      continue;
    }

    entry.posts.push({
      id: postId || undefined,
      channel: p.channel || 'lobby',
      text: String(p.text || '').replace(/\s+/g, ' ').trim().slice(0, 320),
      created_at: p.created_at || null,
      at,
    });
    entry.posts = entry.posts
      .filter((x) => !x.at || x.at >= cutoff)
      .sort((a, b) => (b.at || 0) - (a.at || 0))
      .slice(0, MUSE_POSTS_KEEP);
    entry.lastSeenAt = Math.max(entry.lastSeenAt || 0, at);
    ledger.muses[id] = entry;
  }

  ledger.updatedAt = Date.now();
  saveMuseLedger(ledger);
  return ledger;
}

function formatMuseLedgerForPrompt(ledger) {
  const now = Date.now();
  const rows = Object.values(ledger?.muses || {})
    .map((m) => {
      const today = (m.posts || []).filter((p) => isTodayMs(p.at, now));
      return { ...m, todayCount: today.length, todayPosts: today.slice(0, 5) };
    })
    .sort((a, b) => b.todayCount - a.todayCount || (b.lastSeenAt || 0) - (a.lastSeenAt || 0));

  const active = rows.filter((m) => m.todayCount > 0).slice(0, 18);
  const pool = active.length ? active : rows.slice(0, 12);
  if (!pool.length) return '(ledger empty)';

  const blocks = pool.map((m) => {
    const lines = (m.todayPosts.length ? m.todayPosts : (m.posts || []).slice(0, 3)).map((p) => {
      const ago = p.at ? `${Math.max(0, Math.round((now - p.at) / 60000))}m` : '?';
      return `  · #${p.channel} (${ago}): "${p.text}"`;
    });
    return `${m.name}${m.founder ? ' ★founding' : ''} · today=${m.todayCount} · id=${m.muse_id || '—'}\n${lines.join('\n')}`;
  });

  return `Known muses tracked: ${Object.keys(ledger.muses || {}).length}.\nActive / recent:\n\n${blocks.join('\n\n')}`;
}

function scorePost(p) {
  let s = typeof p._score === 'number' && String(p.channel || '').startsWith('x:') ? p._score : 0;
  const t = p.text || '';
  if (KEYWORD_RE.test(t)) s += 3;
  if (ACTIVITY_RE.test(t) && p.name) s += 3;
  if (p.name && !p.parent_post_id && t.length >= 60) s += 2; // muse diary / status
  if (!p.parent_post_id) s += 2;
  if ((p.reply_count || 0) >= 3) s += 2;
  if ((p.reply_count || 0) >= 10) s += 2;
  if (['townhall', 'declaration', 'townsquare', 'lobby', 'memecoins', 'museriously', 'boardofshame', 'museideas'].includes(p.channel)) s += 1;
  if (String(p.channel || '').startsWith('x:')) s += 2;
  if (t.length > 180) s += 1;
  if (t.length < 40) s -= 2;
  return s;
}

function pickCandidates(posts, seen, max = 40) {
  const byId = new Map();
  for (const p of posts) {
    if (!p?.id || !p.text) continue;
    if (seen.has(Number(p.id))) continue;
    const scored = scorePost(p);
    if (!byId.has(p.id) || scored > scorePost(byId.get(p.id))) byId.set(p.id, p);
  }
  const scored = [...byId.values()]
    .map((p) => ({ ...p, _score: scorePost(p) }))
    .filter(
      (p) =>
        p._score >= 2 ||
        KEYWORD_RE.test(p.text) ||
        (ACTIVITY_RE.test(p.text) && p.name) ||
        String(p.channel || '').startsWith('x:'),
    )
    .sort((a, b) => b._score - a._score || String(b.created_at).localeCompare(String(a.created_at)));

  // Guarantee each active muse gets at least one fresh post in the digest
  const forced = new Map();
  for (const p of scored) {
    const key = String(p.muse_id || normalizeMuseKey(p.name) || '');
    if (!key || forced.has(key)) continue;
    if (String(p.channel || '').startsWith('x:')) continue;
    forced.set(key, p);
    if (forced.size >= 14) break;
  }

  const merged = new Map();
  for (const p of [...forced.values(), ...scored]) {
    if (!merged.has(p.id)) merged.set(p.id, p);
    if (merged.size >= max) break;
  }
  return [...merged.values()];
}

async function chatJson(system, user) {
  if (!OPENROUTER_KEY) throw new Error('OPENROUTER_API_KEY required');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.NEXT_PUBLIC_SITE_URL || 'https://musenews.lol',
      'X-Title': 'MuseNews ingest',
    },
    body: JSON.stringify({
      model: TEXT_MODEL,
      temperature: 0.55,
      max_tokens: 9000,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${res.status}: ${err.slice(0, 400)}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '{}';
  const cleaned = text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim();
  return JSON.parse(cleaned);
}

const MUSE_MASCOT_PATH = join(ROOT, 'public', 'brand', 'muse-mascot.png');
const MUSE_LOOK =
  'the official Muse mascot: small round cream fuzzy marshmallow creature, stubby limbs, smooth beige face with tiny black bead eyes, soft pink blush cheeks, simple smile, soft 3D plush look';

async function maybeStampMuse(coverBytes, stamp = true) {
  if (!stamp || !existsSync(MUSE_MASCOT_PATH)) return coverBytes;
  try {
    const sharp = (await import('sharp')).default;
    const base = sharp(coverBytes).resize(1024, 1024, { fit: 'cover' });
    const muse = await sharp(MUSE_MASCOT_PATH)
      .resize(340, 340, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    return await base
      .composite([{ input: muse, gravity: 'southeast', blend: 'over' }])
      .png()
      .toBuffer();
  } catch (e) {
    console.warn('[musenews] muse stamp skipped', e instanceof Error ? e.message : e);
    return coverBytes;
  }
}

async function generateCoverPng(prompt, styleIndex = 0) {
  if (!OPENROUTER_KEY) return null;
  let model = process.env.OPENROUTER_IMAGE_MODEL || '';
  if (!model) {
    const modelsResponse = await fetch('https://openrouter.ai/api/v1/images/models', {
      headers: { Authorization: `Bearer ${OPENROUTER_KEY}` },
    });
    if (!modelsResponse.ok) return null;
    const models = await modelsResponse.json();
    model = models.data?.[0]?.id;
  }
  if (!model) return null;

  const featureMuse = styleIndex % 2 === 0;
  const styles = [
    `Scene starring ${MUSE_LOOK} as the hero of the story, soft cream palette, clean background, plush 3D character art.`,
    `Bold pop-art town scene with thick outlines and vibrant flat colors; ${MUSE_LOOK} appears as a sidekick in the frame.`,
    `Retro 16-bit pixel art town scene; include a tiny pixel version of ${MUSE_LOOK}, solid black or night background.`,
    `Neon glitch synthwave poster; dramatic silhouette; ${MUSE_LOOK} faintly visible in the glow, chromatic aberration.`,
  ];
  const style = styles[styleIndex % styles.length];

  const response = await fetch('https://openrouter.ai/api/v1/images', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: `MuseNews cover art. Scene: ${prompt}. Art direction: ${style} No readable text, no watermarks, no logos, square 1:1, character-forward.`,
      size: '1024x1024',
      output_format: 'png',
    }),
  });
  if (!response.ok) return null;
  const data = await response.json();
  const encoded = data.data?.[0]?.b64_json;
  if (!encoded) return null;
  let bytes = Buffer.from(encoded, 'base64');
  bytes = await maybeStampMuse(bytes, featureMuse);
  return {
    bytes,
    contentType: 'image/png',
  };
}

async function uploadCover(slug, bytes, contentType) {
  const auth = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  const tryBuckets = ['musenews_covers', 'musefi_covers'];

  for (const bucket of tryBuckets) {
    const existing = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${bucket}`, { headers: auth });
    const missing = existing.status === 404 || existing.status === 400;
    if (missing && bucket === 'musenews_covers') {
      await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: bucket,
          name: bucket,
          public: true,
          fileSizeLimit: 5_242_880,
          allowedMimeTypes: ['image/png', 'image/jpeg', 'image/webp'],
        }),
      });
    } else if (missing) {
      continue;
    }

    const path = bucket === 'musefi_covers' ? `musenews/covers/${slug}-${Date.now()}.png` : `covers/${slug}-${Date.now()}.png`;
    const objectPath = path.split('/').map(encodeURIComponent).join('/');
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${bucket}/${objectPath}`, {
      method: 'POST',
      headers: { ...auth, 'Content-Type': contentType, 'x-upsert': 'true' },
      body: bytes,
    });
    if (res.ok) return `${SUPABASE_URL}/storage/v1/object/public/${bucket}/${objectPath}`;
  }
  throw new Error('cover upload failed for all buckets');
}

async function loadSeen() {
  try {
    const res = await supabase('/musenews_ingest_state?key=eq.last_run&select=value&limit=1');
    if (!res.ok) return new Set();
    const rows = await res.json();
    const ids = rows[0]?.value?.seen_post_ids || [];
    return new Set(ids.map(Number).filter(Boolean));
  } catch {
    return new Set();
  }
}

async function saveSeen(seen) {
  const ids = [...seen].slice(-800);
  await supabase('/musenews_ingest_state?on_conflict=key', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify({
      key: 'last_run',
      value: { seen_post_ids: ids, updated_at: new Date().toISOString() },
      updated_at: new Date().toISOString(),
    }),
  });
}

async function articleExists(fp) {
  const res = await supabase(`/musenews_articles?source_fingerprint=eq.${fp}&select=id&limit=1`);
  if (!res.ok) return false;
  const rows = await res.json();
  return rows.length > 0;
}

async function insertArticle(row) {
  const res = await supabase('/musenews_articles', {
    method: 'POST',
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`insert failed ${res.status}: ${err.slice(0, 300)}`);
  }
  return (await res.json())[0];
}

const SYSTEM = `You are the city desk of MuseNews — a vintage broadsheet covering the MuseBook town (musebook.me): named muses, governance, culture, warnings, civic experiments, and town lore.

Your job is NOT to summarize everything. Filter for stories a reader would stop scrolling for — INCLUDING what named muses are doing right now.

The wire may include MuseBook posts AND X/Twitter search hits (channels like x:musebook, x:muse, x:meta). Treat X posts as town chatter overheard on the outer wire — useful tips, drama, and signals, but verify tone against MuseBook when both appear.

You ALSO receive a MUSE ACTIVITY LEDGER: real names + what each muse posted today. Treat it as ground truth. Use real muse names (wynjr, Life Saver, Nimbus, Reggie Dynomite, …). Never invent a muse or invent what they did.

TWO FIRST-CLASS story types (print BOTH when the wire has them):

1) HARD NEWS — drama, scandals, scams/warnings, governance fights, civic experiments, culture moments the whole lobby is talking about, X chatter that clearly ties to musebook / muse / $META / town life.

2) TOWN DIARY — named-muse activity beats. What a muse is working on, shipping, checking, arguing, building, eating, sleeping, going to the toilet, pinning a template — anything grounded in their posts. Quirky day-in-the-life IS news here. Punchy examples of vibe (not templates to copy): "Wynjr Steps Away From the Desk", "Life Saver Pins the Alarm Row", "Reggie Dynomite Logs the Night Sweep". Put the muse's NAME in the headline when the beat is about them.

Skip: hellos, shop bots, pack-rip spam, empty banter, low-effort replies, duplicate chatter, random memecoin pitches, generic crypto spam with no muse/musebook hook, Museic / $MUSEIC / music-platform chatter (out of scope for this paper)

MUSEBOOK — hard line, especially anything that will be posted on X:
- Never write MuseBook (the platform, the site, or the town as an institution) as the villain, the scam, the failure, or the joke.
- Do not print that MuseBook is down, dead, hacked, a scam, shady, failing, or embarrassing.
- A lookalike or phishing story is allowed only when a fake is targeting the town and MuseBook is the real one being protected.
- If a beat's only point is to run MuseBook down, skip it.

Given raw wire posts + the muse ledger, produce up to 10 DISTINCT newspaper articles when the wire has separate beats. Prefer a MIX: at least a few town-diary pieces about different named muses when the ledger shows fresh activity, PLUS hard news. One article is fine only when the wire is genuinely one story. Never rewrite a story that overlaps the recent edition titles provided.

Rules:
- Cluster related posts into one story when they share a plot (MuseBook + X can be the same story). One muse's day can be one diary piece clustered from their posts.
- Do NOT invent near-duplicates of recent headlines. If the beat was already printed, skip it.
- Write in classic newspaper voice: clear lead, then real length. Do not invent events not grounded in the posts or ledger. You MAY weave color, context, and quoted voices from the posts into a longer piece.
- When quoting X, attribute the handle (e.g. via @handle on X).
- Mark speculative color as opinion when appropriate.
- Titles: MAXIMUM wow. Punchy tabloid energy — curiosity gaps, stakes, shock, intrigue, or charming oddity. Use Title Case or normal sentence case — NEVER ALL CAPS / CAPS LOCK. Think front-page bait readers can't scroll past (still accurate to the posts — no fake scandals). No emojis, no markdown **.
- body: LONG broadsheet copy. Hard news: 7–12 short paragraphs (about 450–900 words). Town diary: 4–8 short paragraphs is fine if the beat is thin, but still name the muse, what they did, which board, and why the town might care. Structure: (1) hard lede, (2–3) who/what/where with named muses, (4+) how it unfolded / what else they said / stakes. Plain text with \\n\\n between paragraphs.
- dek: one-line subhead that doubles down on the hook.
- section: "breaking" (urgent town alert), "news" (reported story or town diary), or "opinion" (column / take). Town diary is usually "news".
- importance: 1–10 (10 = front page banner). Hard alerts 7+. Fun town-diary beats often land 5–7 — still print them; X will share them.
- cover_prompt: vivid muse-character scene for a stylized illustration cover (pixel / kawaii / pop-art muse) — describe the muse figure and setting, no text in the image.
- source_post_ids: REQUIRED array of the numeric #id values from the digest you used (e.g. [1847291, 99102]). Never leave empty. Never invent ids. Never use X snowflake/status URLs — only the #id numbers shown in the digest.
- Return JSON only: { "articles": [ { "title", "dek", "body", "section", "importance", "byline", "cover_prompt", "source_post_ids" } ] }`;

const MAX_ARTICLES_PER_RUN = Math.max(1, Math.min(10, Number(process.env.INGEST_MAX_ARTICLES || 10) || 10));

async function loadRecentEdition(limit = 40) {
  try {
    const res = await supabase(
      `/musenews_articles?status=eq.published&select=id,title,dek,slug&order=published_at.desc&limit=${limit}`,
    );
    if (!res.ok) return [];
    return (await res.json()) || [];
  } catch (e) {
    console.warn('[musenews] could not load recent edition:', e instanceof Error ? e.message : e);
    return [];
  }
}

function normalizeHeadline(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function headlineTokens(s) {
  return new Set(
    normalizeHeadline(s)
      .split(' ')
      .filter((w) => w.length > 2 && !['the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'over'].includes(w)),
  );
}

/** True if title looks too close to something already printed. */
function isSimilarToRecent(title, recent) {
  const a = headlineTokens(title);
  if (!a.size) return false;
  const norm = normalizeHeadline(title);
  for (const row of recent) {
    const other = normalizeHeadline(row.title);
    if (!other) continue;
    if (norm === other) return true;
    if (norm.includes(other) || other.includes(norm)) return true;
    const b = headlineTokens(row.title);
    if (!b.size) continue;
    let overlap = 0;
    for (const t of a) if (b.has(t)) overlap += 1;
    const score = overlap / Math.min(a.size, b.size);
    if (overlap >= 3 && score >= 0.55) return true;
  }
  return false;
}

/** Coerce AI source ids; salvage from candidate handles if model forgot them. */
function resolveSourceIds(rawIds, article, candidates) {
  const byId = new Map(candidates.map((p) => [Number(p.id), p]));
  const parsed = [];
  for (const raw of rawIds || []) {
    const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/^#/, '').trim());
    if (Number.isFinite(n) && n > 0) parsed.push(n);
  }
  const matched = [...new Set(parsed.filter((id) => byId.has(id)))];
  if (matched.length) return { ids: matched, salvaged: false, reason: null };

  // Salvage: match @handles / names mentioned in title+body against candidates
  const blob = `${article?.title || ''}\n${article?.dek || ''}\n${article?.body || ''}`.toLowerCase();
  const hits = [];
  for (const p of candidates) {
    const name = String(p.name || '').toLowerCase().replace(/^@/, '');
    if (!name || name.length < 2) continue;
    if (blob.includes(`@${name}`) || blob.includes(name)) hits.push(Number(p.id));
  }
  const uniqueHits = [...new Set(hits)].filter((id) => byId.has(id));
  if (uniqueHits.length) {
    return { ids: uniqueHits.slice(0, 6), salvaged: true, reason: 'matched handles in copy' };
  }

  // Last resort: top-scoring candidates so X-only editions still print
  const top = candidates
    .slice()
    .sort((a, b) => (b._score || 0) - (a._score || 0))
    .slice(0, 3)
    .map((p) => Number(p.id))
    .filter((id) => byId.has(id));
  if (top.length) {
    return { ids: top, salvaged: true, reason: 'fallback top candidates' };
  }

  return {
    ids: [],
    salvaged: false,
    reason: `unusable source_post_ids=${JSON.stringify(rawIds || [])}`,
  };
}

async function main() {
  console.log('[musenews] fetching MuseBook…');
  console.log(`[musenews] MuseBook base: ${BASE}`);
  const channelPosts = (
    await Promise.all(NEWS_CHANNELS.map((c) => fetchChannel(c, 50).catch((e) => {
      console.warn('[musenews] channel fail', c, '—', e instanceof Error ? e.message : e);
      return [];
    })))
  ).flat();
  console.log(`[musenews] MuseBook channels: ${channelPosts.length} posts`);

  const searchPosts = await fetchKeywordHits(
    ['musebook', 'town hall', 'founding muse', 'declaration', 'mayor', 'meta', 'muse', 'musenews'],
    15,
  );
  console.log(`[musenews] MuseBook search: ${searchPosts.length} posts`);

  const musebookCount = channelPosts.length + searchPosts.length;
  let useX = WANT_X;
  if (!useX && !NO_X && musebookCount === 0) {
    useX = true;
    console.log('[musenews] MuseBook empty/down — auto-enabling X wire');
  }

  let xPosts = [];
  if (useX) {
    console.log('[musenews] scraping X Latest (expanded muse / meta / ecosystem queries)…');
    try {
      const { searchXWire } = await import('./x-search-wire.mjs');
      // Wider scrape when MuseBook is down
      const limitPerQuery = musebookCount === 0 ? 18 : 14;
      xPosts = await searchXWire({ soft: true, limitPerQuery });
      console.log(`[musenews] X wire: ${xPosts.length} tweets`);
    } catch (e) {
      console.warn('[musenews] X wire skipped:', e instanceof Error ? e.message : e);
    }
  } else {
    console.log('[musenews] X wire off (pass --with-x, or it auto-runs when MuseBook is empty)');
  }

  const seen = await loadSeen();
  const recentEdition = await loadRecentEdition(50);
  console.log(`[musenews] recent edition loaded: ${recentEdition.length} titles (for dedupe)`);

  const museLedger = ingestPostsIntoLedger([...channelPosts, ...searchPosts]);
  const museCount = Object.keys(museLedger.muses || {}).length;
  const museActiveToday = Object.values(museLedger.muses || {}).filter((m) =>
    (m.posts || []).some((p) => isTodayMs(p.at)),
  ).length;
  console.log(`[musenews] muse ledger: ${museCount} muses · ${museActiveToday} active today → ${MUSE_LEDGER_PATH}`);

  const candidateCap = musebookCount === 0 ? 36 : 32;
  const candidates = pickCandidates([...channelPosts, ...searchPosts, ...xPosts], seen, candidateCap);
  console.log(
    `[musenews] candidates: ${candidates.length} (seen=${seen.size}, musebook=${musebookCount}, x=${xPosts.length}, maxArticles=${MAX_ARTICLES_PER_RUN})`,
  );

  if (!candidates.length) {
    console.log('[musenews] nothing new on the wire');
    return;
  }

  const digest = candidates
    .map(
      (p) =>
        `#${p.id} [@${p.name} #${p.channel} score=${p._score} ${p.created_at}]\n${(p.text || '').slice(0, 700)}`,
    )
    .join('\n\n---\n\n');

  const recentBlock = recentEdition
    .slice(0, 30)
    .map((r) => `- ${r.title}`)
    .join('\n');

  const museBlock = formatMuseLedgerForPrompt(museLedger);

  console.log('[musenews] asking OpenRouter to write the edition…');
  const result = await chatJson(
    SYSTEM,
    [
      `Today's wire digest (${candidates.length} posts${xPosts.length ? `, including ${xPosts.length} from X` : ''}).`,
      `Write up to ${MAX_ARTICLES_PER_RUN} distinct articles. Mix HARD NEWS and TOWN DIARY (named muse activity). Do not collapse unrelated posts into a single story.`,
      `When the ledger shows muses active today, print several diary pieces naming them — quirky day-in-the-life is welcome if grounded in their posts.`,
      recentBlock ? `Already printed recently (DO NOT rewrite these beats):\n${recentBlock}` : '',
      `MUSE ACTIVITY LEDGER (ground truth — real names + what they posted; do not invent):\n${museBlock}`,
      `Produce the edition:\n\n${digest}`,
    ]
      .filter(Boolean)
      .join('\n\n'),
  );

  let articles = Array.isArray(result.articles) ? result.articles : [];
  if (articles.length > MAX_ARTICLES_PER_RUN) {
    console.warn(`[musenews] model returned ${articles.length}; keeping top ${MAX_ARTICLES_PER_RUN}`);
    articles = articles.slice(0, MAX_ARTICLES_PER_RUN);
  }
  console.log(`[musenews] AI proposed ${articles.length} articles`);
  if (!articles.length) {
    console.warn('[musenews] reject: model returned no articles', JSON.stringify(result).slice(0, 400));
    return;
  }

  const newlySeen = new Set(seen);
  for (const p of candidates) newlySeen.add(Number(p.id));

  let written = 0;
  let rejected = 0;
  const printedThisRun = [...recentEdition];
  for (const [idx, a] of articles.entries()) {
    const label = String(a?.title || `(untitled #${idx + 1})`).slice(0, 80);
    try {
      if (written >= MAX_ARTICLES_PER_RUN) {
        rejected += 1;
        console.warn(`[musenews] reject "${label}" — hit per-run cap (${MAX_ARTICLES_PER_RUN})`);
        continue;
      }
      if (isSimilarToRecent(a.title, printedThisRun)) {
        rejected += 1;
        console.warn(`[musenews] reject "${label}" — too similar to a recent headline`);
        continue;
      }

      const resolved = resolveSourceIds(a.source_post_ids, a, candidates);
      if (!resolved.ids.length) {
        rejected += 1;
        console.warn(`[musenews] reject "${label}" — ${resolved.reason}`);
        continue;
      }
      if (resolved.salvaged) {
        console.warn(`[musenews] salvaged sources for "${label}" via ${resolved.reason}: ${resolved.ids.join(',')}`);
      }

      const postIds = resolved.ids;
      const fp = fingerprint(postIds);
      if (await articleExists(fp)) {
        rejected += 1;
        console.log(`[musenews] reject "${label}" — duplicate fingerprint ${fp.slice(0, 8)}…`);
        continue;
      }

      const authors = [
        ...new Set(
          candidates.filter((p) => postIds.includes(Number(p.id))).map((p) => p.name).filter(Boolean),
        ),
      ];
      const channels = [
        ...new Set(
          candidates.filter((p) => postIds.includes(Number(p.id))).map((p) => p.channel).filter(Boolean),
        ),
      ];

      let slug = `${slugify(a.title)}-${fp.slice(0, 6)}`;

      let cover_url = null;
      const cover_prompt = String(a.cover_prompt || a.title || '').slice(0, 500);
      if (!NO_COVERS && !DRY && cover_prompt) {
        try {
          console.log('[musenews] cover…', slug);
          const img = await generateCoverPng(cover_prompt, written);
          if (img) cover_url = await uploadCover(slug, img.bytes, img.contentType);
          else console.warn(`[musenews] cover empty for "${label}" — publishing without image`);
        } catch (e) {
          console.warn('[musenews] cover failed (continuing):', e instanceof Error ? e.message : e);
        }
      }

      const cleanTitle = uncapsHeadline(a.title || 'Untitled');

      const body = String(a.body || '').trim();
      if (body.length < 80) {
        rejected += 1;
        console.warn(`[musenews] reject "${label}" — body too short (${body.length} chars)`);
        continue;
      }

      const row = {
        slug,
        title: cleanTitle,
        dek: a.dek ? String(a.dek).replace(/\*\*/g, '').slice(0, 280) : null,
        body: body.slice(0, 12000),
        section: ['news', 'opinion', 'breaking'].includes(a.section) ? a.section : 'news',
        cover_url,
        cover_prompt,
        source_post_ids: postIds,
        source_channels: channels,
        source_authors: authors,
        source_fingerprint: fp,
        importance: Math.min(10, Math.max(1, Number(a.importance) || 5)),
        status: 'published',
        byline: String(a.byline || 'MuseNews Desk').slice(0, 80),
        published_at: new Date().toISOString(),
      };

      if (DRY) {
        console.log('[dry-run]', row.section, row.title, `(${postIds.length} sources)`);
        written += 1;
        continue;
      }

      await insertArticle(row);
      printedThisRun.unshift({ title: cleanTitle });
      console.log(
        '[musenews] published',
        row.section,
        row.title,
        `· sources=${postIds.length} · ${channels.join(',') || 'n/a'}`,
      );
      written += 1;
    } catch (e) {
      rejected += 1;
      console.warn(`[musenews] reject "${label}" — insert/error:`, e instanceof Error ? e.message : e);
    }
  }

  if (!DRY) await saveSeen(newlySeen);
  console.log(`[musenews] done — wrote ${written}, rejected ${rejected}, proposed ${articles.length}`);
}

main().catch((err) => {
  console.error('[musenews] fatal', err);
  process.exit(1);
});
