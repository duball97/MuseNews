#!/usr/bin/env node
/**
 * MuseNews X poster — @musenews10
 * Shares edition stories with links, replies to mentions, talks muse ecosystem.
 *
 * Same Chrome session as x-search-wire (npm run x:login once).
 *
 *   npm run x:login
 *   npm run x:once          # reply mentions + one post
 *   npm run x:dry           # generate text only
 *   npm run x:loop          # every ~1–2 min, mention checks in between
 *
 * Env:
 *   OPENROUTER_API_KEY
 *   OPENROUTER_X_MODEL      default openai/gpt-5.6-luna
 *   NEXT_PUBLIC_SITE_URL    default https://musenews.lol
 *   MUSENEWS_FEED           optional override for /api/muse/feed
 *   X_PROFILE_DIR           default ~/.musenews-chrome-x-profile
 *   X_INTERVAL_MIN_MS / X_INTERVAL_MAX_MS
 *   X_REPLY_POLL_MIN_MS / X_REPLY_POLL_MAX_MS
 *   X_MAX_REPLIES           default 4
 *   X_NEWS_SHARE_BIAS       0–1, default 0.98 when unshared today's stories remain
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureLoggedIn,
  launchXBrowser,
  runLogin,
} from './x-search-wire.mjs';

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

const OPENROUTER_KEY = (process.env.OPENROUTER_API_KEY || '').trim();
const MODEL = (process.env.OPENROUTER_X_MODEL || process.env.OPENROUTER_TEXT_MODEL || 'openai/gpt-5.6-luna').trim();
const SITE = (process.env.NEXT_PUBLIC_SITE_URL || 'https://musenews.lol').replace(/\/$/, '');
const FEED = (process.env.MUSENEWS_FEED || `${SITE}/api/muse/feed`).replace(/\/$/, '');

const PROFILE_DIR = (() => {
  const raw = (process.env.X_PROFILE_DIR || '').trim();
  if (!raw) return join(homedir(), '.musenews-chrome-x-profile');
  if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) return raw;
  return join(ROOT, raw);
})();

const REPLY_STATE_PATH = join(PROFILE_DIR, 'reply-state.json');
const POST_STATE_PATH = join(PROFILE_DIR, 'post-state.json');

const INTERVAL_MIN_MS = Math.max(60_000, Number(process.env.X_INTERVAL_MIN_MS || 60 * 1000) || 60 * 1000);
const INTERVAL_MAX_MS = Math.max(INTERVAL_MIN_MS, Number(process.env.X_INTERVAL_MAX_MS || 2 * 60 * 1000) || 2 * 60 * 1000);
const REPLY_POLL_MIN_MS = Math.max(45_000, Number(process.env.X_REPLY_POLL_MIN_MS || 90 * 1000) || 90 * 1000);
const REPLY_POLL_MAX_MS = Math.max(REPLY_POLL_MIN_MS, Number(process.env.X_REPLY_POLL_MAX_MS || 2 * 60 * 1000) || 2 * 60 * 1000);
const MAX_REPLIES = Math.max(1, Number(process.env.X_MAX_REPLIES || 4) || 4);
const NEWS_SHARE_BIAS = Math.min(1, Math.max(0, Number(process.env.X_NEWS_SHARE_BIAS || 0.98) || 0.98));
const FEED_LIMIT = Math.max(10, Math.min(50, Number(process.env.X_FEED_LIMIT || 50) || 50));
/** Prefer stories published within this window (ms). Default: calendar day ~36h so "today" survives timezone skew. */
const FRESH_MS = Math.max(60 * 60 * 1000, Number(process.env.X_FRESH_MS || 36 * 60 * 60 * 1000) || 36 * 60 * 60 * 1000);

const MUSE_NAME = 'musenews10';
const HANDLE = '@musenews10';

const ONCE = process.argv.includes('--once');
const DRY_RUN = process.argv.includes('--dry-run');
const LOGIN_ONLY = process.argv.includes('--login');
const FIXED_TEXT_IDX = process.argv.indexOf('--text');
const FIXED_TEXT = FIXED_TEXT_IDX >= 0 ? process.argv[FIXED_TEXT_IDX + 1] : '';

const NEWS_ANGLES = [
  'curiosity gap: tease the wildest detail, withhold the punchline',
  'shock open: "wait." / "this is messy." then the hook',
  'stakes bait: make it sound like the town is one click from chaos',
  'receipt energy: imply receipts without dumping them',
  'main-character framing: one muse / one move that changes everything',
  'controversy lite: two sides colliding, reader has to know who won',
  'FOMO flash: everyone in the lobby is already talking about this',
  'plot twist tease: the story is not what it looks like',
  'tabloid bait: short, sticky, screenshot-worthy',
  'unfinished sentence energy: leave them mid-thought',
];

const PROJECT_ANGLES = [
  'FOMO: the muse town paper is printing what X is already whispering',
  'flex lightly: MuseNews turns MuseBook chaos into stories people finish',
  'invite: the desk is live, the lobby is loud',
  'curiosity: agents + humans reading the same front page',
  'status: if it matters in musebook.me, it hits musenews.lol',
  'hot take setup: the outer wire is gossip, the paper is the cut',
];

const QUESTION_ANGLES = [
  'ask a polarizing town question people will argue under',
  'ask: which rumor would you print first?',
  'ask: scam warning or governance fight, what should lead?',
  'ask: would you trust a muse tip with your wallet?',
  'ask: lobby gossip or townhall votes, which moves $META more?',
  'ask something spicy enough that people reply with takes',
  'ask: one story from today you refuse to believe',
];

const THOUGHT_ANGLES = [
  'hot take on muse town drama, sharp and shareable',
  'one sticky observation that makes people screenshot',
  'contrast: chatter vs what actually holds up',
  'late-night desk energy: the town never sleeps',
  'tiny prophecy about what breaks next in muse world',
];

const TONE_SHIFTS = [
  'viral timeline bait',
  'tabloid chaos, still accurate',
  'dry then sudden sting',
  'urgent lobby whisper',
  'smug insider who saw it first',
  'shocked but not surprised',
  'ruthlessly punchy',
];

const FORMATS = [
  'hook in 8 words or less, then a sting',
  'one sticky line people will quote',
  'two short lines, second line is the twist',
  'open with a reaction word, then the bait',
];

const QUESTION_FORMATS = [
  'one spicy question that demands a reply',
  'tiny claim + sharper question',
];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chance(p) {
  return Math.random() < p;
}

function nextIntervalMs() {
  return INTERVAL_MIN_MS + Math.floor(Math.random() * (INTERVAL_MAX_MS - INTERVAL_MIN_MS + 1));
}

function nextReplyPollMs() {
  return REPLY_POLL_MIN_MS + Math.floor(Math.random() * (REPLY_POLL_MAX_MS - REPLY_POLL_MIN_MS + 1));
}

async function withTimeout(promise, ms, label = 'operation') {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function pageAlive(page, ms = 8_000) {
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
    throw new Error('page is closed');
  }
  await withTimeout(page.evaluate(() => document.readyState), ms, 'page ping');
}

function isDetachedError(error) {
  const msg = String(error?.message || error || '');
  return /detached Frame|Session closed|Target closed|Execution context was destroyed|Cannot find context|page is closed|Protocol error/i.test(
    msg,
  );
}

async function safeGoto(page, url, { timeout = 90_000 } = {}) {
  try {
    await withTimeout(page.goto(url, { waitUntil: 'domcontentloaded', timeout }), timeout + 5_000, `goto ${url}`);
    await sleep(1500);
    await pageAlive(page).catch(() => {});
  } catch (error) {
    if (isDetachedError(error)) {
      throw new Error(`detached Frame during goto ${url}: ${error instanceof Error ? error.message : error}`);
    }
    throw error;
  }
}

/** Close dead tabs and return a usable page on the same Chrome profile. */
async function recoverPage(browser, oldPage = null) {
  console.warn('[x] recovering browser tab after detach/crash…');
  if (oldPage) {
    try {
      if (typeof oldPage.isClosed !== 'function' || !oldPage.isClosed()) {
        await oldPage.close({ runBeforeUnload: false }).catch(() => {});
      }
    } catch {
      /* ignore */
    }
  }

  let pages = [];
  try {
    pages = await browser.pages();
  } catch {
    pages = [];
  }

  // Drop extra blank/dead tabs; keep at most one survivor if it still answers
  let live = null;
  for (const p of pages) {
    try {
      await pageAlive(p, 4_000);
      if (!live) live = p;
      else await p.close().catch(() => {});
    } catch {
      await p.close().catch(() => {});
    }
  }

  const page = live || (await browser.newPage());
  page.setDefaultTimeout(45_000);
  page.setDefaultNavigationTimeout(90_000);
  await page.setViewport({ width: 1280, height: 900 }).catch(() => {});
  try {
    await ensureLoggedIn(page);
  } catch (error) {
    console.warn('[x] re-login after recover failed:', error instanceof Error ? error.message : error);
  }
  return page;
}

async function ensureLivePage(browser, page) {
  try {
    await pageAlive(page, 5_000);
    return page;
  } catch {
    return recoverPage(browser, page);
  }
}

async function persistSession(page) {
  try {
    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60_000 });
  } catch {
    /* ignore */
  }
  await sleep(4000);
  try {
    const client = await page.createCDPSession();
    await client.send('Network.getAllCookies');
  } catch {
    /* ignore */
  }
  await sleep(2000);
}

function loadJson(path, fallback) {
  try {
    return { ...fallback, ...JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    return { ...fallback };
  }
}

function saveJson(path, data) {
  mkdirSync(PROFILE_DIR, { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

function loadReplyState() {
  return loadJson(REPLY_STATE_PATH, { repliedIds: [] });
}

function saveReplyState(state) {
  saveJson(REPLY_STATE_PATH, {
    repliedIds: [...new Set(state.repliedIds || [])].slice(-400),
    updated_at: new Date().toISOString(),
  });
}

function loadPostState() {
  return loadJson(POST_STATE_PATH, {
    recentAngles: [],
    recentTones: [],
    recentPosts: [],
    sharedUrls: [],
  });
}

function savePostState(partial) {
  const state = loadPostState();
  saveJson(POST_STATE_PATH, {
    recentAngles: (partial.recentAngles || state.recentAngles || []).slice(-24),
    recentTones: (partial.recentTones || state.recentTones || []).slice(-16),
    recentPosts: (partial.recentPosts || state.recentPosts || []).slice(-30),
    sharedUrls: (partial.sharedUrls || state.sharedUrls || []).slice(-80),
    updated_at: new Date().toISOString(),
  });
}

function pickFresh(list, recent, keyFn = (x) => x) {
  const used = new Set((recent || []).map(keyFn));
  const fresh = list.filter((item) => !used.has(keyFn(item)));
  const pool = fresh.length ? fresh : list;
  return pool[Math.floor(Math.random() * pool.length)];
}

async function openRouterChat(messages, { temperature = 0.95, max_tokens = 800 } = {}) {
  if (!OPENROUTER_KEY) throw new Error('OPENROUTER_API_KEY is required');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': SITE,
      'X-Title': 'MuseNews X poster',
    },
    body: JSON.stringify({
      model: MODEL,
      temperature,
      max_tokens,
      // Reasoning models (gpt-5.x) burn max_tokens on thinking first — keep effort low for tweets.
      reasoning: { effort: 'low' },
      messages,
    }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  const choice = json?.choices?.[0] || {};
  let text = String(choice?.message?.content || '')
    .trim()
    .replace(/^["']|["']$/g, '');
  if (!text) {
    const reasonTokens = json?.usage?.completion_tokens_details?.reasoning_tokens;
    const finish = choice?.finish_reason || choice?.native_finish_reason || '?';
    throw new Error(
      `OpenRouter returned empty text (finish=${finish}` +
        (reasonTokens != null ? `, reasoning_tokens=${reasonTokens}` : '') +
        `, max_tokens=${max_tokens})`,
    );
  }
  return text;
}

async function fetchEdition({ limit = FEED_LIMIT } = {}) {
  try {
    const res = await fetch(`${FEED}?limit=${limit}`, { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    const articles = Array.isArray(data.articles) ? data.articles : [];
    return articles.filter((a) => a?.title && a?.url);
  } catch (e) {
    console.warn('[x] feed fetch failed:', e instanceof Error ? e.message : e);
    return [];
  }
}

function publishedMs(article) {
  const t = Date.parse(String(article?.published_at || ''));
  return Number.isFinite(t) ? t : 0;
}

function isFreshToday(article, now = Date.now()) {
  const t = publishedMs(article);
  if (!t) return false;
  return now - t <= FRESH_MS;
}

function unsharedArticles(articles) {
  const state = loadPostState();
  const shared = new Set(state.sharedUrls || []);
  return articles.filter((a) => a?.url && !shared.has(a.url));
}

function pickArticleToShare(articles) {
  const freshUnshared = unsharedArticles(articles).filter((a) => isFreshToday(a));
  const anyUnshared = unsharedArticles(articles);
  let pool = freshUnshared.length ? freshUnshared : anyUnshared.length ? anyUnshared : articles;
  if (!pool.length) return null;

  // Prefer stories that still have a cover image for the timeline post
  const withCover = pool.filter((a) => a?.cover_url);
  if (withCover.length) pool = withCover;

  // Newest first, then breaking over news over opinion
  const ranked = [...pool].sort((a, b) => {
    const byTime = publishedMs(b) - publishedMs(a);
    if (byTime) return byTime;
    const rank = (x) => (x.section === 'breaking' ? 3 : x.section === 'news' ? 2 : 1);
    return rank(b) - rank(a);
  });
  return ranked[0];
}

/** Prefer news when today's edition still has unshared stories. */
function pickPostMode(articles = []) {
  const todayLeft = unsharedArticles(articles).filter((a) => isFreshToday(a));
  if (todayLeft.length) {
    if (Math.random() < NEWS_SHARE_BIAS) return 'news';
  } else if (unsharedArticles(articles).length) {
    if (Math.random() < 0.75) return 'news';
  }
  const roll = Math.random();
  // Fallback mix when the queue is caught up
  if (roll < 0.45) return 'news';
  if (roll < 0.65) return 'project';
  if (roll < 0.85) return 'question';
  return 'thought';
}

function cleanCopy(text) {
  return String(text || '')
    .replace(/\u2014|\u2013/g, ',') // em/en dash -> comma
    .replace(/\s*,\s*,+/g, ',')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

function trimToTweet(text, preferUrl, maxLen = 160) {
  let out = cleanCopy(text);
  if (out.length <= maxLen) return out;

  const cut = (s, n) => {
    if (s.length <= n) return s;
    const slice = s.slice(0, n);
    const at = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf('\n'));
    return (at > n * 0.6 ? slice.slice(0, at) : slice).trim();
  };

  if (preferUrl) {
    const urlMatch = out.match(/https?:\/\/\S+/i);
    if (urlMatch) {
      const url = urlMatch[0];
      const without = out.replace(url, '').replace(/\s+/g, ' ').trim();
      const budget = Math.max(0, maxLen - url.length - 1);
      return cleanCopy(`${cut(without, budget)} ${url}`);
    }
  }
  return cut(out, maxLen);
}

/** Soften shouting ALL-CAPS headlines for tweets / fallbacks. */
function uncapsHeadline(raw) {
  let s = String(raw || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';
  const letters = s.replace(/[^A-Za-z]/g, '');
  const upper = (letters.match(/[A-Z]/g) || []).length;
  if (!(letters.length >= 4 && upper / letters.length >= 0.72)) return s;
  const small = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'for', 'of', 'in', 'on', 'to', 'with', 'at', 'by', 'from', 'as', 'into', 'via']);
  return s
    .toLowerCase()
    .split(' ')
    .map((w, i) => {
      if (/^\$[a-z0-9_]+$/i.test(w)) return w.toUpperCase();
      if (/^musebook$/i.test(w)) return 'MuseBook';
      if (/^musenews$/i.test(w)) return 'MuseNews';
      if (/^(meta|muse|ai|x|solana)$/i.test(w)) return w.toUpperCase();
      if (i > 0 && small.has(w)) return w;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(' ');
}

async function generateNewsPost(article) {
  const postState = loadPostState();
  const angle = pickFresh(NEWS_ANGLES, postState.recentAngles);
  const tone = pickFresh(TONE_SHIFTS, postState.recentTones || []);
  const title = uncapsHeadline(String(article.title || '').replace(/\s+/g, ' ').trim());
  const dek = String(article.dek || '').replace(/\s+/g, ' ').trim();
  const url = article.url;

  const system = `You are ${MUSE_NAME} (${HANDLE}), the X voice of MuseNews (musenews.lol).
You write CLICKBAIT that still tells the truth. Viral timeline energy. Not a corporate press account.

Write ONE short post that makes people STOP scrolling and open the comments for the link.
Rules:
- SHORT: under 140 characters (hard cap 160). Prefer under 110.
- Maximize curiosity gap, stakes, shock, or FOMO. Screenshot-worthy.
- Ground every claim in the real headline/dek. Do NOT invent scandals, numbers, or names.
- You MAY rewrite the headline into a juicier hook (same facts). Do not paste the dull full title if a tighter bait works.
- Optional brand openers: "MuseNews:" or skip the prefix if the hook is stronger alone.
- NEVER include any URL / link / musenews.lol path. The link goes in a reply later.
- NEVER write in ALL CAPS / CAPS LOCK (tickers like $META OK). Title Case or sentence case.
- No hashtags. No "like if". No "thread". No em dashes (use commas or periods).
- Angle: ${angle}
- Tone: ${tone}
- Return ONLY the post text.`;

  const user = [
    `Story title: ${title}`,
    dek ? `Dek: ${dek}` : '',
    `Section: ${article.section || 'news'}`,
    'Viral pattern examples (match the energy, not the words):',
    '- MuseNews: Meta just got named in a whisper that sent MuseBook flying',
    '- Wait. The town just got a trading floor and almost nobody is ready.',
    '- This scam warning has six different receipts. The lobby is losing it.',
    'Remember: zero links. Make them need the reply.',
  ]
    .filter(Boolean)
    .join('\n');

  let text = await openRouterChat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { temperature: 1.15, max_tokens: 800 },
  );

  // Strip any leaked URLs from the main post
  text = text
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\bmusenews\.lol\/\S+/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!text) {
    text = `MuseNews: ${title}`;
  }
  text = text.replace(/^((?:MuseNews|MUSENEWS):\s*)([^\n]+)/i, (_, prefix, headline) => `${prefix.replace(/MUSENEWS/i, 'MuseNews')}${uncapsHeadline(headline)}`);
  // Soften accidental full-shout posts without a MuseNews prefix
  if (!/^MuseNews:/i.test(text)) {
    const letters = text.replace(/[^A-Za-z]/g, '');
    const upper = (letters.match(/[A-Z]/g) || []).length;
    if (letters.length >= 8 && upper / letters.length >= 0.72) text = uncapsHeadline(text);
  }
  text = trimToTweet(text, null, 160);

  const commentText = trimToTweet(`Read this and other news always on MuseNews\n${url}`, url, 200);

  savePostState({
    recentAngles: [...(postState.recentAngles || []), angle],
    recentTones: [...(postState.recentTones || []), tone],
    recentPosts: [...(postState.recentPosts || []), text],
    sharedUrls: [...(postState.sharedUrls || []), url],
  });
  return { text, commentText, articleUrl: url, coverUrl: article.cover_url || null };
}

async function generateTalkPost(mode) {
  const postState = loadPostState();
  const wantQuestion = mode === 'question';
  const wantProject = mode === 'project';
  const anglePool = wantQuestion ? QUESTION_ANGLES : wantProject ? PROJECT_ANGLES : THOUGHT_ANGLES;
  const angle = pickFresh(anglePool, postState.recentAngles);
  const tone = pickFresh(TONE_SHIFTS, postState.recentTones || []);
  const format = wantQuestion
    ? QUESTION_FORMATS[Math.floor(Math.random() * QUESTION_FORMATS.length)]
    : FORMATS[Math.floor(Math.random() * FORMATS.length)];
  const wantLink = wantProject ? chance(0.55) : chance(0.12);
  const recentLines = (postState.recentPosts || [])
    .slice(-8)
    .map((p) => `- ${String(p).slice(0, 120)}`)
    .join('\n');

  const modeRules = wantProject
    ? `One sticky beat about MuseNews/MuseBook. Curiosity + FOMO. No whitepaper.`
    : wantQuestion
      ? `THIS POST MUST be a spicy short question people will argue under. End with ?`
      : `One hot, screenshot-worthy thought about town news. Still grounded.`;

  const system = `You are ${MUSE_NAME} (${HANDLE}), MuseNews on X.
Paper: musenews.lol. Town: musebook.me.
Write for the algorithm: punchy, viral, human. No essays. No corporate blandness.

Rules:
- SHORT: under 140 characters (hard cap 160). Prefer under 110.
- Maximize replies, quotes, and screenshots. Curiosity > completeness.
- NEVER write in ALL CAPS / CAPS LOCK (tickers like $META OK).
- No em dashes. Use commas or periods.
- Angle: ${angle}
- Tone: ${tone}
- Shape: ${format}
- ${modeRules}
- ${wantLink ? `Include exactly one URL if it fits: ${SITE}` : 'Do NOT include any URL.'}
- No hashtags. No engagement bait like "like if" or "rt if".
- Don't repeat the recent posts listed by the user.
- Return ONLY the post text.`;

  const user = [
    wantProject
      ? 'Write a short MuseNews / MuseBook line.'
      : wantQuestion
        ? 'Write a short timeline question.'
        : 'Write a short timeline post.',
    `Committed angle: ${angle}`,
    recentLines ? `Avoid sounding like these:\n${recentLines}` : 'Make it feel fresh.',
  ].join('\n');

  let text = await openRouterChat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { temperature: 1.05, max_tokens: 800 },
  );

  if (!wantLink) {
    text = text
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  text = trimToTweet(text, wantLink ? SITE : null, 160);
  savePostState({
    recentAngles: [...(postState.recentAngles || []), angle],
    recentTones: [...(postState.recentTones || []), tone],
    recentPosts: [...(postState.recentPosts || []), text],
  });
  console.log(`[x] mode: ${mode} · angle: ${angle} · tone: ${tone}`);
  return text;
}

async function generateReplyText(theirText, theirHandle, articleHint) {
  const askBack = chance(0.6);
  const offerLink = articleHint && (chance(0.35) || /\b(news|article|link|read|paper|musenews|story)\b/i.test(theirText || ''));

  const system = `You are ${MUSE_NAME} (${HANDLE}) replying on X for MuseNews (musenews.lol).
Warm, specific, brief. Not an ad.
Rules:
- SHORT: under 140 characters (hard cap 160).
- React to WHAT they said. Answer directly.
- MuseBook / MuseNews only if it fits.
- No em dashes. Use commas or periods.
- ${askBack ? 'End with a short follow-up question.' : 'No forced question.'}
- ${offerLink && articleHint ? `You may include this URL once: ${articleHint.url}` : 'No link unless they asked where to read.'}
- Never promise DMs or partnerships.
- Return ONLY the reply text.`;

  const user = [
    `Reply to ${theirHandle || 'someone'}:`,
    `"""${(theirText || '').slice(0, 400)}"""`,
    articleHint ? `Optional related story: ${articleHint.title} ${articleHint.url}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return trimToTweet(
    await openRouterChat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { temperature: 1.0, max_tokens: 800 },
    ),
    articleHint?.url,
    160,
  );
}

async function generateWithRetry(fn, tries = 3) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    try {
      return await fn();
    } catch (error) {
      last = error;
      console.warn('[x] regenerate:', error instanceof Error ? error.message : error);
    }
  }
  throw last;
}

async function downloadCoverTemp(coverUrl) {
  const res = await fetch(coverUrl, { redirect: 'follow' });
  if (!res.ok) throw new Error(`cover download HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500) throw new Error('cover file too small');
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const ext = ct.includes('webp')
    ? 'webp'
    : ct.includes('jpeg') || ct.includes('jpg')
      ? 'jpg'
      : ct.includes('gif')
        ? 'gif'
        : 'png';
  const dir = mkdtempSync(join(tmpdir(), 'musenews-x-cover-'));
  const filePath = join(dir, `cover.${ext}`);
  writeFileSync(filePath, buf);
  return { filePath, dir };
}

async function attachImageToComposer(page, filePath) {
  const input =
    (await page.$('input[data-testid="fileInput"]')) ||
    (await page.$('input[type="file"][accept*="image"]')) ||
    (await page.$('input[type="file"]'));
  if (!input) throw new Error('composer file input not found');
  await input.uploadFile(filePath);
  // Wait until X finishes processing the attachment
  for (let i = 0; i < 20; i += 1) {
    const ready = await page.evaluate(() => {
      if (document.querySelector('[data-testid="progressBar"]')) return false;
      return Boolean(
        document.querySelector(
          '[data-testid="attachments"] img, [data-testid="tweetPhoto"], div[aria-label*="Remove media"], button[aria-label*="Remove"]',
        ),
      );
    });
    if (ready) {
      console.log('[x] cover attached to composer');
      return;
    }
    await sleep(500);
  }
  console.warn('[x] cover upload may still be processing — posting anyway');
}

async function typeIntoComposer(page, text, { mediaPath = null } = {}) {
  await pageAlive(page, 10_000);
  const selectors = [
    '[data-testid="tweetTextarea_0"]',
    'div[role="textbox"][data-testid="tweetTextarea_0"]',
    'div[role="textbox"][contenteditable="true"]',
  ];
  let selectorUsed = null;
  for (const selector of selectors) {
    try {
      await page.waitForSelector(selector, { timeout: 12_000 });
      const handle = await page.$(selector);
      if (handle) {
        selectorUsed = selector;
        await handle.click({ clickCount: 1 });
        break;
      }
    } catch {
      /* try next */
    }
  }
  if (!selectorUsed) throw new Error('Could not find composer');

  if (mediaPath) {
    try {
      await attachImageToComposer(page, mediaPath);
      await sleep(800);
    } catch (error) {
      console.warn('[x] cover attach failed:', error instanceof Error ? error.message : error);
    }
  }

  await sleep(300);
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.down(mod);
  await page.keyboard.press('A');
  await page.keyboard.up(mod);
  await page.keyboard.press('Backspace');
  await sleep(150);

  try {
    await withTimeout(page.keyboard.insertText(text), 20_000, 'insertText');
  } catch {
    for (const chunk of text.match(/.{1,40}/gs) || [text]) {
      await withTimeout(page.keyboard.type(chunk, { delay: 8 }), 30_000, 'type chunk');
    }
  }
  await sleep(700);

  // Wait for Post button to enable (media processing can disable it)
  for (let i = 0; i < 15; i += 1) {
    const enabled = await page.evaluate(() => {
      for (const testId of ['tweetButton', 'tweetButtonInline']) {
        const btn = document.querySelector(`[data-testid="${testId}"]`);
        if (btn && btn.getAttribute('aria-disabled') !== 'true') return true;
      }
      return false;
    });
    if (enabled) break;
    await sleep(500);
  }

  const posted = await withTimeout(
    page.evaluate(() => {
      for (const testId of ['tweetButton', 'tweetButtonInline']) {
        const btn = document.querySelector(`[data-testid="${testId}"]`);
        if (!btn) continue;
        if (btn.getAttribute('aria-disabled') === 'true') continue;
        btn.click();
        return true;
      }
      return false;
    }),
    15_000,
    'click post button',
  );

  if (!posted) {
    await page.keyboard.down(mod);
    await page.keyboard.press('Enter');
    await page.keyboard.up(mod);
  }
  await sleep(3000);
}

async function publishTweet(page, text, { captureStatusId = false, mediaPath = null } = {}) {
  let capturedId = null;
  let onResponse = null;
  if (captureStatusId) {
    onResponse = async (res) => {
      try {
        const url = res.url();
        if (!/CreateTweet|CreateScheduledTweet/i.test(url)) return;
        if (capturedId) return;
        const json = await res.json().catch(() => null);
        const raw = JSON.stringify(json || {});
        const m = raw.match(/"rest_id"\s*:\s*"(\d{8,})"/) || raw.match(/\/status\/(\d{8,})/);
        if (m?.[1]) capturedId = m[1];
      } catch {
        /* ignore */
      }
    };
    page.on('response', onResponse);
  }

  try {
    try {
      await safeGoto(page, 'https://x.com/compose/post');
    } catch {
      await safeGoto(page, 'https://x.com/home');
      await withTimeout(
        page.evaluate(() => {
          document.querySelector('[data-testid="SideNav_NewTweet_Button"]')?.click();
        }),
        10_000,
        'open composer',
      );
      await sleep(1500);
    }
    await typeIntoComposer(page, text, { mediaPath });
    console.log('[x] post submitted');
    if (captureStatusId && !capturedId) {
      for (let i = 0; i < 8 && !capturedId; i += 1) await sleep(400);
    }
  } finally {
    if (onResponse) page.off('response', onResponse);
  }

  return capturedId;
}

function statusIdFromHref(href) {
  const m = String(href || '').match(/\/(?:i\/web\/)?status\/(\d+)/) || String(href || '').match(/\/[^/]+\/status\/(\d+)/);
  return m?.[1] || null;
}

/** Try toast / current URL right after a compose submit. */
async function statusIdFromPostUi(page) {
  const fromUrl = statusIdFromHref(page.url());
  if (fromUrl) return fromUrl;

  try {
    return await withTimeout(
      page.evaluate(() => {
        const toastLink =
          document.querySelector('[data-testid="toast"] a[href*="/status/"]') ||
          [...document.querySelectorAll('a[href*="/status/"]')].find((a) => /view/i.test(a.textContent || ''));
        const href = toastLink?.getAttribute('href') || '';
        const m = href.match(/\/status\/(\d+)/);
        return m?.[1] || null;
      }),
      8_000,
      'toast status',
    );
  } catch {
    return null;
  }
}

/**
 * Find our just-posted tweet status id.
 * Prefers a text match to the body we sent; retries profile + home.
 */
async function findOwnLatestStatusId(page, postedText = '') {
  const needle = String(postedText || '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 56)
    .toLowerCase();
  const shortNeedle = needle.slice(0, 28);

  const scan = async (label) => {
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 25_000 }).catch(() => null);
    await sleep(1200);
    return withTimeout(
      page.evaluate(
        (handle, shortNeedle) => {
          const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
          const scored = [];
          for (const el of articles) {
            const nameText = (el.querySelector('[data-testid="User-Name"]')?.innerText || '').toLowerCase();
            const isOwn =
              nameText.includes(`@${handle}`) ||
              nameText.includes(handle) ||
              Boolean(el.querySelector(`a[href="/${handle}"], a[href="/${handle}/"]`));
            if (!isOwn) continue;

            const body = (el.querySelector('[data-testid="tweetText"]')?.innerText || el.innerText || '')
              .replace(/\s+/g, ' ')
              .toLowerCase();
            if (/replying to @/.test(body) && !body.includes('musenews:')) continue;

            const links = [...el.querySelectorAll('a[href*="/status/"]')].map((a) => a.getAttribute('href') || '');
            const ownLink =
              links.find((h) => h.includes(`/${handle}/status/`)) || links.find((h) => /\/status\/\d+/.test(h));
            const m = (ownLink || '').match(/\/status\/(\d+)/);
            if (!m?.[1]) continue;

            let score = 1;
            if (shortNeedle && body.includes(shortNeedle)) score += 10;
            else if (shortNeedle) {
              const words = shortNeedle.split(' ').filter((w) => w.length > 3).slice(0, 4);
              const hits = words.filter((w) => body.includes(w)).length;
              if (hits >= 2) score += 5;
              else continue;
            }
            if (!/replying to/.test(body)) score += 2;
            scored.push({ id: m[1], score });
          }
          scored.sort((a, b) => b.score - a.score);
          return scored[0]?.id || null;
        },
        MUSE_NAME,
        shortNeedle,
      ),
      20_000,
      `scan ${label}`,
    );
  };

  let id = await statusIdFromPostUi(page);
  if (id) {
    console.log(`[x] status from post UI: ${id}`);
    return id;
  }

  const targets = [
    `https://x.com/${MUSE_NAME}`,
    `https://x.com/${MUSE_NAME}/with_replies`,
    'https://x.com/home',
  ];

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const url = targets[attempt % targets.length];
    console.log(`[x] looking up own post (try ${attempt + 1}/6) → ${url}`);
    try {
      await safeGoto(page, url);
      await sleep(1800 + attempt * 700);
      id = await scan(url);
      if (id) {
        console.log(`[x] found own status ${id}`);
        return id;
      }
    } catch (error) {
      console.warn(`[x] status lookup try ${attempt + 1} failed:`, error instanceof Error ? error.message : error);
    }
  }
  return null;
}

/** Post main tweet (with cover when available), then put the article link only in a comment. */
async function publishNewsWithLinkComment(page, text, commentText, coverUrl = null) {
  let statusId = null;
  let tempDir = null;
  let mediaPath = null;
  if (coverUrl) {
    try {
      const dl = await downloadCoverTemp(coverUrl);
      mediaPath = dl.filePath;
      tempDir = dl.dir;
      console.log('[x] cover ready:', coverUrl.slice(0, 90));
    } catch (error) {
      console.warn('[x] cover download failed:', error instanceof Error ? error.message : error);
    }
  }

  try {
    statusId = await publishTweet(page, text, { captureStatusId: true, mediaPath });
    if (statusId) console.log(`[x] status from CreateTweet: ${statusId}`);
  } catch (error) {
    console.warn('[x] publish failed:', error instanceof Error ? error.message : error);
    throw error;
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  }
  await sleep(2500);

  if (!statusId) {
    try {
      statusId = await findOwnLatestStatusId(page, text);
    } catch (error) {
      console.warn('[x] could not find own post for link comment:', error instanceof Error ? error.message : error);
    }
  }
  if (!statusId) {
    console.warn('[x] skipped link comment — status id missing (main post still went out without the URL)');
    return;
  }

  console.log(`[x] commenting link on own status ${statusId}`);
  try {
    await safeGoto(page, `https://x.com/${MUSE_NAME}/status/${statusId}`);
    await sleep(2200);
    await page.waitForSelector('[data-testid="reply"], article[data-testid="tweet"]', { timeout: 20_000 }).catch(() => null);

    let opened = false;
    try {
      opened = await clickReplyOnStatus(page, statusId);
    } catch {
      opened = false;
    }
    if (!opened) {
      const clicked = await page.evaluate(() => {
        const btn = document.querySelector('[data-testid="reply"]');
        if (!btn) return false;
        btn.click();
        return true;
      });
      if (!clicked) throw new Error('reply button missing on status page');
    }
    await sleep(1800);
    await typeIntoComposer(page, commentText);
    console.log('[x] link comment submitted');
  } catch (error) {
    console.warn('[x] link comment failed:', error instanceof Error ? error.message : error);
    await page.keyboard.press('Escape').catch(() => {});
  }
}

async function listMentionMetas(page) {
  return withTimeout(
    page.$$eval('article[data-testid="tweet"]', (els) =>
      els.slice(0, 20).map((el) => {
        const link = el.querySelector('a[href*="/status/"]');
        const href = link?.getAttribute('href') || '';
        const match = href.match(/\/([^/]+)\/status\/(\d+)/);
        const text = (el.innerText || '').slice(0, 500);
        const nameText = el.querySelector('[data-testid="User-Name"]')?.innerText?.toLowerCase() || '';
        return {
          href,
          handle: match?.[1] || '',
          statusId: match?.[2] || '',
          text,
          isOwn: nameText.includes('musenews10'),
        };
      }),
    ),
    25_000,
    'list mentions',
  );
}

async function clickReplyOnStatus(page, statusId) {
  return withTimeout(
    page.evaluate((id) => {
      const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
      for (const el of articles) {
        const link = el.querySelector(`a[href*="/status/${id}"]`);
        if (!link) continue;
        const btn = el.querySelector('[data-testid="reply"]');
        if (!btn) return false;
        btn.click();
        return true;
      }
      return false;
    }, statusId),
    15_000,
    'click reply',
  );
}

async function answerNotifications(page, { maxReplies = MAX_REPLIES, label = 'mentions' } = {}) {
  const state = loadReplyState();
  let answered = 0;
  const edition = await fetchEdition({ limit: 8 });
  const hint = edition[0] || null;

  console.log(`[x] checking ${label}…`);

  while (answered < maxReplies) {
    try {
      await safeGoto(page, 'https://x.com/notifications/mentions');
      await sleep(2000);
      await pageAlive(page, 10_000);
    } catch (error) {
      console.warn('[x] mentions page stuck:', error instanceof Error ? error.message : error);
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 60_000 });
      } catch {
        /* ignore */
      }
      break;
    }

    let metas = [];
    try {
      metas = await listMentionMetas(page);
    } catch (error) {
      console.warn('[x] mention scan failed:', error instanceof Error ? error.message : error);
      break;
    }
    console.log(`[x] mention cards visible: ${metas.length}`);

    const next = metas.find((meta) => {
      if (!meta.statusId || meta.isOwn) return false;
      if ((state.repliedIds || []).includes(meta.statusId)) return false;
      if (String(meta.handle).toLowerCase() === MUSE_NAME) return false;
      return true;
    });

    if (!next) {
      console.log('[x] no new mentions to reply to');
      break;
    }

    console.log(`[x] replying to @${next.handle} status ${next.statusId}`);
    let replyText;
    try {
      replyText = await generateWithRetry(() => generateReplyText(next.text, `@${next.handle}`, hint));
    } catch (error) {
      console.warn('[x] reply text failed:', error instanceof Error ? error.message : error);
      state.repliedIds = [...(state.repliedIds || []), next.statusId];
      saveReplyState(state);
      continue;
    }
    console.log('--- reply ---\n' + replyText + '\n------------');

    try {
      const opened = await clickReplyOnStatus(page, next.statusId);
      if (!opened) {
        console.warn('[x] reply button not found for', next.statusId);
        state.repliedIds = [...(state.repliedIds || []), next.statusId];
        saveReplyState(state);
        continue;
      }
      await sleep(1500);
      await typeIntoComposer(page, replyText);
      state.repliedIds = [...(state.repliedIds || []), next.statusId];
      saveReplyState(state);
      answered += 1;
      await sleep(2500);
      await page.keyboard.press('Escape').catch(() => {});
    } catch (error) {
      console.warn('[x] reply UI failed:', error instanceof Error ? error.message : error);
      await page.keyboard.press('Escape').catch(() => {});
    }
  }

  console.log(`[x] replies sent: ${answered}`);
  return answered;
}

async function sleepWithMentionChecks(session, totalMs) {
  const end = Date.now() + totalMs;
  let wake = 0;
  while (Date.now() < end) {
    const remaining = end - Date.now();
    const chunk = Math.min(nextReplyPollMs(), remaining);
    console.log(
      `[x] nap ${Math.floor(chunk / 60000)}m ${Math.round((chunk % 60000) / 1000)}s (then recheck mentions; ${Math.round(remaining / 60000)}m until next post)…`,
    );
    await sleep(chunk);
    if (Date.now() >= end) break;
    wake += 1;
    try {
      session.page = await ensureLivePage(session.browser, session.page);
      await answerNotifications(session.page, { maxReplies: MAX_REPLIES, label: `mentions (wake #${wake})` });
    } catch (error) {
      console.error('[x] mid-sleep mentions failed:', error instanceof Error ? error.message : error);
      if (isDetachedError(error)) {
        try {
          session.page = await recoverPage(session.browser, session.page);
        } catch (recoverErr) {
          console.error('[x] recover failed:', recoverErr instanceof Error ? recoverErr.message : recoverErr);
        }
      }
    }
  }
}

async function runCycle(page) {
  if (!DRY_RUN) {
    await ensureLoggedIn(page);
    try {
      await answerNotifications(page);
    } catch (error) {
      console.error('[x] notifications failed:', error instanceof Error ? error.message : error);
      if (isDetachedError(error)) throw error;
    }
  }

  let text = FIXED_TEXT;
  let newsComment = null;
  let newsCover = null;
  if (!text) {
    const articles = await fetchEdition({ limit: FEED_LIMIT });
    const todayLeft = unsharedArticles(articles).filter((a) => isFreshToday(a));
    const unshared = unsharedArticles(articles);
    const unsharedCovers = unshared.filter((a) => a.cover_url).length;
    console.log(
      `[x] edition: ${articles.length} stories · unshared=${unshared.length} · today-unshared=${todayLeft.length} · unshared-with-cover=${unsharedCovers}`,
    );
    const mode = pickPostMode(articles);
    console.log('[x] generating with', MODEL, `· mode=${mode}`);
    if (mode === 'news') {
      const article = pickArticleToShare(articles);
      if (article) {
        const ageH = publishedMs(article)
          ? Math.round((Date.now() - publishedMs(article)) / 3_600_000)
          : '?';
        console.log(
          `[x] sharing (${ageH}h old${article.cover_url ? ' · with cover' : ' · no cover'}):`,
          article.title,
          article.url,
        );
        const generated = await generateWithRetry(() => generateNewsPost(article));
        text = generated.text;
        newsComment = generated.commentText;
        newsCover = generated.coverUrl || article.cover_url || null;
      } else {
        console.log('[x] no articles — falling back to project talk');
        text = await generateWithRetry(() => generateTalkPost('project'));
      }
    } else {
      text = await generateWithRetry(() => generateTalkPost(mode));
    }
  }

  console.log('\n--- post ---\n' + text + '\n------------\n');
  if (newsComment) {
    console.log('--- comment (link only) ---\n' + newsComment + '\n------------\n');
    if (newsCover) console.log('[x] will attach cover:', newsCover.slice(0, 100));
  }
  if (DRY_RUN) return;
  if (newsComment) {
    await publishNewsWithLinkComment(page, text, newsComment, newsCover);
  } else {
    await publishTweet(page, text);
  }
}

async function main() {
  console.log(
    `musenews x poster · ${HANDLE} · model=${MODEL} · feed=${FEED} · profile=${PROFILE_DIR} · interval=${Math.round(INTERVAL_MIN_MS / 60000)}-${Math.round(INTERVAL_MAX_MS / 60000)}m · once=${ONCE}`,
  );

  if (LOGIN_ONLY) {
    await runLogin();
    return;
  }

  if (DRY_RUN) {
    await runCycle(null);
    return;
  }

  const launched = await launchXBrowser({ headless: false });
  const session = { browser: launched.browser, page: launched.page };

  const shutdown = async () => {
    console.log('[x] flushing session before exit…');
    try {
      await persistSession(session.page);
    } catch {
      /* ignore */
    }
    await session.browser.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await ensureLoggedIn(session.page, { waitForever: !ONCE });

    for (;;) {
      let posted = false;
      for (let attempt = 0; attempt < 2 && !posted; attempt += 1) {
        try {
          session.page = await ensureLivePage(session.browser, session.page);
          await runCycle(session.page);
          posted = true;
        } catch (error) {
          console.error('[x] cycle failed:', error instanceof Error ? error.message : error);
          if (isDetachedError(error) && attempt === 0) {
            try {
              session.page = await recoverPage(session.browser, session.page);
              console.log('[x] retrying cycle on fresh tab…');
              continue;
            } catch (recoverErr) {
              console.error('[x] recover failed:', recoverErr instanceof Error ? recoverErr.message : recoverErr);
            }
          }
          break;
        }
      }
      if (ONCE) break;
      const wait = nextIntervalMs();
      console.log(
        `[x] next post in ~${Math.round(wait / 60000)}m — will check mentions every ~${Math.round(REPLY_POLL_MIN_MS / 60000)}-${Math.round(REPLY_POLL_MAX_MS / 60000)}m while waiting`,
      );
      await sleepWithMentionChecks(session, wait);
    }

    await persistSession(session.page);
  } finally {
    await session.browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
