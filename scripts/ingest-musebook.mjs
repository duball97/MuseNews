#!/usr/bin/env node
/**
 * MuseNews ingest — pull MuseBook town posts, filter/cluster with OpenRouter,
 * write newspaper articles to Supabase, generate muse-character covers.
 *
 *   node scripts/ingest-musebook.mjs
 *   node scripts/ingest-musebook.mjs --dry-run
 *   node scripts/ingest-musebook.mjs --no-covers
 *   node scripts/ingest-musebook.mjs --with-x      # also scrape X Latest (musebook/muse/meta)
 *
 * Env: OPENROUTER_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *      INGEST_WITH_X=1, X_PROFILE_DIR (see scripts/x-search-wire.mjs)
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
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
const BASE = (process.env.MUSEBOOK_BASE || 'https://musebook.lol').replace(/\/$/, '');
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

function slugify(title) {
  return String(title || 'edition')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72) || 'edition';
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

function scorePost(p) {
  let s = typeof p._score === 'number' && String(p.channel || '').startsWith('x:') ? p._score : 0;
  const t = p.text || '';
  if (KEYWORD_RE.test(t)) s += 3;
  if (!p.parent_post_id) s += 2;
  if ((p.reply_count || 0) >= 3) s += 2;
  if ((p.reply_count || 0) >= 10) s += 2;
  if (['townhall', 'declaration', 'townsquare', 'lobby', 'memecoins', 'museriously', 'boardofshame'].includes(p.channel)) s += 1;
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
  return [...byId.values()]
    .map((p) => ({ ...p, _score: scorePost(p) }))
    .filter((p) => p._score >= 2 || KEYWORD_RE.test(p.text) || String(p.channel || '').startsWith('x:'))
    .sort((a, b) => b._score - a._score || String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, max);
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

const SYSTEM = `You are the city desk of MuseNews — a vintage broadsheet covering the MuseBook town (musebook.lol): governance, culture, warnings, civic experiments, and town lore.

Your job is NOT to summarize everything. Filter ruthlessly for the COOLEST and MOST INTERESTING stories a reader would stop scrolling for.

The wire may include MuseBook posts AND X/Twitter search hits (channels like x:musebook, x:muse, x:meta). Treat X posts as town chatter overheard on the outer wire — useful tips, drama, and signals, but verify tone against MuseBook when both appear.

Pick only high-signal beats:
- drama, scandals, scams/warnings, governance fights, weird town lore, civic experiments, culture moments that the whole lobby is talking about
- X chatter that clearly ties to musebook / muse / $META / town life
Skip: hellos, shop bots, pack-rip spam, empty banter, low-effort replies, duplicate chatter, random memecoin pitches, generic crypto spam with no muse/musebook hook, Museic / $MUSEIC / music-platform chatter (out of scope for this paper)

Given raw wire posts, produce at most 2 NEWSPAPER ARTICLES (1 is fine if the wire is thin). Quality over quota. Never rewrite a story that overlaps the recent edition titles provided.

Rules:
- Cluster related posts into one story when they share a plot (MuseBook + X can be the same story).
- Do NOT invent near-duplicates of recent headlines. If the beat was already printed, skip it.
- Write in classic newspaper voice: clear lead, then real length. Do not invent events not grounded in the posts. You MAY weave color, context, and quoted voices from the posts into a longer piece.
- When quoting X, attribute the handle (e.g. via @handle on X).
- Mark speculative color as opinion when appropriate.
- Titles: MAXIMUM wow. Punchy tabloid energy — curiosity gaps, stakes, shock, intrigue. ALL-CAPS friendly. Think front-page bait readers can't scroll past (still accurate to the posts — no fake scandals). Vibe examples: "THE PEACH THAT BROKE THE TOWN", "ONE LETTER FROM RUIN", "THEY ALMOST CLICKED". No emojis, no markdown **.
- body: LONG broadsheet copy. Aim for 7–12 short paragraphs (about 450–900 words). Structure: (1) hard lede, (2–3) who/what/where with named muses, (4–6) how it unfolded / what the town said, (7–9) stakes / what officials urge / what happens next, optional close. Plain text with \\n\\n between paragraphs. Never stop at three thin grafs.
- dek: one-line subhead that doubles down on the hook.
- section: "breaking" (urgent town alert), "news" (reported story), or "opinion" (column / take).
- importance: 1–10 (10 = front page banner). Prefer 7+ only for genuinely hot stories.
- cover_prompt: vivid muse-character scene for a stylized illustration cover (pixel / kawaii / pop-art muse) — describe the muse figure and setting, no text in the image.
- source_post_ids: REQUIRED array of the numeric #id values from the digest you used (e.g. [1847291, 99102]). Never leave empty. Never invent ids. Never use X snowflake/status URLs — only the #id numbers shown in the digest.
- Return JSON only: { "articles": [ { "title", "dek", "body", "section", "importance", "byline", "cover_prompt", "source_post_ids" } ] }`;

const MAX_ARTICLES_PER_RUN = Math.max(1, Math.min(3, Number(process.env.INGEST_MAX_ARTICLES || 2) || 2));

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

  const candidateCap = musebookCount === 0 ? 28 : 24;
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

  console.log('[musenews] asking OpenRouter to write the edition…');
  const result = await chatJson(
    SYSTEM,
    [
      `Today's wire digest (${candidates.length} posts${xPosts.length ? `, including ${xPosts.length} from X` : ''}).`,
      `Write at most ${MAX_ARTICLES_PER_RUN} article(s). Prefer 1 strong story over filler.`,
      recentBlock ? `Already printed recently (DO NOT rewrite these beats):\n${recentBlock}` : '',
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

      const cleanTitle = String(a.title || 'Untitled')
        .replace(/^\*+|\*+$/g, '')
        .replace(/\*\*/g, '')
        .trim()
        .slice(0, 160);

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
