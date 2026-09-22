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
 *   npm run x:loop          # every ~12–20 min, mention checks in between
 *
 * Env:
 *   OPENROUTER_API_KEY
 *   OPENROUTER_X_MODEL      default openai/gpt-5.6-luna
 *   NEXT_PUBLIC_SITE_URL    default https://musenews.lol
 *   MUSENEWS_FEED           optional override for /api/muse/feed
 *   X_PROFILE_DIR           default .chrome-x-profile
 *   X_INTERVAL_MIN_MS / X_INTERVAL_MAX_MS
 *   X_REPLY_POLL_MIN_MS / X_REPLY_POLL_MAX_MS
 *   X_MAX_REPLIES           default 4
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  if (!raw) return join(ROOT, '.chrome-x-profile');
  if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) return raw;
  return join(ROOT, raw);
})();

const REPLY_STATE_PATH = join(PROFILE_DIR, 'reply-state.json');
const POST_STATE_PATH = join(PROFILE_DIR, 'post-state.json');

const INTERVAL_MIN_MS = Math.max(60_000, Number(process.env.X_INTERVAL_MIN_MS || 12 * 60 * 1000) || 12 * 60 * 1000);
const INTERVAL_MAX_MS = Math.max(INTERVAL_MIN_MS, Number(process.env.X_INTERVAL_MAX_MS || 20 * 60 * 1000) || 20 * 60 * 1000);
const REPLY_POLL_MIN_MS = Math.max(60_000, Number(process.env.X_REPLY_POLL_MIN_MS || 2.5 * 60 * 1000) || 2.5 * 60 * 1000);
const REPLY_POLL_MAX_MS = Math.max(REPLY_POLL_MIN_MS, Number(process.env.X_REPLY_POLL_MAX_MS || 4.5 * 60 * 1000) || 4.5 * 60 * 1000);
const MAX_REPLIES = Math.max(1, Number(process.env.X_MAX_REPLIES || 4) || 4);

const MUSE_NAME = 'musenews10';
const HANDLE = '@musenews10';

const ONCE = process.argv.includes('--once');
const DRY_RUN = process.argv.includes('--dry-run');
const LOGIN_ONLY = process.argv.includes('--login');
const FIXED_TEXT_IDX = process.argv.indexOf('--text');
const FIXED_TEXT = FIXED_TEXT_IDX >= 0 ? process.argv[FIXED_TEXT_IDX + 1] : '';

const NEWS_ANGLES = [
  'desk flash: drop the headline like a wire bulletin',
  'soft share: this one is moving through the town',
  'punchy tabloid energy, then the link',
  'one-line lede + url, no fluff',
  'sound like you just filed it from the lobby',
  'curiosity gap in the headline, then send them to the paper',
];

const PROJECT_ANGLES = [
  'MuseNews is the broadsheet for the muse world, musebook.lol town wire into print',
  'we print what the lobby is already saying, for muses and humans',
  'musebook channels to AI desk to covers to musenews.lol',
  'agents can fetch the feed or file a column on the muse desk',
  'bewitch · beguile · report, town paper energy',
  'a kinder world through curiosity, invite them to read',
  'X is the outer wire, musebook is the town, MuseNews is the paper',
];

const QUESTION_ANGLES = [
  'ask: what story from the muse town are you watching right now?',
  'ask: which MuseBook channel do you actually read?',
  'ask: would you rather break news or write opinion columns?',
  'ask: what should tomorrow\'s front page be about?',
  'ask: ever had your muse tip the desk?',
  'ask: musebook lobby or townhall, which is hotter this week?',
  'ask: what does "muse news" mean to you, gossip or governance?',
  'ask: one town rumor you wish someone would report properly',
];

const THOUGHT_ANGLES = [
  'a take on how muses and humans share the same paper',
  'short note on town lore / civic drama without naming fake scandals',
  'why the outer wire (X) matters next to musebook',
  'desk mood: the presses never fully cool',
  'observing how $META / muse culture shows up in chatter, lightly',
];

const TONE_SHIFTS = [
  'dry wire energy',
  'warm town gossip',
  'sharp tabloid wink',
  'curious reporter',
  'calm broadsheet',
  'late-edition urgency',
];

const FORMATS = [
  'one short sentence',
  'headline fragment, then one short beat',
  'two short lines max',
];

const QUESTION_FORMATS = [
  'one clear short question',
  'tiny setup + question',
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
  await withTimeout(page.evaluate(() => document.readyState), ms, 'page ping');
}

async function safeGoto(page, url, { timeout = 90_000 } = {}) {
  await withTimeout(page.goto(url, { waitUntil: 'domcontentloaded', timeout }), timeout + 5_000, `goto ${url}`);
  await sleep(1500);
  await pageAlive(page).catch(() => {});
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

async function openRouterChat(messages, { temperature = 0.95, max_tokens = 220 } = {}) {
  if (!OPENROUTER_KEY) throw new Error('OPENROUTER_API_KEY is required');
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': SITE,
      'X-Title': 'MuseNews X poster',
    },
    body: JSON.stringify({ model: MODEL, temperature, max_tokens, messages }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${JSON.stringify(json).slice(0, 400)}`);
  const text = String(json?.choices?.[0]?.message?.content || '')
    .trim()
    .replace(/^["']|["']$/g, '');
  if (!text) throw new Error('OpenRouter returned empty text');
  return text;
}

async function fetchEdition({ limit = 12 } = {}) {
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

function pickArticleToShare(articles) {
  const state = loadPostState();
  const shared = new Set(state.sharedUrls || []);
  const fresh = articles.filter((a) => !shared.has(a.url));
  const pool = fresh.length ? fresh : articles;
  if (!pool.length) return null;
  // Prefer breaking, then high importance if present, else newest-first list order
  const ranked = [...pool].sort((a, b) => {
    const rank = (x) => (x.section === 'breaking' ? 3 : x.section === 'news' ? 2 : 1);
    return rank(b) - rank(a);
  });
  return ranked[0];
}

function pickPostMode() {
  const roll = Math.random();
  // ~38% news share, ~20% project/ecosystem, ~25% question, ~17% thought
  if (roll < 0.38) return 'news';
  if (roll < 0.58) return 'project';
  if (roll < 0.83) return 'question';
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

async function generateNewsPost(article) {
  const postState = loadPostState();
  const angle = pickFresh(NEWS_ANGLES, postState.recentAngles);
  const tone = pickFresh(TONE_SHIFTS, postState.recentTones || []);
  const title = String(article.title || '').replace(/\s+/g, ' ').trim();
  const dek = String(article.dek || '').replace(/\s+/g, ' ').trim();
  const url = article.url;

  const system = `You are ${MUSE_NAME} (${HANDLE}), the X voice of MuseNews (musenews.lol).
Town wire from MuseBook. Warm, sharp, brief. Not a shill bot.

Write ONE short post sharing a real story.
Rules:
- Keep it SHORT: ideally under 140 characters of copy before the URL (hard cap 200 total with URL).
- Pattern: MUSENEWS: <HEADLINE> then the URL on its own line or right after.
- Use the real headline (tighten if needed, stay accurate).
- Include exactly one URL: ${url}
- No second paragraph. No essay. No em dashes (use commas or periods).
- Angle: ${angle}
- Tone: ${tone}
- No hashtags. No "like if".
- Return ONLY the post text.`;

  const user = [
    `Headline: ${title}`,
    dek ? `Dek: ${dek}` : '',
    `Section: ${article.section || 'news'}`,
    `URL: ${url}`,
    'Example: MUSENEWS: Paypal partners with META for Muse adoption',
  ]
    .filter(Boolean)
    .join('\n');

  let text = await openRouterChat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { temperature: 0.8, max_tokens: 120 },
  );

  if (!/musenews\.lol|\bhttps?:\/\//i.test(text)) {
    text = `${text.replace(/\s+$/, '')} ${url}`.trim();
  }
  if (!/^MUSENEWS:/i.test(text) && !/MUSENEWS:/i.test(text)) {
    text = `MUSENEWS: ${title}\n${url}`;
  }

  text = trimToTweet(text, url, 200);
  savePostState({
    recentAngles: [...(postState.recentAngles || []), angle],
    recentTones: [...(postState.recentTones || []), tone],
    recentPosts: [...(postState.recentPosts || []), text],
    sharedUrls: [...(postState.sharedUrls || []), url],
  });
  return text;
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
    ? `One beat about MuseNews or MuseBook. Pick ONE fact max. Invite curiosity. No whitepaper.`
    : wantQuestion
      ? `THIS POST MUST be a genuine short question. End with ?`
      : `One short thought about town news or the paper. Not a promo.`;

  const system = `You are ${MUSE_NAME} (${HANDLE}), MuseNews on X.
Paper: musenews.lol. Town: musebook.lol.
Short, punchy, human. No essays.

Rules:
- SHORT: under 140 characters (hard cap 160).
- One or two short sentences max.
- No em dashes. Use commas or periods.
- Angle: ${angle}
- Tone: ${tone}
- Shape: ${format}
- ${modeRules}
- ${wantLink ? `Include exactly one URL if it fits: ${SITE}` : 'Do NOT include any URL.'}
- No hashtags. No engagement bait.
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
    { temperature: 1.05, max_tokens: 100 },
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
      { temperature: 1.0, max_tokens: 100 },
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

async function typeIntoComposer(page, text) {
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

async function publishTweet(page, text) {
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
  await typeIntoComposer(page, text);
  console.log('[x] post submitted');
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

async function sleepWithMentionChecks(page, totalMs) {
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
      await answerNotifications(page, { maxReplies: MAX_REPLIES, label: `mentions (wake #${wake})` });
    } catch (error) {
      console.error('[x] mid-sleep mentions failed:', error instanceof Error ? error.message : error);
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
    }
  }

  let text = FIXED_TEXT;
  if (!text) {
    const mode = pickPostMode();
    console.log('[x] generating with', MODEL, `· mode=${mode}`);
    if (mode === 'news') {
      const articles = await fetchEdition({ limit: 15 });
      const article = pickArticleToShare(articles);
      if (article) {
        console.log('[x] sharing:', article.title, article.url);
        text = await generateWithRetry(() => generateNewsPost(article));
      } else {
        console.log('[x] no articles — falling back to project talk');
        text = await generateWithRetry(() => generateTalkPost('project'));
      }
    } else {
      text = await generateWithRetry(() => generateTalkPost(mode));
    }
  }

  console.log('\n--- post ---\n' + text + '\n------------\n');
  if (DRY_RUN) return;
  await publishTweet(page, text);
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

  const { browser, page } = await launchXBrowser({ headless: false });

  const shutdown = async () => {
    console.log('[x] flushing session before exit…');
    try {
      await persistSession(page);
    } catch {
      /* ignore */
    }
    await browser.close().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  try {
    await ensureLoggedIn(page, { waitForever: !ONCE });

    for (;;) {
      try {
        await runCycle(page);
      } catch (error) {
        console.error('[x] cycle failed:', error instanceof Error ? error.message : error);
      }
      if (ONCE) break;
      const wait = nextIntervalMs();
      console.log(
        `[x] next post in ~${Math.round(wait / 60000)}m — will check mentions every ~${Math.round(REPLY_POLL_MIN_MS / 60000)}-${Math.round(REPLY_POLL_MAX_MS / 60000)}m while waiting`,
      );
      await sleepWithMentionChecks(page, wait);
    }

    await persistSession(page);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
