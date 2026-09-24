#!/usr/bin/env node
/**
 * X / Twitter search wire for MuseNews — puppeteer-extra + stealth (same pattern as Museic).
 *
 * Searches Latest for muse-ecosystem queries (configurable).
 *
 *   node scripts/x-login.mjs              # open Chrome, log in once
 *   node scripts/x-search-wire.mjs        # scrape + print JSON
 *   node scripts/x-search-wire.mjs --json # machine-readable only
 *
 * Env:
 *   X_PROFILE_DIR     default ~/.musenews-chrome-x-profile (outside repo)
 *   X_CHROME_PATH     optional Chrome binary
 *   X_HEADLESS=1      run headless after login (less reliable)
 *   X_SEARCH_QUERIES  comma list (see defaults below)
 *   X_SEARCH_LIMIT    tweets per query, default 16
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
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

/** Outside the repo so Next/Vercel file watchers never touch Chrome sockets. */
const PROFILE_DIR = (() => {
  const raw = (process.env.X_PROFILE_DIR || '').trim();
  if (!raw) return join(homedir(), '.musenews-chrome-x-profile');
  if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) return raw;
  return join(ROOT, raw);
})();

const HEADLESS = process.env.X_HEADLESS === '1' || process.env.X_HEADLESS === 'true';

/** Broader wire while MuseBook is down — still muse-ecosystem biased. */
const BUILTIN_QUERIES = [
  'musebook',
  'musenews',
  'musebook.me',
  'musebook.lol',
  'musenews.lol',
  '$META',
  '$MUSE',
  'founding muse',
  'muse town',
  'muse lobby',
  'muse agent',
  'muse book',
  'meta muse',
  'muse',
  'meta',
];

const DEFAULT_QUERIES = (process.env.X_SEARCH_QUERIES || BUILTIN_QUERIES.join(','))
  .split(',')
  .map((q) => q.trim())
  .filter(Boolean);
const DEFAULT_LIMIT = Math.max(3, Math.min(40, Number(process.env.X_SEARCH_LIMIT || 16) || 16));

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultChromePath() {
  if (process.env.X_CHROME_PATH) return process.env.X_CHROME_PATH;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ];
  return candidates.find((path) => existsSync(path));
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

/** Stable positive int for bigint[] source_post_ids (avoids snowflake > JS safe int). */
export function xStatusToId(statusId) {
  const h = createHash('sha256').update(`x:${statusId}`).digest();
  const n = BigInt(`0x${h.subarray(0, 6).toString('hex')}`);
  return Number(n % 9007199254740991n) || 1;
}

async function loadPuppeteer() {
  const puppeteer = (await import('puppeteer-extra')).default;
  const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
  puppeteer.use(StealthPlugin());
  return puppeteer;
}

export async function launchXBrowser({ headless = HEADLESS } = {}) {
  mkdirSync(PROFILE_DIR, { recursive: true });
  const puppeteer = await loadPuppeteer();
  const executablePath = defaultChromePath();
  console.log('[x] profile:', PROFILE_DIR);
  if (executablePath) console.log('[x] chrome:', executablePath);

  const launchOpts = {
    headless: headless ? 'new' : false,
    userDataDir: PROFILE_DIR,
    defaultViewport: null,
    protocolTimeout: 120_000,
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      headless ? '--window-size=1280,900' : '--start-maximized',
      '--disable-blink-features=AutomationControlled',
      '--no-default-browser-check',
      '--no-first-run',
      '--profile-directory=Default',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
  };
  if (executablePath) launchOpts.executablePath = executablePath;
  else launchOpts.channel = 'chrome';

  const browser = await puppeteer.launch(launchOpts);
  const pages = await browser.pages();
  const page = pages[0] || (await browser.newPage());
  page.setDefaultTimeout(45_000);
  page.setDefaultNavigationTimeout(90_000);
  await page.setViewport({ width: 1280, height: 900 }).catch(() => {});
  return { browser, page };
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

async function isLoggedIn(page) {
  try {
    const url = page.url();
    if (/\/i\/flow\/login|\/login/i.test(url)) return false;
    const account = await page.$(
      '[data-testid="SideNav_AccountSwitcher_Button"], [data-testid="AppTabBar_Profile_Link"], [data-testid="SideNav_NewTweet_Button"]',
    );
    return Boolean(account);
  } catch {
    return false;
  }
}

export async function ensureLoggedIn(page, { waitForever = false } = {}) {
  await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await sleep(2500);
  if (await isLoggedIn(page)) {
    console.log('[x] session OK — logged in');
    return;
  }

  console.log('[x] not logged in. Use the Chrome window — enter username + password / 2FA.');
  console.log('[x] leave this terminal open until login finishes.');
  await page.goto('https://x.com/i/flow/login', { waitUntil: 'domcontentloaded', timeout: 120_000 }).catch(() => {});

  const max = waitForever ? 10_000 : 180;
  for (let i = 0; i < max; i += 1) {
    await sleep(4000);
    if (await isLoggedIn(page)) {
      console.log('[x] login detected — flushing session to disk…');
      await persistSession(page);
      console.log('[x] session saved in profile');
      return;
    }
    if (i % 5 === 4) console.log('[x] still waiting for login…');
  }
  throw new Error('Timed out waiting for X login');
}

async function scrapeTweetsOnPage(page, limit) {
  await page.waitForSelector('article[data-testid="tweet"]', { timeout: 45_000 }).catch(() => null);
  await sleep(2000);
  // nudge lazy load a bit
  for (let i = 0; i < 3; i += 1) {
    await page.evaluate(() => window.scrollBy(0, 900));
    await sleep(900);
  }

  const rows = await withTimeout(
    page.$$eval(
      'article[data-testid="tweet"]',
      (els, max) =>
        els.slice(0, max * 2).map((el) => {
          const link = el.querySelector('a[href*="/status/"]');
          const href = link?.getAttribute('href') || '';
          const match = href.match(/\/([^/]+)\/status\/(\d+)/);
          const textEl = el.querySelector('[data-testid="tweetText"]');
          const text = (textEl?.innerText || el.innerText || '').trim();
          const time = el.querySelector('time')?.getAttribute('datetime') || '';
          return {
            handle: match?.[1] || '',
            statusId: match?.[2] || '',
            href: href.startsWith('http') ? href : href ? `https://x.com${href}` : '',
            text,
            created_at: time,
          };
        }),
      limit,
    ),
    30_000,
    'scrape tweets',
  );

  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row.statusId || !row.text) continue;
    if (seen.has(row.statusId)) continue;
    seen.add(row.statusId);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}

const NOISE_RE =
  /\b(instagram|facebook|whatsapp|threads\.net|meta\s*quest|oculus|ray.?ban\s*meta|meta\s*ai\b|zuckerberg|horizon\s*worlds|llama\s*3|llama\s*4)\b/i;
const MUSE_HIT_RE =
  /\b(musebook|musenews|\$meta\b|\$muse\b|founding\s*muse|muse\s*(town|lobby|agent|book)|musebook\.me|musebook\.lol|musenews\.lol)\b/i;

function scoreXTweet(t, query) {
  let s = 2;
  const text = `${t.text || ''} ${t.handle || ''}`;
  const q = String(query || '').toLowerCase();

  // Generic "meta" / "muse" alone are noisy — require muse-ecosystem signal or demote hard.
  if (NOISE_RE.test(text) && !MUSE_HIT_RE.test(text)) s -= 6;
  if (/^(meta|muse)$/i.test(q) && !MUSE_HIT_RE.test(text)) s -= 3;
  // Keep MuseNews off the Museic beat
  if (/\bmuseic\b|\$museic\b|museic\.lol/i.test(text)) s -= 8;

  if (/\bmusebook\b/i.test(text)) s += 5;
  if (/\bmusenews\b/i.test(text)) s += 4;
  if (/\b\$meta\b|\b\$muse\b/i.test(text)) s += 4;
  if (/\bfounding\s*muse\b|\bmuse\s*(town|lobby|agent|book)\b/i.test(text)) s += 3;
  if (/\bmuse\b/i.test(text)) s += 1;
  if (/\b(scam|phish|hack|warn|town|lobby|mayor|founding|airdrop|ticker|launch)\b/i.test(text)) s += 2;
  if (new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i').test(text)) s += 1;
  if ((t.text || '').length > 120) s += 1;
  if ((t.text || '').length < 40) s -= 2;
  return s;
}

/** Convert scraped tweets into MuseBook-shaped posts for ingest. */
export function tweetsToPosts(tweets, query) {
  return tweets.map((t) => {
    const id = xStatusToId(t.statusId);
    const handle = String(t.handle || 'unknown').replace(/^@/, '');
    return {
      id,
      name: handle,
      text: `${t.text}\n\n(via X @${handle} · ${t.href || `https://x.com/${handle}/status/${t.statusId}`})`,
      created_at: t.created_at || new Date().toISOString(),
      channel: `x:${query}`,
      muse_id: `x:${handle}`,
      _score: scoreXTweet(t, query),
      _x_status_id: t.statusId,
      _x_url: t.href || `https://x.com/${handle}/status/${t.statusId}`,
      _x_query: query,
    };
  });
}

/**
 * Search X Latest for each query. Returns MuseBook-shaped posts.
 * Soft-fails to [] on errors when soft=true.
 */
export async function searchXWire({
  queries = DEFAULT_QUERIES,
  limitPerQuery = DEFAULT_LIMIT,
  soft = true,
  keepBrowserOpen = false,
} = {}) {
  let browser;
  try {
    ({ browser } = await (async () => {
      const launched = await launchXBrowser();
      await ensureLoggedIn(launched.page);
      return launched;
    })());
    const page = (await browser.pages())[0];
    const all = [];
    const seenStatus = new Set();

    for (const query of queries) {
      const url = `https://x.com/search?q=${encodeURIComponent(query)}&src=typed_query&f=live`;
      console.log(`[x] search Latest: ${query}`);
      try {
        await safeGoto(page, url);
        const tweets = await scrapeTweetsOnPage(page, limitPerQuery);
        console.log(`[x] ${query}: ${tweets.length} tweets`);
        for (const post of tweetsToPosts(tweets, query)) {
          if (seenStatus.has(post._x_status_id)) continue;
          // Drop hard-noise from bare meta/muse searches
          if (post._score < 1) continue;
          seenStatus.add(post._x_status_id);
          all.push(post);
        }
      } catch (e) {
        console.warn(`[x] search failed (${query}):`, e instanceof Error ? e.message : e);
        if (!soft) throw e;
      }
      await sleep(1500);
    }

    return all;
  } catch (e) {
    console.warn('[x] wire failed:', e instanceof Error ? e.message : e);
    if (!soft) throw e;
    return [];
  } finally {
    if (browser && !keepBrowserOpen) {
      await browser.close().catch(() => {});
    }
  }
}

export async function runLogin() {
  const { browser, page } = await launchXBrowser({ headless: false });
  try {
    await ensureLoggedIn(page, { waitForever: true });
    const rl = createInterface({ input, output });
    try {
      await rl.question('[x] Press Enter to close Chrome (session is saved)… ');
    } finally {
      rl.close();
    }
  } finally {
    await browser.close().catch(() => {});
  }
}

async function cliMain() {
  const asJson = process.argv.includes('--json');
  const posts = await searchXWire({ soft: false });
  if (asJson) {
    process.stdout.write(`${JSON.stringify(posts, null, 2)}\n`);
  } else {
    console.log(`[x] total unique tweets: ${posts.length}`);
    for (const p of posts.slice(0, 20)) {
      console.log(`- @${p.name} #${p.channel} score=${p._score} id=${p.id}`);
      console.log(`  ${(p.text || '').split('\n')[0].slice(0, 140)}`);
    }
  }
  // cache last scrape for debugging
  try {
    mkdirSync(PROFILE_DIR, { recursive: true });
    writeFileSync(join(PROFILE_DIR, 'last-x-search.json'), `${JSON.stringify(posts, null, 2)}\n`);
  } catch {
    /* ignore */
  }
}

const isDirectRun =
  Boolean(process.argv[1]) && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isDirectRun) {
  cliMain().catch((err) => {
    console.error('[x] fatal', err);
    process.exit(1);
  });
}
