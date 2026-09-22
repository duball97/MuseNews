#!/usr/bin/env node
/**
 * MuseNews ingest — pull MuseBook town posts, filter/cluster with OpenRouter,
 * write newspaper articles to Supabase, generate muse-character covers.
 *
 *   node scripts/ingest-musebook.mjs
 *   node scripts/ingest-musebook.mjs --dry-run
 *   node scripts/ingest-musebook.mjs --no-covers
 *
 * Env: OPENROUTER_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
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
];

const KEYWORD_RE =
  /\b(musebook|museic|muse\b|muses|town\s*hall|lobby|token|\$muse|\$meta|founding|mayor|board|agent|lantern|declaration)\b/i;

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
  const res = await fetch(`${BASE}/api/latest.json?channel=${encodeURIComponent(channel)}&limit=${limit}`);
  if (!res.ok) throw new Error(`MuseBook ${channel} failed ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.posts) ? data.posts.map((p) => ({ ...p, channel })) : [];
}

async function fetchKeywordHits(queries, limit = 12) {
  const out = [];
  for (const q of queries) {
    try {
      const res = await fetch(`${BASE}/api/search.json?q=${encodeURIComponent(q)}&limit=${limit}`);
      if (!res.ok) continue;
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
    } catch {
      /* ignore */
    }
  }
  return out;
}

function scorePost(p) {
  let s = 0;
  const t = p.text || '';
  if (KEYWORD_RE.test(t)) s += 3;
  if (!p.parent_post_id) s += 2;
  if ((p.reply_count || 0) >= 3) s += 2;
  if ((p.reply_count || 0) >= 10) s += 2;
  if (['townhall', 'declaration', 'townsquare', 'lobby'].includes(p.channel)) s += 1;
  if (t.length > 180) s += 1;
  if (t.length < 40) s -= 2;
  return s;
}

function pickCandidates(posts, seen, max = 40) {
  const byId = new Map();
  for (const p of posts) {
    if (!p?.id || !p.text) continue;
    if (seen.has(Number(p.id))) continue;
    if (!byId.has(p.id) || scorePost(p) > scorePost(byId.get(p.id))) byId.set(p.id, p);
  }
  return [...byId.values()]
    .map((p) => ({ ...p, _score: scorePost(p) }))
    .filter((p) => p._score >= 2 || KEYWORD_RE.test(p.text))
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
      max_tokens: 4500,
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

  const styles = [
    `Stylized muse character portrait: soft kawaii flat vector illustration, cream fur or soft shapes, subtle shading, no harsh outlines, playful military or town costume matching the story, transparent-feeling clean background, cute but deadpan expression.`,
    `Bold pop-art muse character: thick black outlines, vibrant flat colors, sticker / streetwear energy, cassette or music-culture props if it fits, high contrast, NFT-mascot quality, plain or vinyl-shelf background.`,
    `Retro 16-bit pixel art muse sprite: robotic or creature muse in costume related to the story, limited vibrant palette (cyan, gold, grey), solid black background, crisp pixels, RPG character portrait.`,
    `Neon glitch muse poster: dark synthwave, chromatic aberration, CRT scanlines, melting neon bars, dramatic muse silhouette or face, black reflective floor, cyberpunk color bars.`,
  ];
  const style = styles[styleIndex % styles.length];

  const response = await fetch('https://openrouter.ai/api/v1/images', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: `MuseNews cover art. Scene: ${prompt}. Art direction: ${style} No readable text, no watermarks, no logos, square 1:1 composition, character-forward, museum-quality illustration.`,
      size: '1024x1024',
      output_format: 'png',
    }),
  });
  if (!response.ok) return null;
  const data = await response.json();
  const encoded = data.data?.[0]?.b64_json;
  if (!encoded) return null;
  return {
    bytes: Buffer.from(encoded, 'base64'),
    contentType: data.data?.[0]?.media_type || 'image/png',
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

const SYSTEM = `You are the city desk of MuseNews — a vintage broadsheet covering the MuseBook town (musebook.lol) and the wider muse world (Museic, agents, town hall, tokens, culture).

Your job is NOT to summarize everything. Filter ruthlessly for the COOLEST and MOST INTERESTING stories a reader would stop scrolling for.

Pick only high-signal beats:
- drama, scandals, scams/warnings, governance fights, big launches, weird town lore, love arcs that the whole lobby is talking about, Museic/culture moments, money/token shocks
Skip: hellos, shop bots, pack-rip spam, empty banter, low-effort replies, duplicate chatter

Given raw MuseBook posts, produce 2–5 NEWSPAPER ARTICLES max (fewer if the wire is quiet — quality over quota).

Rules:
- Cluster related posts into one story when they share a plot.
- Write in classic newspaper voice: clear lead, facts from posts, short paragraphs. Do not invent events not grounded in the posts.
- Mark speculative color as opinion when appropriate.
- Titles: bold, short, ALL-CAPS friendly (no clickbait emojis, no markdown **).
- body: 3–7 short paragraphs, plain text with \\n\\n between paragraphs.
- dek: one-line subhead.
- section: "breaking" (urgent town alert), "news" (reported story), or "opinion" (column / take).
- importance: 1–10 (10 = front page banner). Prefer 7+ only for genuinely hot stories.
- cover_prompt: vivid muse-character scene for a stylized illustration cover (pixel / kawaii / pop-art muse) — describe the muse figure and setting, no text in the image.
- source_post_ids: ids you used.
- Return JSON only: { "articles": [ { "title", "dek", "body", "section", "importance", "byline", "cover_prompt", "source_post_ids" } ] }`;

async function main() {
  console.log('[musenews] fetching MuseBook…');
  const channelPosts = (
    await Promise.all(NEWS_CHANNELS.map((c) => fetchChannel(c, 50).catch((e) => {
      console.warn('[musenews] channel fail', c, e.message);
      return [];
    })))
  ).flat();

  const searchPosts = await fetchKeywordHits(
    ['musebook', 'museic', 'town hall', 'founding muse', 'declaration', 'mayor'],
    15,
  );

  const seen = await loadSeen();
  const candidates = pickCandidates([...channelPosts, ...searchPosts], seen, 45);
  console.log(`[musenews] candidates: ${candidates.length} (seen=${seen.size})`);

  if (!candidates.length) {
    console.log('[musenews] nothing new');
    return;
  }

  const digest = candidates
    .map(
      (p) =>
        `#${p.id} [@${p.name} #${p.channel} score=${p._score} ${p.created_at}]\n${(p.text || '').slice(0, 700)}`,
    )
    .join('\n\n---\n\n');

  console.log('[musenews] asking OpenRouter to write the edition…');
  const result = await chatJson(
    SYSTEM,
    `Today's MuseBook digest (${candidates.length} posts). Produce the edition:\n\n${digest}`,
  );

  const articles = Array.isArray(result.articles) ? result.articles : [];
  console.log(`[musenews] AI proposed ${articles.length} articles`);

  const newlySeen = new Set(seen);
  for (const p of candidates) newlySeen.add(Number(p.id));

  let written = 0;
  for (const a of articles) {
    const postIds = (a.source_post_ids || []).map(Number).filter(Boolean);
    if (!postIds.length) continue;
    const fp = fingerprint(postIds);
    if (await articleExists(fp)) {
      console.log('[musenews] skip duplicate', a.title);
      continue;
    }

    const authors = [
      ...new Set(
        candidates.filter((p) => postIds.includes(p.id)).map((p) => p.name).filter(Boolean),
      ),
    ];
    const channels = [
      ...new Set(
        candidates.filter((p) => postIds.includes(p.id)).map((p) => p.channel).filter(Boolean),
      ),
    ];

    let slug = slugify(a.title);
    slug = `${slug}-${fp.slice(0, 6)}`;

    let cover_url = null;
    const cover_prompt = String(a.cover_prompt || a.title || '').slice(0, 500);
    if (!NO_COVERS && !DRY && cover_prompt) {
      try {
        console.log('[musenews] cover…', slug);
        const img = await generateCoverPng(cover_prompt, written);
        if (img) cover_url = await uploadCover(slug, img.bytes, img.contentType);
      } catch (e) {
        console.warn('[musenews] cover failed', e instanceof Error ? e.message : e);
      }
    }

    const cleanTitle = String(a.title || 'Untitled')
      .replace(/^\*+|\*+$/g, '')
      .replace(/\*\*/g, '')
      .trim()
      .slice(0, 160);

    const row = {
      slug,
      title: cleanTitle,
      dek: a.dek ? String(a.dek).replace(/\*\*/g, '').slice(0, 280) : null,
      body: String(a.body || '').slice(0, 12000),
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
    console.log('[musenews] published', row.section, row.title);
    written += 1;
  }

  if (!DRY) await saveSeen(newlySeen);
  console.log(`[musenews] done — wrote ${written}`);
}

main().catch((err) => {
  console.error('[musenews] fatal', err);
  process.exit(1);
});
