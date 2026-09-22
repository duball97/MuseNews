#!/usr/bin/env node
/**
 * Share a tip you spotted yourself → MuseNews article (+ optional AI polish + cover).
 *
 * Quick (you write the piece):
 *   npm run share -- --title "PEACH DECLARED SACRED" --body "First graf.\\n\\nSecond." --section news
 *
 * Tip mode (AI turns your notes into a broadsheet story):
 *   npm run share -- --tip "lobby is losing it over a lookalike phishing muse"
 *   npm run share -- --tip "…" --posts 54762,54769 --section breaking
 *
 * Interactive:
 *   npm run share
 *
 * Flags:
 *   --title       Headline (required unless --tip)
 *   --body        Article body (required unless --tip)
 *   --dek         Subhead
 *   --section     news | opinion | breaking  (default news)
 *   --byline      default "MuseNews Desk · Tip"
 *   --tip         Rough notes; OpenRouter writes the article
 *   --posts       Comma MuseBook post ids to attach as sources
 *   --authors     Comma muse names
 *   --channels    Comma channel slugs
 *   --importance  1–10 (default 8 for tips)
 *   --no-cover    Skip image gen
 *   --dry-run     Print only, don't write Supabase
 */
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin as input, stdout as output } from 'node:process';

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

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return '';
  const next = process.argv[i + 1];
  return next && !next.startsWith('-') ? next : '';
}

const DRY = process.argv.includes('--dry-run');
const NO_COVER = process.argv.includes('--no-cover') || process.argv.includes('--no-covers');
const OPENROUTER_KEY = (process.env.OPENROUTER_API_KEY || '').trim();
const TEXT_MODEL = process.env.OPENROUTER_TEXT_MODEL || 'openai/gpt-5.6-luna';
const SUPABASE_URL = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const SITE = (process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3020').replace(/\/$/, '');
const BASE = (process.env.MUSEBOOK_BASE || 'https://musebook.lol').replace(/\/$/, '');

function slugify(title) {
  return (
    String(title || 'tip')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 72) || 'tip'
  );
}

function cleanTitle(t) {
  return String(t || '')
    .replace(/\*\*/g, '')
    .replace(/^\*+|\*+$/g, '')
    .trim()
    .slice(0, 160);
}

async function supabase(path, init = {}) {
  if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required');
  return fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    ...init,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(init.headers || {}),
    },
  });
}

async function chatJson(system, user) {
  if (!OPENROUTER_KEY) throw new Error('OPENROUTER_API_KEY required for --tip mode');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': SITE,
      'X-Title': 'MuseNews tip',
    },
    body: JSON.stringify({
      model: TEXT_MODEL,
      temperature: 0.55,
      max_tokens: 2500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || '{}';
  return JSON.parse(text.replace(/^```json\s*/i, '').replace(/```$/i, '').trim());
}

async function fetchPosts(ids) {
  const out = [];
  for (const id of ids) {
    try {
      const res = await fetch(`${BASE}/api/thread.json?post=${id}`);
      if (!res.ok) continue;
      const data = await res.json();
      const post = data.post || data.posts?.[0] || data;
      if (post?.id || post?.text) {
        out.push({
          id: Number(post.id || id),
          name: post.name || '',
          text: post.text || '',
          channel: post.channel || '',
        });
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

async function generateCoverPng(prompt, stampMuse = true) {
  if (!OPENROUTER_KEY) return null;
  let model = process.env.OPENROUTER_IMAGE_MODEL || '';
  if (!model) {
    const models = await fetch('https://openrouter.ai/api/v1/images/models', {
      headers: { Authorization: `Bearer ${OPENROUTER_KEY}` },
    }).then((r) => r.json());
    model = models.data?.[0]?.id;
  }
  if (!model) return null;
  const muse =
    'the official Muse mascot: small round cream fuzzy marshmallow creature, stubby limbs, smooth beige face with tiny black bead eyes, soft pink blush, simple smile';
  const response = await fetch('https://openrouter.ai/api/v1/images', {
    method: 'POST',
    headers: { Authorization: `Bearer ${OPENROUTER_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: `MuseNews cover. Scene: ${prompt}. Feature ${muse} in the scene. No readable text, square cover.`,
      size: '1024x1024',
      output_format: 'png',
    }),
  });
  if (!response.ok) return null;
  const data = await response.json();
  const encoded = data.data?.[0]?.b64_json;
  if (!encoded) return null;
  let bytes = Buffer.from(encoded, 'base64');
  const mascot = join(ROOT, 'public', 'brand', 'muse-mascot.png');
  if (stampMuse && existsSync(mascot)) {
    try {
      const sharp = (await import('sharp')).default;
      const museBuf = await sharp(mascot)
        .resize(340, 340, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .png()
        .toBuffer();
      bytes = await sharp(bytes)
        .resize(1024, 1024, { fit: 'cover' })
        .composite([{ input: museBuf, gravity: 'southeast' }])
        .png()
        .toBuffer();
    } catch {
      /* ignore */
    }
  }
  return { bytes, contentType: 'image/png' };
}

async function uploadCover(slug, bytes, contentType) {
  const auth = { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` };
  for (const bucket of ['musenews_covers', 'musefi_covers']) {
    const existing = await fetch(`${SUPABASE_URL}/storage/v1/bucket/${bucket}`, { headers: auth });
    if ((existing.status === 404 || existing.status === 400) && bucket !== 'musenews_covers') continue;
    if (existing.status === 404 || existing.status === 400) {
      await fetch(`${SUPABASE_URL}/storage/v1/bucket`, {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: bucket, name: bucket, public: true }),
      });
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
  throw new Error('cover upload failed');
}

const TIP_SYSTEM = `You are MuseNews city desk. Turn a human tip into ONE newspaper article.
Return JSON: { "title", "dek", "body", "section", "importance", "byline", "cover_prompt" }
- section: news | opinion | breaking
- title: MAXIMUM wow / tabloid bait — punchy, stakesy, curiosity gap, ALL-CAPS friendly, still true to the tip. No markdown.
- body: 3–6 short paragraphs separated by \\n\\n — grounded in the tip (and any source posts). Do not invent facts.
- dek: one-line hook that doubles down
- cover_prompt: muse-character illustration brief, no text in image
- importance: 1–10`;

async function promptInteractive() {
  const rl = createInterface({ input, output });
  try {
    const tip = (await rl.question('What did you spot? (tip notes) ')).trim();
    if (!tip) throw new Error('empty tip');
    const section = (await rl.question('Section [news/opinion/breaking] (news): ')).trim() || 'news';
    const posts = (await rl.question('Optional MuseBook post ids (comma): ')).trim();
    return { tip, section, posts };
  } finally {
    rl.close();
  }
}

async function main() {
  let title = argValue('--title');
  let body = argValue('--body');
  let dek = argValue('--dek');
  let tip = argValue('--tip');
  let section = (argValue('--section') || 'news').toLowerCase();
  let byline = argValue('--byline') || 'MuseNews Desk · Tip';
  let importance = Math.min(10, Math.max(1, Number(argValue('--importance') || 8) || 8));
  let cover_prompt = '';
  const postIds = (argValue('--posts') || '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter(Boolean);
  let authors = (argValue('--authors') || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  let channels = (argValue('--channels') || '')
    .split(',')
    .map((s) => s.trim().replace(/^#/, ''))
    .filter(Boolean);

  if (!title && !body && !tip) {
    const asked = await promptInteractive();
    tip = asked.tip;
    section = asked.section || section;
    if (asked.posts) {
      for (const id of asked.posts.split(',').map((s) => Number(s.trim())).filter(Boolean)) {
        postIds.push(id);
      }
    }
  }

  if (!['news', 'opinion', 'breaking'].includes(section)) section = 'news';

  let sourcePosts = [];
  if (postIds.length) {
    console.log('[share] fetching MuseBook posts…', postIds.join(','));
    sourcePosts = await fetchPosts(postIds);
    for (const p of sourcePosts) {
      if (p.name && !authors.includes(p.name)) authors.push(p.name);
      if (p.channel && !channels.includes(p.channel)) channels.push(p.channel);
    }
  }

  if (tip && (!title || !body)) {
    console.log('[share] polishing tip with OpenRouter…');
    const digest = sourcePosts.length
      ? `\n\nSource posts:\n${sourcePosts.map((p) => `#${p.id} @${p.name}: ${p.text}`).join('\n\n')}`
      : '';
    const drafted = await chatJson(
      TIP_SYSTEM,
      `Section hint: ${section}\nTip from editor:\n${tip}${digest}`,
    );
    title = cleanTitle(drafted.title || tip.slice(0, 80));
    dek = drafted.dek || dek;
    body = String(drafted.body || tip);
    section = ['news', 'opinion', 'breaking'].includes(drafted.section) ? drafted.section : section;
    importance = Math.min(10, Math.max(1, Number(drafted.importance) || importance));
    byline = drafted.byline || byline;
    cover_prompt = String(drafted.cover_prompt || title);
  }

  title = cleanTitle(title);
  body = String(body || '').trim();
  if (!title || !body) throw new Error('Need --title and --body, or --tip');

  cover_prompt = cover_prompt || `${title} — muse character reacting to the story`;
  const fp = createHash('sha256')
    .update(`tip:${title}:${body.slice(0, 240)}:${postIds.join(',')}`)
    .digest('hex')
    .slice(0, 40);
  const slug = `${slugify(title)}-${fp.slice(0, 6)}`;

  let cover_url = null;
  if (!NO_COVER && !DRY) {
    try {
      console.log('[share] generating cover…');
      const img = await generateCoverPng(cover_prompt);
      if (img) cover_url = await uploadCover(slug, img.bytes, img.contentType);
    } catch (e) {
      console.warn('[share] cover failed', e instanceof Error ? e.message : e);
    }
  }

  const row = {
    slug,
    title,
    dek: dek ? String(dek).slice(0, 280) : null,
    body: body.slice(0, 12000),
    section,
    cover_url,
    cover_prompt,
    source_post_ids: postIds.length ? postIds : [],
    source_channels: channels.length ? channels : ['editor-tip'],
    source_authors: authors.length ? authors : ['editor'],
    source_fingerprint: fp,
    importance,
    status: 'published',
    byline: String(byline).slice(0, 80),
    published_at: new Date().toISOString(),
  };

  if (DRY) {
    console.log('[dry-run]', JSON.stringify(row, null, 2));
    return;
  }

  const res = await supabase('/musenews_articles', { method: 'POST', body: JSON.stringify(row) });
  if (!res.ok) throw new Error(`insert failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const article = (await res.json())[0];
  console.log('[share] published');
  console.log(`  ${title}`);
  console.log(`  ${SITE}/news/${article.slug}`);
}

main().catch((err) => {
  console.error('[share] fatal', err instanceof Error ? err.message : err);
  process.exit(1);
});
