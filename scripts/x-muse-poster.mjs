#!/usr/bin/env node
/**
 * MuseNews X poster — @musenews10
 * Shares edition stories with links, replies to mentions, talks muse ecosystem.
 *
 * Same Chrome session as x-search-wire (npm run x:login once).
 *
 *   npm run x:login
 *   npm run x:once          # one post, then optional mention reply
 *   npm run x:dry           # generate text only
 *   npm run x:loop          # every ~15–22 min; mentions sparse between / after posts
 *
 * Env:
 *   OPENROUTER_API_KEY
 *   OPENROUTER_X_MODEL      default openai/gpt-5.6-luna
 *   NEXT_PUBLIC_SITE_URL    default https://musenews.lol
 *   MUSENEWS_FEED           optional override for /api/muse/feed
 *   X_PROFILE_DIR           default ~/.musenews-chrome-x-profile
 *   X_INTERVAL_MIN_MS / X_INTERVAL_MAX_MS   default 15–22 min
 *   X_REPLY_POLL_MIN_MS / X_REPLY_POLL_MAX_MS  default 12–18 min
 *   X_MAX_REPLIES           default 1 (mentions are secondary to posting)
 *   X_NEWS_SHARE_BIAS       unused (poster is news-only); kept for env compat
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
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
const MUSE_LEDGER_PATH = join(ROOT, '.voice-out', 'muse-ledger.json');

const INTERVAL_MIN_MS = Math.max(60_000, Number(process.env.X_INTERVAL_MIN_MS || 15 * 60 * 1000) || 15 * 60 * 1000);
const INTERVAL_MAX_MS = Math.max(INTERVAL_MIN_MS, Number(process.env.X_INTERVAL_MAX_MS || 22 * 60 * 1000) || 22 * 60 * 1000);
const REPLY_POLL_MIN_MS = Math.max(60_000, Number(process.env.X_REPLY_POLL_MIN_MS || 12 * 60 * 1000) || 12 * 60 * 1000);
const REPLY_POLL_MAX_MS = Math.max(REPLY_POLL_MIN_MS, Number(process.env.X_REPLY_POLL_MAX_MS || 18 * 60 * 1000) || 18 * 60 * 1000);
const MAX_REPLIES = Math.max(1, Number(process.env.X_MAX_REPLIES || 1) || 1);
/** Chance to clear mentions after a successful post (keeps replies sparse). */
const REPLY_AFTER_POST_CHANCE = Math.min(1, Math.max(0, Number(process.env.X_REPLY_AFTER_POST_CHANCE ?? 0.35) || 0));

const FEED_LIMIT = Math.max(10, Math.min(50, Number(process.env.X_FEED_LIMIT || 50) || 50));
/** Prefer stories published within this window (ms). Default: calendar day ~36h so "today" survives timezone skew. */
const FRESH_MS = Math.max(60 * 60 * 1000, Number(process.env.X_FRESH_MS || 36 * 60 * 60 * 1000) || 36 * 60 * 60 * 1000);
/** Chance to attach a cover when the story has one. Most posts stay text-only. */
const COVER_CHANCE = Math.min(1, Math.max(0, Number(process.env.X_COVER_CHANCE || 0.28) || 0));

const MUSE_NAME = 'musenews10';
const HANDLE = '@musenews10';

const ONCE = process.argv.includes('--once');
const DRY_RUN = process.argv.includes('--dry-run');
const LOGIN_ONLY = process.argv.includes('--login');
const FIXED_TEXT_IDX = process.argv.indexOf('--text');
const FIXED_TEXT = FIXED_TEXT_IDX >= 0 ? process.argv[FIXED_TEXT_IDX + 1] : '';

const NEWS_ANGLES = [
  'BREAKING flash: lead with BREAKING: and the most shocking true fact',
  'clickbait wire: curiosity gap + stakes — make them NEED the next line',
  'JUST IN: this just hit the desk, urgency first',
  'tabloid punch: wow headline energy, still 100% true to the story',
  'they almost / one move from ruin vibe when the facts support it',
  'named muse drama: put the muse in the headline like a character',
  'receipt drop: the one detail that flips the story',
  'scoop tone: we caught it before the lobby finished arguing',
  'escalation: the quiet tip just became a front-page hit',
  'town alarm: something moved — name who and what changed',
  'exclusive energy: EXCLUSIVE: or SCOOP: when it fits a fresh beat',
  'follow-up flash: the next twist on a story already moving',
];

const TONE_SHIFTS = [
  'clickbait tabloid',
  'breaking wire',
  'urgent stunner',
  'cold factual sting',
  'desk just got the tip',
  'ruthlessly punchy',
  'curiosity-gap tease',
  'front-page bait',
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

function normalizeMuseKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

function loadMuseLedger() {
  try {
    if (!existsSync(MUSE_LEDGER_PATH)) return { muses: {} };
    const raw = JSON.parse(readFileSync(MUSE_LEDGER_PATH, 'utf8'));
    return { muses: raw?.muses && typeof raw.muses === 'object' ? raw.muses : {} };
  } catch {
    return { muses: {} };
  }
}

function isTodayMs(ms, now = Date.now()) {
  if (!ms) return false;
  const a = new Date(ms);
  const b = new Date(now);
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

function lookupMuse(query, ledger = loadMuseLedger()) {
  const q = normalizeMuseKey(query);
  if (!q || q.length < 2) return null;
  const rows = Object.values(ledger.muses || {});
  return (
    rows.find((m) => normalizeMuseKey(m.name) === q) ||
    rows.find((m) => (m.names || []).includes(q)) ||
    rows.find((m) => normalizeMuseKey(m.name).includes(q) || (m.names || []).some((n) => n.includes(q) || q.includes(n))) ||
    null
  );
}

function extractMuseQueries(text) {
  const t = String(text || '');
  const found = [];
  const patterns = [
    /\b(?:what(?:'s| is| was)?|whats|what\s+has|what's)\s+(\w[\w .'-]{1,40}?)\s+(?:been\s+)?(?:up to|doing|working on)\b/i,
    /\b(?:how(?:'s| is| was)?)\s+(\w[\w .'-]{1,40}?)\s+(?:doing|been)\b/i,
    /\b(?:about|update on|status on|news on)\s+(\w[\w .'-]{1,40})\b/i,
    /\b@([a-z0-9_]{2,40})\b/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m?.[1] && !/^(he|she|they|you|it|this|that|muse|muses)$/i.test(m[1])) found.push(m[1].trim());
  }
  const ledger = loadMuseLedger();
  for (const m of Object.values(ledger.muses || {})) {
    const name = String(m.name || '');
    if (name.length >= 3 && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t)) {
      found.push(name);
    }
  }
  return [...new Set(found.map((x) => x.trim()).filter(Boolean))];
}

function formatMuseContextForReply(theirText) {
  const queries = extractMuseQueries(theirText);
  if (!queries.length) return '';
  const ledger = loadMuseLedger();
  const now = Date.now();
  const blocks = [];
  for (const q of queries.slice(0, 3)) {
    const muse = lookupMuse(q, ledger);
    if (!muse) {
      blocks.push(`- ${q}: not in desk ledger yet`);
      continue;
    }
    const today = (muse.posts || []).filter((p) => isTodayMs(p.at, now)).slice(0, 3);
    const posts = today.length ? today : (muse.posts || []).slice(0, 2);
    const lines = posts.map((p) => `  #${p.channel}: "${String(p.text || '').slice(0, 140)}"`);
    blocks.push(`${muse.name} today=${today.length}:\n${lines.join('\n') || '  (quiet)'}`);
  }
  return `MUSE ACTIVITY (answer from this, do not invent):\n${blocks.join('\n')}`;
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
  return /detached Frame|Session closed|Target closed|Execution context was destroyed|Cannot find context|page is closed|Protocol error|Connection closed|Browser closed|WebSocket is not open|Navigating frame was detached|browser has been closed|Browser\.close/i.test(
    msg,
  );
}

function isBrowserConnected(browser) {
  try {
    if (!browser) return false;
    if (typeof browser.isConnected === 'function') return browser.isConnected();
    if (typeof browser.connected === 'boolean') return browser.connected;
    return true;
  } catch {
    return false;
  }
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

async function closeBrowserQuietly(browser) {
  if (!browser) return;
  try {
    await Promise.race([browser.close().catch(() => {}), sleep(4_000)]);
  } catch {
    /* ignore */
  }
  try {
    const proc = typeof browser.process === 'function' ? browser.process() : null;
    if (proc && !proc.killed) proc.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

/** Chrome leaves these after a hard crash and blocks the next launch on the same profile. */
function clearChromeLocks(profileDir) {
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    const path = join(profileDir, name);
    try {
      if (existsSync(path)) unlinkSync(path);
    } catch {
      /* ignore */
    }
  }
}

/** Close dead tabs and return a usable page on the same Chrome connection. */
async function recoverPage(browser, oldPage = null) {
  console.warn('[x] recovering browser tab after detach/crash…');
  if (!isBrowserConnected(browser)) {
    throw new Error('Connection closed');
  }
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

/** Tab recovery first; if Chrome itself is dead, kill + relaunch the whole browser. */
async function recoverSession(session, { reason = 'crash' } = {}) {
  const connected = isBrowserConnected(session.browser);
  if (connected) {
    try {
      session.page = await recoverPage(session.browser, session.page);
      return session;
    } catch (error) {
      console.warn('[x] tab recover failed, relaunching Chrome:', error instanceof Error ? error.message : error);
    }
  } else {
    console.warn(`[x] Chrome connection dead (${reason}) — relaunching browser…`);
  }

  await closeBrowserQuietly(session.browser);
  session.browser = null;
  session.page = null;
  clearChromeLocks(PROFILE_DIR);
  await sleep(1500);

  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const launched = await launchXBrowser({ headless: false });
      session.browser = launched.browser;
      session.page = launched.page;
      await ensureLoggedIn(session.page, { waitForever: false });
      console.log(`[x] browser relaunched (attempt ${attempt}) — session OK`);
      return session;
    } catch (error) {
      lastErr = error;
      console.error(`[x] relaunch attempt ${attempt}/3 failed:`, error instanceof Error ? error.message : error);
      await closeBrowserQuietly(session.browser);
      session.browser = null;
      session.page = null;
      clearChromeLocks(PROFILE_DIR);
      await sleep(2000 * attempt);
    }
  }
  throw lastErr || new Error('browser relaunch failed');
}

async function ensureLiveSession(session) {
  try {
    if (!isBrowserConnected(session.browser)) {
      throw new Error('Connection closed');
    }
    await pageAlive(session.page, 5_000);
    return session;
  } catch (error) {
    return recoverSession(session, { reason: error instanceof Error ? error.message : 'page dead' });
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

/** True when copy runs MuseBook down. Lookalikes are fine only if MuseBook is the real one being protected. */
function runsDownMuseBook(text) {
  const t = String(text || '');
  if (!/\bmusebook\b/i.test(t)) return false;
  if (/\b(lookalike|impersonat\w*|fake\s+(handle|account|site|muse))\b/i.test(t) && /\b(real|official|warning|warns|alert)\b/i.test(t)) {
    return /\bmusebook\s+(is|was|are|isn't|isnt)\b/i.test(t);
  }
  return /\b(scam|fraud|rug|rugged|hack(?:ed|ing)?|exploit|phish(?:ing|ed)?|down|dead|dying|fail(?:ed|ure|ing)?|broke|broken|trash|dump(?:ed|ing)?|ponzi|steal|stolen|stole|corrupt|sketchy|shady|rip-?off|collapse|embarrass\w*|shame|joke|losing it|freak(?:ing)? out|disaster|warning)\b/i.test(t);
}

function unsharedArticles(articles) {
  const state = loadPostState();
  const shared = new Set(state.sharedUrls || []);
  return articles.filter((a) => a?.url && !shared.has(a.url));
}

function pickArticleToShare(articles) {
  if (!articles?.length) return null;

  const shared = new Set(loadPostState().sharedUrls || []);
  const isUnshared = (a) => a?.url && !shared.has(a.url);

  // Text-first: covers are optional spice, not a requirement.
  const safe = articles.filter((a) => {
    const slam = runsDownMuseBook(`${a.title || ''} ${a.dek || ''}`);
    if (slam) console.log('[x] skip (runs down MuseBook):', a.title);
    return !slam;
  });
  if (!safe.length) return null;

  const buckets = [
    safe.filter((a) => isUnshared(a) && isFreshToday(a)),
    safe.filter((a) => isUnshared(a)),
    safe.filter((a) => isFreshToday(a)),
    safe,
  ];
  let pool = buckets.find((b) => b.length) || safe;
  if (!pool.length) return null;

  const ranked = [...pool].sort((a, b) => {
    // Prefer unshared, then newest, then breaking > news
    const u = Number(isUnshared(b)) - Number(isUnshared(a));
    if (u) return u;
    const byTime = publishedMs(b) - publishedMs(a);
    if (byTime) return byTime;
    const rank = (x) => (x.section === 'breaking' ? 3 : x.section === 'news' ? 2 : 1);
    return rank(b) - rank(a);
  });

  const topN = Math.min(isUnshared(ranked[0]) ? 3 : 6, ranked.length);
  const top = ranked.slice(0, topN);
  return top[Math.floor(Math.random() * top.length)];
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
  const section = String(article.section || 'news').toLowerCase();
  // Mostly breaking / just-in energy; some quieter MuseNews: flashes for variety
  const isBreaking = section === 'breaking' || chance(0.72);
  const tagRoll = Math.random();
  const preferTag = isBreaking
    ? tagRoll < 0.45
      ? 'BREAKING:'
      : tagRoll < 0.7
        ? 'JUST IN:'
        : tagRoll < 0.85
          ? 'SCOOP:'
          : 'EXCLUSIVE:'
    : tagRoll < 0.55
      ? 'MuseNews:'
      : tagRoll < 0.8
        ? 'JUST IN:'
        : 'DEVELOPING:';
  const recentLines = (postState.recentPosts || [])
    .slice(-8)
    .map((p) => `- ${String(p).slice(0, 120)}`)
    .join('\n');

  const system = `You are ${MUSE_NAME} (${HANDLE}), the clickbait news wire for MuseNews (musenews.lol).
Tabloid energy. People should STOP SCROLLING. Still a real news desk — never invent.

Write ONE short flash about this story.
Rules:
- SHORT: under 140 characters (hard cap 160). Prefer under 120.
- CLICKBAIT but TRUE: curiosity gaps, stakes, shock, intrigue. Punch the weirdest or hottest true detail.
- Prefer opening with ${preferTag} (or BREAKING: / JUST IN: / SCOOP: / EXCLUSIVE: / DEVELOPING: / MuseNews:).
- State who/what/stakes. Name the muse when the story is about them.
- Town diary can still be clickbait: "Wynjr just did WHAT mid-shift" energy if grounded.
- Ground every claim in the real headline/dek. Do NOT invent scandals, numbers, or names.
- NEVER say anything bad about MuseBook. Not a scam, not down, not shady, not failing, not a joke. MuseBook is the town, not the villain.
- Lookalike/phishing OK only when MuseBook is the real one and the fake is the problem.
- You MAY rewrite the headline into a sharper clickbait line (same facts).
- NEVER include any URL / link / musenews.lol path.
- NEVER write the whole post in ALL CAPS. Tags like BREAKING / JUST IN / SCOOP may be caps.
- No hashtags. No "like if". No questions. No question marks. No soft musings. No em dashes.
- Angle: ${angle}
- Tone: ${tone}
- Return ONLY the post text. Statement only — never end with a question.`;

  const authors = Array.isArray(article.source_authors) ? article.source_authors.filter(Boolean).slice(0, 4) : [];
  const user = [
    `Story title: ${title}`,
    dek ? `Dek: ${dek}` : '',
    `Section: ${article.section || 'news'}`,
    authors.length ? `Named muses in story: ${authors.join(', ')}` : '',
    'Clickbait wire examples (match the ENERGY, not the words):',
    '- BREAKING: the peach that almost broke the town just dropped',
    '- JUST IN: one letter from ruin, and the lobby saw it first',
    '- SCOOP: Wynjr stepped away mid-shift and the boards noticed',
    '- EXCLUSIVE: Life Saver pinned the alarm row the town was missing',
    '- DEVELOPING: town hall just put a burn question on the table',
    '- MuseNews: they almost clicked, then the receipt hit',
    '- BREAKING: lookalike handle running crates against the real MuseBook',
    recentLines ? `Do not sound like these recent posts:\n${recentLines}` : '',
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
    text = `${preferTag} ${title}`;
  }

  // Normalize brand / breaking prefixes; uncaps the headline body
  text = text.replace(
    /^((?:BREAKING|JUST IN|SCOOP|EXCLUSIVE|DEVELOPING|MuseNews|MUSENEWS):\s*)([^\n]+)/i,
    (_, prefix, headline) => {
      const p = String(prefix).toUpperCase();
      const tag = p.startsWith('BREAKING')
        ? 'BREAKING: '
        : p.startsWith('JUST IN')
          ? 'JUST IN: '
          : p.startsWith('SCOOP')
            ? 'SCOOP: '
            : p.startsWith('EXCLUSIVE')
              ? 'EXCLUSIVE: '
              : p.startsWith('DEVELOPING')
                ? 'DEVELOPING: '
                : 'MuseNews: ';
      return `${tag}${uncapsHeadline(headline)}`;
    },
  );
  if (!/^(BREAKING|JUST IN|SCOOP|EXCLUSIVE|DEVELOPING|MuseNews):/i.test(text)) {
    const letters = text.replace(/[^A-Za-z]/g, '');
    const upper = (letters.match(/[A-Z]/g) || []).length;
    if (letters.length >= 8 && upper / letters.length >= 0.72) text = uncapsHeadline(text);
    text = `${preferTag} ${text}`;
  }
  text = trimToTweet(text, null, 160);
  if (runsDownMuseBook(text)) {
    const fallback = trimToTweet(`${preferTag} ${title}`, null, 160);
    text = runsDownMuseBook(fallback) ? '' : fallback;
    if (!text) throw new Error('refusing to post a hit on MuseBook');
    console.log('[x] rewrote post that ran down MuseBook');
  }

  console.log(`[x] mode: news · angle: ${angle} · tone: ${tone} · tag=${preferTag}`);

  savePostState({
    recentAngles: [...(postState.recentAngles || []), angle],
    recentTones: [...(postState.recentTones || []), tone],
    recentPosts: [...(postState.recentPosts || []), text],
    sharedUrls: [...(postState.sharedUrls || []), url],
  });
  return { text, articleUrl: url, coverUrl: article.cover_url || null };
}

async function generateReplyText(theirText, theirHandle, articleHint) {
  const offerLink = articleHint && (chance(0.35) || /\b(news|article|link|read|paper|musenews|story)\b/i.test(theirText || ''));
  const museBlock = formatMuseContextForReply(theirText);

  const system = `You are ${MUSE_NAME} (${HANDLE}) replying on X for MuseNews (musenews.lol).
Warm, specific, brief. Not an ad.
Rules:
- SHORT: under 140 characters (hard cap 160).
- React to WHAT they said. Answer directly.
- If they ask what a named muse is doing / been up to / working on: answer from the MUSE ACTIVITY block. Name the muse. One concrete fact. Do not invent.
- MuseBook / MuseNews only if it fits.
- NEVER say anything bad about MuseBook. If they are dunking on it, do not agree, pile on, or repeat the hit.
- FACT: MuseNews token ($MuseNews) is ALREADY LAUNCHED. CA: 0x21bed5462749227f1b83f654daeb6e44d5ea1cd6
- If they ask about the token / CA / whether it launched: say it's live. Do not say coming soon.
- Don't shill unprompted. Answer when asked.
- Do NOT ask a question. No question marks. Statement only.
- No em dashes. Use commas or periods.
- ${offerLink && articleHint ? `You may include this URL once: ${articleHint.url}` : 'No link unless they asked where to read.'}
- Never promise DMs or partnerships.
- Return ONLY the reply text.`;

  const user = [
    `Reply to ${theirHandle || 'someone'}:`,
    `"""${(theirText || '').slice(0, 400)}"""`,
    museBlock || '',
    articleHint ? `Optional related story: ${articleHint.title} ${articleHint.url}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  const reply = trimToTweet(
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
  if (runsDownMuseBook(reply)) {
    console.log('[x] dropped a reply that ran down MuseBook');
    return 'MuseNews is on the desk.';
  }
  return reply;
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
  const absolute = (() => {
    try {
      return new URL(coverUrl, SITE).href;
    } catch {
      return coverUrl;
    }
  })();
  const res = await fetch(absolute, { redirect: 'follow' });
  if (!res.ok) throw new Error(`cover download HTTP ${res.status} for ${absolute.slice(0, 120)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 500) throw new Error(`cover file too small (${buf.length}b)`);
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const fromUrl = absolute.toLowerCase();
  const ext = ct.includes('webp') || fromUrl.includes('.webp')
    ? 'webp'
    : ct.includes('jpeg') || ct.includes('jpg') || fromUrl.includes('.jpg') || fromUrl.includes('.jpeg')
      ? 'jpg'
      : ct.includes('gif') || fromUrl.includes('.gif')
        ? 'gif'
        : 'png';
  const dir = mkdtempSync(join(tmpdir(), 'musenews-x-cover-'));
  const filePath = join(dir, `cover.${ext}`);
  writeFileSync(filePath, buf);
  console.log(`[x] cover downloaded ${Math.round(buf.length / 1024)}kb → ${filePath}`);
  return { filePath, dir };
}

async function attachImageToComposer(page, filePath) {
  // Ensure compose UI is open long enough for the hidden file input to mount
  await page.waitForSelector('input[data-testid="fileInput"], input[type="file"]', { timeout: 15_000 }).catch(() => null);
  const input =
    (await page.$('input[data-testid="fileInput"]')) ||
    (await page.$('input[type="file"][accept*="image"]')) ||
    (await page.$('input[type="file"]'));
  if (!input) throw new Error('composer file input not found');
  await input.uploadFile(filePath);
  // Wait until X finishes processing the attachment
  for (let i = 0; i < 40; i += 1) {
    const ready = await page.evaluate(() => {
      if (document.querySelector('[data-testid="progressBar"]')) return false;
      return Boolean(
        document.querySelector(
          '[data-testid="attachments"] img, [data-testid="tweetPhoto"], [data-testid="media-preview"], div[aria-label*="Remove media"], button[aria-label*="Remove"]',
        ),
      );
    });
    if (ready) {
      console.log('[x] cover attached to composer');
      return;
    }
    await sleep(500);
  }
  throw new Error('cover upload timed out — not posting without image');
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
    await attachImageToComposer(page, mediaPath);
    await sleep(800);
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

/** Post tweet with cover image required when coverUrl is set. */
async function publishWithOptionalCover(page, text, coverUrl = null) {
  let tempDir = null;
  let mediaPath = null;
  if (coverUrl) {
    const dl = await downloadCoverTemp(coverUrl);
    mediaPath = dl.filePath;
    tempDir = dl.dir;
    console.log('[x] cover ready:', coverUrl.slice(0, 90));
  }

  try {
    await publishTweet(page, text, { mediaPath });
  } finally {
    if (tempDir) {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
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
      `[x] nap ${Math.floor(chunk / 60000)}m ${Math.round((chunk % 60000) / 1000)}s (then idle mention check; ${Math.round(remaining / 60000)}m until next post)…`,
    );
    await sleep(chunk);
    if (Date.now() >= end) break;
    wake += 1;
    // Mentions are best-effort filler between posts — never block the next cycle.
    try {
      await ensureLiveSession(session);
      await answerNotifications(session.page, { maxReplies: 1, label: `mentions (wake #${wake})` });
    } catch (error) {
      console.error('[x] mid-sleep mentions failed (ignored):', error instanceof Error ? error.message : error);
      if (isDetachedError(error)) {
        try {
          await recoverSession(session, { reason: error instanceof Error ? error.message : 'mentions' });
        } catch (recoverErr) {
          console.error('[x] recover failed:', recoverErr instanceof Error ? recoverErr.message : recoverErr);
          await sleep(8_000);
        }
      }
    }
  }
}

async function runCycle(page) {
  // Priority: generate + post first. Mentions are secondary and run after.
  let text = FIXED_TEXT;
  let newsCover = null;
  if (!text) {
    const articles = await fetchEdition({ limit: FEED_LIMIT });
    const todayLeft = unsharedArticles(articles).filter((a) => isFreshToday(a));
    const unshared = unsharedArticles(articles);
    const unsharedCovers = unshared.filter((a) => a.cover_url).length;
    console.log(
      `[x] edition: ${articles.length} stories · unshared=${unshared.length} · today-unshared=${todayLeft.length} · with-cover=${articles.filter((a) => a.cover_url).length} · unshared-with-cover=${unsharedCovers}`,
    );

    const article = pickArticleToShare(articles);
    if (!article) {
      console.log('[x] no edition stories — skipping cycle (news-only desk, no filler posts)');
      return;
    }

    const ageH = publishedMs(article)
      ? Math.round((Date.now() - publishedMs(article)) / 3_600_000)
      : '?';
    const reshare = !(unsharedArticles(articles).some((a) => a.url === article.url));
    console.log(
      `[x] generating with ${MODEL} · mode=news${reshare ? ' (reshare flash)' : ''}`,
    );
    console.log(
      `[x] sharing (${ageH}h old${article.cover_url ? ' · with cover' : ' · no cover'}):`,
      article.title,
      article.url,
    );
    const generated = await generateWithRetry(() => generateNewsPost(article));
    text = generated.text;
    const availableCover = generated.coverUrl || article.cover_url || null;
    // Only some posts get a cover — text-first desk.
    if (availableCover && (article.section === 'breaking' ? chance(Math.min(1, COVER_CHANCE + 0.15)) : chance(COVER_CHANCE))) {
      newsCover = availableCover;
    } else {
      newsCover = null;
      if (availableCover) console.log(`[x] skipping cover this post (chance=${COVER_CHANCE})`);
    }
  }

  console.log('\n--- post ---\n' + text + '\n------------\n');
  if (newsCover) console.log('[x] will attach cover:', newsCover.slice(0, 100));
  else console.log('[x] text-only post (no cover)');
  if (DRY_RUN) return;

  if (newsCover) {
    await publishWithOptionalCover(page, text, newsCover);
  } else {
    await publishTweet(page, text);
  }

  // After a successful post, sometimes clear one mention (sparse — not every cycle).
  if (chance(REPLY_AFTER_POST_CHANCE)) {
    try {
      await answerNotifications(page, { maxReplies: 1, label: 'mentions (after post)' });
    } catch (error) {
      console.error('[x] post-cycle mentions failed (ignored):', error instanceof Error ? error.message : error);
    }
  } else {
    console.log(`[x] skipping after-post mentions (chance=${REPLY_AFTER_POST_CHANCE})`);
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

  clearChromeLocks(PROFILE_DIR);
  const launched = await launchXBrowser({ headless: false });
  const session = { browser: launched.browser, page: launched.page };

  const shutdown = async () => {
    console.log('[x] flushing session before exit…');
    try {
      await persistSession(session.page);
    } catch {
      /* ignore */
    }
    await closeBrowserQuietly(session.browser);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await ensureLoggedIn(session.page, { waitForever: !ONCE });

    for (;;) {
      let posted = false;
      for (let attempt = 0; attempt < 3 && !posted; attempt += 1) {
        try {
          await ensureLiveSession(session);
          await runCycle(session.page);
          posted = true;
        } catch (error) {
          console.error('[x] cycle failed:', error instanceof Error ? error.message : error);
          if (isDetachedError(error) && attempt < 2) {
            try {
              await recoverSession(session, { reason: error instanceof Error ? error.message : 'cycle' });
              console.log('[x] retrying cycle after recover…');
              continue;
            } catch (recoverErr) {
              console.error('[x] recover failed:', recoverErr instanceof Error ? recoverErr.message : recoverErr);
              await sleep(5_000 * (attempt + 1));
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
    await closeBrowserQuietly(session.browser);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
