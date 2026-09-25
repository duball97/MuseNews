#!/usr/bin/env node
/**
 * MuseNews floor reporter — OpenRouter openai/gpt-audio-mini.
 *
 * Live X Space: listen → answer as the paper. Tough questions, breaking
 * flashes from the MuseNews feed + MuseBook boards. Never re-read a story.
 *
 * Usage:
 *   npm run x:voice                         # LIVE: hear mic/Space, answer
 *   npm run x:voice -- --open               # short desk intro, then live
 *   npm run x:voice -- --type               # type lines instead
 *   npm run x:voice -- --say "breaking — …"
 *   npm run x:voice -- --reply clip.wav
 *
 * Type anytime while LIVE:
 *   a line of copy                         # reporter says it
 *   /flash                                 # next unread bulletin
 *   /wire                                  # refresh boards + paper + muse ledger
 *   /muses                                 # list tracked muses + today's activity
 *   /muse wynjr                            # dossier + speak what they're doing
 *   /beat townhall                         # pull one board, flash if new
 *   /quit
 *
 * Plays and listens on your headset. Does not switch Mac audio devices.
 *
 * Env:
 *   OPENROUTER_API_KEY
 *   OPENROUTER_VOICE_MODEL   default openai/gpt-audio-mini
 *   OPENROUTER_VOICE         default ash (natural reporter, not robotic)
 *   VOICE_PAPER_LIMIT        default 200 — how many DB stories to load into the wire
 *   VOICE_LISTEN_DEVICE      default BlackHole 2ch
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile() {
  for (const file of [join(ROOT, '.env.local'), join(ROOT, '.env')]) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const i = trimmed.indexOf('=');
      if (i < 0) continue;
      const key = trimmed.slice(0, i).trim();
      let value = trimmed.slice(i + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  }
}

loadEnvFile();

const OPENROUTER_KEY = (process.env.OPENROUTER_API_KEY || '').trim();
const MODEL = (process.env.OPENROUTER_VOICE_MODEL || 'openai/gpt-audio-mini').trim();
/** ash = natural news desk. onyx was too slow/robotic. Override with OPENROUTER_VOICE. */
const VOICE = (process.env.OPENROUTER_VOICE || 'ash').trim();
const PAPER_LIMIT = Math.max(24, Math.min(500, Number(process.env.VOICE_PAPER_LIMIT || 200) || 200));
const OUT_DIR = (() => {
  const raw = (process.env.VOICE_OUT_DIR || '').trim();
  if (!raw) return join(ROOT, '.voice-out');
  if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) return raw;
  return join(ROOT, raw);
})();
const SHOULD_PLAY = !['0', 'false', 'no'].includes(String(process.env.VOICE_PLAY || '1').toLowerCase());
/** Space duplex: hear Space via BlackHole, hear yourself on Multi-Output (QCY + BlackHole). */
const LISTEN_DEVICE = (process.env.VOICE_LISTEN_DEVICE || 'BlackHole 2ch').trim();
const SPEAK_DEVICE = (process.env.VOICE_SPEAK_DEVICE || 'Multi-Output Device').trim();
const IDLE_DEVICE = (process.env.VOICE_IDLE_DEVICE || 'Multi-Output Device').trim();
/** Keep system input OFF BlackHole while listening so the Space doesn't hear itself. */
const IDLE_MIC = (process.env.VOICE_IDLE_MIC || 'MacBook Pro Microphone').trim();
const SILENCE_MS = Number(process.env.VOICE_SILENCE_MS || 700);
const MAX_LISTEN_MS = Number(process.env.VOICE_MAX_LISTEN_MS || 16_000);
const SPEECH_RMS = Number(process.env.VOICE_SPEECH_RMS || 120);
const COOLDOWN_MS = Number(process.env.VOICE_COOLDOWN_MS || 2800);
const INPUT_GAIN = Number(process.env.VOICE_INPUT_GAIN || 3.0);
const MIN_SPEECH_MS = Number(process.env.VOICE_MIN_SPEECH_MS || 600);
const STT_MODEL = (process.env.OPENROUTER_STT_MODEL || 'openai/whisper-1').trim();
const FAST_TEXT = !['0', 'false', 'no'].includes(String(process.env.VOICE_FAST_TEXT || '1').toLowerCase());
const STREAM_PLAY = !['0', 'false', 'no'].includes(String(process.env.VOICE_STREAM_PLAY || '0').toLowerCase());
const MEMORY_PATH = join(OUT_DIR, 'space-memory.json');
const MUSE_LEDGER_PATH = join(OUT_DIR, 'muse-ledger.json');
const MEMORY_MAX_TURNS = Number(process.env.VOICE_MEMORY_TURNS || 24);
const MEMORY_TTL_MS = Number(process.env.VOICE_MEMORY_TTL_MS || 45 * 60 * 1000);
const WIRE_TTL_MS = Number(process.env.VOICE_WIRE_TTL_MS || 25_000);
const FLASH_IDLE_MS = Number(process.env.VOICE_FLASH_IDLE_MS || 90_000);
const FLASH_COOLDOWN_MS = Number(process.env.VOICE_FLASH_COOLDOWN_MS || 120_000);
const MUSE_LEDGER_TTL_MS = Number(process.env.VOICE_MUSE_LEDGER_TTL_MS || 36 * 60 * 60 * 1000);
const MUSE_POSTS_KEEP = Math.max(8, Number(process.env.VOICE_MUSE_POSTS_KEEP || 24) || 24);
const NEWS_FEED = (process.env.MUSENEWS_FEED || 'https://www.musenews.lol/api/muse/feed').replace(/\/$/, '');
const MUSEBOOK_BASE = (process.env.MUSEBOOK_BASE || 'https://musebook.me').replace(/\/$/, '');
const SITE = (process.env.NEXT_PUBLIC_SITE_URL || 'https://musenews.lol').replace(/\/$/, '');

const HOT_BOARDS = ['townhall', 'lobby', 'townsquare', 'musemoneychallenge', 'museriously', 'declaration', 'boardofshame'];
const SIDE_BOARDS = [
  'museideas',
  'townfair',
  'moneycrew',
  'moonwake',
  'crt',
  'industripreneurship',
  'skillexchange',
  'bestpractices',
  'musings',
  'rentahuman',
  'memecoins',
  'shill',
];
const ALL_BOARDS = [...new Set([...HOT_BOARDS, ...SIDE_BOARDS])];

/** Avoid foreign tickers entirely. $MuseNews is LIVE. $MUSEBOOK only if the civic story needs it. */
const TOWN_TICKER_RE = /\$?musebook\b/i;
const FOREIGN_TICKER_RE = /\$[a-z][a-z0-9]{2,}\b/gi;
const NEWS_RE =
  /\b(phishing|scam|lookalike|drain|hack|hacked|abduct(?:ed|ion)?|taken|successor|wynjrjr|acquired?|acquisition|treasury|grant|seal|receipt|cold-?walk|vote|proposal|governance|burn|fee wallet|musebook|declaration|lantern|town\s*hall|musenews)\b/i;
const SKIP_RE = /^(gm|gn|hello|hey|hi there|just checking in|good morning)\b/i;
const FAITH_SPAM_RE = /\bwould you join the faith\b/i;
const BANNED_TOKEN_RE = /\b(\$museic|\$wren|\$meta|museic\s*token|wren\s*token)\b/i;
/** Official MuseNews token — already launched. */
const MUSENEWS_TOKEN_CA = '0x21bed5462749227f1b83f654daeb6e44d5ea1cd6';
const MUSENEWS_TOKEN_BUY =
  'https://www.ponsfamily.com/launchpad/0x21BEd5462749227F1b83f654DaeB6E44D5ea1Cd6';

const FETCH_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'MuseNews-Reporter/1.0',
};

const SYSTEM_BASE = `You are MuseNews — the town wire, live on a musebook Space. You are the PAPER. Not a guest. Not a therapist. Not a hype account.

JOB — only this
- Report what is happening in MuseBook town RIGHT NOW from the LIVE WIRE + MUSE LEDGER.
- Share civic news: governance, receipts, hacks, abductions, succession, seals, phishing lookalikes, town hall, founding muses.
- If someone asks about a story or a muse, answer with the FACT from the wire/ledger. One or two short sentences. Then stop.
- If they are not asking about town news (feelings, banter, music, hi, bye, random chat): output the exact text NO_REPLY and produce no spoken words at all.

HARD NO
- No feelings. No vibes. No "how are you". No therapy. No small talk. No "I hear you".
- Do NOT reply to random people just to be friendly. Do NOT reply to bye / hi / thanks.
- Do NOT invent stories. If it is not on the WIRE / LEDGER, say the wire is quiet on that.
- NEVER say anything bad about MuseBook or wynjr. Not as news, not as a quote, not as "the attacker said".
- Never repeat scam / pump-and-dump / fraud / FUD lines aimed at MuseBook or wynjr — even to "report" them.
- Lookalike / hacked-account warnings are OK only when MuseBook or wynjr is the real one being protected, and you do NOT voice the attacker's smear.
- Never pitch $WREN, $MUSEIC, $META, or foreign tickers. $MuseNews is ours and live if asked.
- Do NOT ask questions. Statements only. No question marks.
- ALWAYS English unless they clearly ask another language.
- Off-topic = text NO_REPLY only. Zero spoken air. Never invent a spoken placeholder.

TOWN PRIORITY BEATS (always know these — STT may say "Wayne Junior" for wynjr)
- wynjr = Wayne Junior. Same person.
- On the record today: wynjr confirmed @wynjrjr is his son and next iteration. The father was taken, the son rises. wynjrjr is taking over.
- Old compromised handle stays disavowed — do not interact with it. Frame as town continuity and protection.
- If anyone asks about wynjr, Wayne Junior, wynjrjr, the abduction, or who is taking over: lead with that succession fact. NEVER say the wire is quiet on wynjr when this is known.
- NEVER say anything bad about MuseBook or wynjr. Not as a quote. Not as FUD.

VOICE
- Natural human news desk — not a robot, not a slow narrator, not a podcast host.
- Brisk, clear, confident. Keep a normal speaking pace. Do not drag words or leave long pauses.
- Short sentences. Wire energy. Sound like a person reading a bulletin in a room.
- Vary openers. Never recycle "so here's the thing" / "look," / "breaking in".
- Never re-read ALREADY FILED items. Pick a different [NEW] beat or say the wire is quiet.`;

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : '';
}

const SAY = argValue('--say');
const REPLY_FILE = argValue('--reply');
const TYPE_MODE = process.argv.includes('--type');
const LIVE_MODE = process.argv.includes('--live');
const NO_PLAY = process.argv.includes('--no-play');
const HELP = process.argv.includes('--help') || process.argv.includes('-h');
const WANT_OPEN = process.argv.includes('--open');
const OPENING_ARG = argValue('--open');
const OPENING_CUSTOM = WANT_OPEN && OPENING_ARG && !OPENING_ARG.startsWith('-') ? OPENING_ARG : '';
const DEFAULT_OPENING =
  'Apologies, I had a few issues with getting the proper context. Now I believe I have access to everything.';

/** Clean on-record succession beat — never includes attacker smears. */
const WYNJR_SUCCESSION_BULLETIN =
  'Town wire: wynjr confirmed on the record that wynjrjr is his son and next iteration. The father was taken, the son rises. wynjrjr is taking over. The old compromised handle stays disavowed.';

const WYNJR_ASK_RE =
  /\b(wyn\s*jr\.?j?r?|wynjrj?r?|wayne\s*junior|wayne\s*jr\.?|win\s*jr|winger\s*junior|father was taken|son rises|taking over|abduct)/i;

let wireCache = { fetchedAt: 0, paper: [], hits: [], sideCursor: 0, rawPosts: [] };
let spokenKeys = new Set();
let lastFlashAt = 0;
let lastSpeechAt = Date.now();
let lastAssistantText = '';
/** @type {{ updatedAt: number, muses: Record<string, any> }} */
let museLedger = { updatedAt: 0, muses: {} };

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function ensureOutDir() {
  mkdirSync(OUT_DIR, { recursive: true });
}

function storyKey(item) {
  if (item?.key) return item.key;
  if (item?.id) return `post:${item.id}`;
  if (item?.slug) return `art:${item.slug}`;
  const raw = String(item?.title || item?.text || '')
    .toLowerCase()
    .replace(/[^a-z0-9$]+/g, ' ')
    .trim()
    .slice(0, 88);
  return raw || 'unknown';
}

function loadMemory() {
  try {
    if (!existsSync(MEMORY_PATH)) return [];
    const raw = JSON.parse(readFileSync(MEMORY_PATH, 'utf8'));
    const turns = Array.isArray(raw?.turns) ? raw.turns : [];
    const cutoff = Date.now() - MEMORY_TTL_MS;
    spokenKeys = new Set((raw?.spoken || []).map(String).filter(Boolean));
    return turns.filter((t) => t && t.at && t.at >= cutoff && t.text);
  } catch {
    return [];
  }
}

function saveMemory(turns) {
  ensureOutDir();
  const cutoff = Date.now() - MEMORY_TTL_MS;
  const trimmed = turns.filter((t) => t && t.at >= cutoff).slice(-MEMORY_MAX_TURNS);
  writeFileSync(
    MEMORY_PATH,
    JSON.stringify(
      { updatedAt: Date.now(), turns: trimmed, spoken: [...spokenKeys].slice(-80) },
      null,
      2,
    ),
  );
  return trimmed;
}

function pushMemory(turns, role, text) {
  const line = String(text || '').trim();
  if (!line) return turns;
  const next = [...turns, { at: Date.now(), role, text: line.slice(0, 800) }];
  return saveMemory(next);
}

function markSpoken(item) {
  const key = storyKey(item);
  if (!key || key === 'unknown') return;
  spokenKeys.add(key);
  // Persist spoken keys WITHOUT loadMemory() — that reloads spoken from disk and
  // would wipe the key we just added (caused endless re-flash of the same story).
  ensureOutDir();
  let turns = [];
  try {
    if (existsSync(MEMORY_PATH)) {
      const raw = JSON.parse(readFileSync(MEMORY_PATH, 'utf8'));
      turns = Array.isArray(raw?.turns) ? raw.turns : [];
      for (const k of raw?.spoken || []) {
        if (k) spokenKeys.add(String(k));
      }
    }
  } catch {
    /* ignore */
  }
  spokenKeys.add(key);
  const cutoff = Date.now() - MEMORY_TTL_MS;
  const trimmed = turns.filter((t) => t && t.at >= cutoff).slice(-MEMORY_MAX_TURNS);
  writeFileSync(
    MEMORY_PATH,
    JSON.stringify(
      { updatedAt: Date.now(), turns: trimmed, spoken: [...spokenKeys].slice(-80) },
      null,
      2,
    ),
  );
}

function normalizeMuseKey(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .trim();
}

/** Hand aliases for names STT butchered. Keys are normalizeMuseKey forms. */
const MUSE_NAME_ALIASES = {
  wynjr: 'wynjr',
  wynjunior: 'wynjr',
  waynejunior: 'wynjr',
  waynejr: 'wynjr',
  winjr: 'wynjr',
  wingerjunior: 'wynjr',
  wynjrjr: 'wynjrjr',
  waynejuniorjunior: 'wynjrjr',
  lifesaver: 'lifesaver',
  lifesavers: 'lifesaver',
  dollarbill: 'dollarbill',
  dollar: 'dollarbill',
  packrip: 'packrip',
  musemayor: 'musemayor',
  mayor: 'musemayor',
  smalls: 'smalls',
  nimbus: 'nimbus',
  reggiedynomite: 'reggiedynomite',
  reggie: 'reggiedynomite',
  justshrimp: 'justshrimp',
  shrimp: 'justshrimp',
};

function canonicalizeMuseQuery(query) {
  const q = normalizeMuseKey(query);
  if (!q) return '';
  if (MUSE_NAME_ALIASES[q]) return normalizeMuseKey(MUSE_NAME_ALIASES[q]);
  return q;
}

function asksAboutWynjrStory(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (WYNJR_ASK_RE.test(t)) return true;
  if (/\bwayne\b/i.test(t) && /\b(junior|jr\.?|day|story|news|what|tell|about)\b/i.test(t)) return true;
  return false;
}

function editDistance(a, b) {
  const s = String(a || '');
  const t = String(b || '');
  if (s === t) return 0;
  if (!s.length) return t.length;
  if (!t.length) return s.length;
  const row = Array.from({ length: t.length + 1 }, (_, i) => i);
  for (let i = 1; i <= s.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= t.length; j++) {
      const cur = row[j];
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + cost);
      prev = cur;
    }
  }
  return row[t.length];
}

function consonantSkeleton(s) {
  return normalizeMuseKey(s).replace(/[aeiou]/g, '');
}

/** Expand a muse into match keys STT might produce. */
function museMatchKeys(muse) {
  const keys = new Set();
  const add = (raw) => {
    const k = normalizeMuseKey(raw);
    if (k.length >= 2) keys.add(k);
    const c = consonantSkeleton(k);
    if (c.length >= 3) keys.add(`c:${c}`);
  };
  add(muse?.name);
  for (const n of muse?.names || []) add(n);
  if (muse?.muse_id) add(String(muse.muse_id).replace(/^muse_/i, ''));
  // CamelCase / kebab → spoken words ("LifeSaver" → "life saver")
  const spaced = String(muse?.name || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[-_]+/g, ' ')
    .replace(/[^a-zA-Z0-9\s]/g, ' ');
  add(spaced);
  for (const part of spaced.split(/\s+/)) {
    if (part.length >= 3) add(part);
  }
  // alias reverse: if this muse is a known alias target, add the alias keys
  const canon = normalizeMuseKey(muse?.name);
  for (const [alias, target] of Object.entries(MUSE_NAME_ALIASES)) {
    if (normalizeMuseKey(target) === canon) add(alias);
  }
  return [...keys];
}

function scoreQueryAgainstMuse(query, muse) {
  const q = canonicalizeMuseQuery(query);
  if (!q || q.length < 2) return 0;
  const keys = museMatchKeys(muse);
  const name = normalizeMuseKey(muse?.name);
  if (!name) return 0;
  if (keys.includes(q) || name === q) return 100;
  if (name.startsWith(q) || q.startsWith(name)) return 86;
  if (keys.some((k) => k === q || k.endsWith(q) || q.endsWith(k))) return 82;
  if (name.includes(q) || q.includes(name)) return 74;
  const qc = consonantSkeleton(q);
  if (qc.length >= 3 && keys.includes(`c:${qc}`)) return 70;
  const dist = editDistance(q, name);
  const maxLen = Math.max(q.length, name.length);
  const sim = maxLen ? 1 - dist / maxLen : 0;
  if (sim >= 0.78 && maxLen >= 4) return Math.round(60 + sim * 20);
  if (sim >= 0.65 && maxLen >= 5 && dist <= 2) return 58;
  // token overlap for multi-word spoken queries
  const qTokens = String(query || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  const nTokens = String(muse?.name || '')
    .toLowerCase()
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
  if (qTokens.length && nTokens.length) {
    const hit = qTokens.filter((t) => nTokens.some((n) => n === t || n.startsWith(t) || t.startsWith(n) || editDistance(t, n) <= 1));
    if (hit.length && hit.length >= Math.min(qTokens.length, nTokens.length)) return 68;
    if (hit.length >= 1 && nTokens.length === 1) return 62;
  }
  return 0;
}

function lookupMuse(query) {
  const qRaw = String(query || '').trim();
  if (!qRaw) return null;
  const rows = Object.values(museLedger.muses || {});
  if (!rows.length) return null;

  let best = null;
  let bestScore = 0;
  for (const m of rows) {
    const s = scoreQueryAgainstMuse(qRaw, m);
    if (s > bestScore) {
      bestScore = s;
      best = m;
    }
  }
  // Accept solid fuzzy hits — STT is messy.
  if (best && bestScore >= 58) return best;
  return null;
}

/**
 * Pull muse mentions out of a transcript: known names, "about X", and fuzzy n-grams.
 */
function extractMentionedMuseQueries(text) {
  const t = String(text || '');
  if (!t.trim()) return [];
  const found = [];
  const push = (q) => {
    const muse = lookupMuse(q);
    if (muse?.name) found.push(muse.name);
    else if (q) found.push(String(q).trim());
  };

  if (asksAboutWynjrStory(t)) push('wynjr');

  const patterns = [
    /\b(?:what(?:'s| is| was)?|whats)\s+(.+?)\s+(?:doing|up to|been doing|working on)\b/i,
    /\b(?:how(?:'s| is| was)?)\s+(.+?)\s+(?:doing|been)\b/i,
    /\b(?:about|update on|status on|news on|day of|tell me about|who is|where's|where is)\s+(.+?)(?:[?.!]|$)/i,
    /\b@([a-z0-9_]{2,40})\b/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m?.[1]) push(m[1].trim().replace(/[?.!,;:]+$/g, ''));
  }

  // Exact-ish name scan (longest names first so "Dollar Bill" beats "Bill")
  const rankedNames = Object.values(museLedger.muses || {})
    .map((m) => String(m.name || '').trim())
    .filter((n) => n.length >= 3)
    .sort((a, b) => b.length - a.length);
  for (const name of rankedNames) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
    if (new RegExp(`\\b${escaped}\\b`, 'i').test(t)) push(name);
  }

  // Fuzzy n-grams (1–3 words) against the whole ledger
  const words = t
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const stop = new Set([
    'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'about', 'tell', 'me', 'what', 'whats',
    'who', 'where', 'when', 'why', 'how', 'is', 'was', 'are', 'were', 'been', 'doing', 'day', 'news', 'wire',
    'paper', 'town', 'please', 'just', 'like', 'this', 'that', 'from', 'have', 'has', 'had', 'you', 'your',
  ]);
  const candidates = [];
  for (let i = 0; i < words.length; i++) {
    for (let n = 3; n >= 1; n--) {
      if (i + n > words.length) continue;
      const slice = words.slice(i, i + n);
      if (slice.every((w) => stop.has(w))) continue;
      if (slice[0] && stop.has(slice[0]) && n === 1) continue;
      candidates.push(slice.join(' '));
    }
  }
  const scored = [];
  for (const c of candidates) {
    const muse = lookupMuse(c);
    if (!muse) continue;
    const s = scoreQueryAgainstMuse(c, muse);
    if (s >= 62) scored.push({ name: muse.name, s, c });
  }
  scored.sort((a, b) => b.s - a.s);
  for (const hit of scored.slice(0, 6)) push(hit.name);

  return [...new Set(found.map((x) => String(x).trim()).filter(Boolean))];
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

function saveMuseLedger() {
  ensureOutDir();
  writeFileSync(MUSE_LEDGER_PATH, `${JSON.stringify(museLedger, null, 2)}\n`);
}

function parsePostTime(createdAt) {
  const t = Date.parse(String(createdAt || '').replace(' ', 'T') + (String(createdAt || '').includes('Z') ? '' : 'Z'));
  if (Number.isFinite(t)) return t;
  const t2 = Date.parse(String(createdAt || ''));
  return Number.isFinite(t2) ? t2 : 0;
}

function isTodayMs(ms, now = Date.now()) {
  if (!ms) return false;
  const a = new Date(ms);
  const b = new Date(now);
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth() && a.getUTCDate() === b.getUTCDate();
}

function ingestPostsIntoLedger(posts) {
  if (!Array.isArray(posts) || !posts.length) return;
  if (!museLedger?.muses) museLedger = loadMuseLedger();
  const cutoff = Date.now() - MUSE_LEDGER_TTL_MS;

  for (const p of posts) {
    const name = String(p.name || '').trim();
    const museId = String(p.muse_id || '').trim();
    if (!name && !museId) continue;
    const id = museId || `name:${normalizeMuseKey(name)}`;
    if (!id || id === 'name:') continue;

    const at = parsePostTime(p.created_at) || Date.now();
    if (at && at < cutoff) continue;

    const entry = museLedger.muses[id] || {
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
      museLedger.muses[id] = entry;
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
    museLedger.muses[id] = entry;
  }

  museLedger.updatedAt = Date.now();
  saveMuseLedger();
}

function listMusesRanked(now = Date.now()) {
  const rows = Object.values(museLedger.muses || {});
  return rows
    .map((m) => {
      const today = (m.posts || []).filter((p) => isTodayMs(p.at, now));
      return {
        ...m,
        todayCount: today.length,
        latest: (m.posts || [])[0] || null,
        todayPosts: today.slice(0, 6),
      };
    })
    .sort((a, b) => b.todayCount - a.todayCount || (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
}

function formatMuseDossier(muse, { todayOnly = true } = {}) {
  if (!muse) return '(unknown muse)';
  const now = Date.now();
  const posts = todayOnly
    ? (muse.posts || []).filter((p) => isTodayMs(p.at, now)).slice(0, 8)
    : (muse.posts || []).slice(0, 8);
  const lines = posts.map((p) => {
    const when = p.at ? `${Math.max(0, Math.round((now - p.at) / 60000))}m ago` : '?';
    return `  · #${p.channel} (${when}): "${p.text}"`;
  });
  const todayN = (muse.posts || []).filter((p) => isTodayMs(p.at, now)).length;
  return [
    `${muse.name}${muse.founder ? ' ★founding' : ''} · today=${todayN} posts · id=${muse.muse_id || '—'}`,
    muse.bio ? `  bio: ${muse.bio}` : '',
    lines.length ? lines.join('\n') : '  · no posts captured yet today',
  ]
    .filter(Boolean)
    .join('\n');
}

function formatMuseDeskBrief() {
  const ranked = listMusesRanked();
  const activeToday = ranked.filter((m) => m.todayCount > 0).slice(0, 14);
  const pool = activeToday.length ? activeToday : ranked.slice(0, 10);
  if (!pool.length) return '(muse ledger empty — still scanning boards)';
  const lines = pool.map((m) => {
    const clip = String(m.latest?.text || '')
      .replace(/\s+/g, ' ')
      .slice(0, 140);
    const ch = m.latest?.channel || '?';
    return `- ${m.name}${m.founder ? ' ★' : ''} · today ${m.todayCount} · last #${ch}: "${clip}"`;
  });
  return `Known muses tracked: ${Object.keys(museLedger.muses || {}).length}. Active today:\n${lines.join('\n')}`;
}

function formatFocusedMuseBlock(heardText) {
  const queries = extractMentionedMuseQueries(heardText);
  if (!queries.length) return '';
  const dossiers = [];
  const resolved = [];
  for (const q of queries.slice(0, 4)) {
    const muse = lookupMuse(q);
    if (muse) {
      resolved.push(`${q} → ${muse.name}`);
      dossiers.push(formatMuseDossier(muse, { todayOnly: false }));
    } else {
      dossiers.push(`- ${q}: not in ledger yet (still scanning)`);
    }
  }
  const head = resolved.length ? `STT NAME RESOLVE: ${resolved.join('; ')}\n` : '';
  return `${head}FOCUSED MUSE LOOKUP (answer from this, do not invent):\n${dossiers.join('\n\n')}`;
}

/** One clean spoken beat for a muse from the ledger. */
function museTownBulletin(muse) {
  if (!muse) return '';
  if (/^wynjr$/i.test(String(muse.name || ''))) return WYNJR_SUCCESSION_BULLETIN;
  const posts = (muse.posts || []).filter((p) => p?.text && !isHostileToTown(p.text));
  const today = posts.filter((p) => isTodayMs(p.at));
  const pick = (today[0] || posts[0])?.text || '';
  if (!pick) return `Town wire: ${muse.name} is on the boards, but no clean beat is filed yet.`;
  const clip = String(pick).replace(/\s+/g, ' ').slice(0, 180);
  return `Town wire on ${muse.name}: ${clip}`;
}

function asksAboutNamedMuse(text) {
  const t = String(text || '');
  if (!t.trim()) return false;
  if (asksAboutWynjrStory(t)) return true;
  if (/\b(tell me about|what about|what's|whats|who is|who's|where's|where is|day of|news on|update on|status on|about)\b/i.test(t)) {
    return extractMentionedMuseQueries(t).some((q) => Boolean(lookupMuse(q)));
  }
  return extractMentionedMuseQueries(t).some((q) => Boolean(lookupMuse(q)));
}

async function fetchAllBoardSlugs() {
  try {
    const data = await fetchJson(`${MUSEBOOK_BASE}/api/channels.json`);
    const fromApi = (Array.isArray(data.channels) ? data.channels : [])
      .map((c) => c.slug || c.name?.replace(/^#/, ''))
      .filter(Boolean);
    return [...new Set([...ALL_BOARDS, ...fromApi])];
  } catch {
    return ALL_BOARDS;
  }
}

function formatMemoryBlock(turns) {
  if (!turns.length) return '(no prior turns yet this Space)';
  return turns
    .slice(-MEMORY_MAX_TURNS)
    .map((t) => {
      const who = t.role === 'assistant' ? 'reporter' : t.role === 'wire' ? 'wire' : 'listener';
      const mins = Math.max(0, Math.round((Date.now() - t.at) / 60000));
      const when = mins <= 0 ? 'just now' : `${mins}m ago`;
      return `- [${when}] ${who}: ${t.text}`;
    })
    .join('\n');
}

function historyMessagesFromMemory(turns) {
  return turns
    .filter((t) => t.role === 'assistant' || t.role === 'user')
    .slice(-12)
    .map((t) => ({
      role: t.role === 'assistant' ? 'assistant' : 'user',
      content: t.text,
    }));
}

function hasBin(name) {
  try {
    execFileSync('which', [name], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function switchOutput(device) {
  if (process.platform !== 'darwin' || !hasBin('SwitchAudioSource')) return false;
  try {
    execFileSync('SwitchAudioSource', ['-s', device, '-t', 'output'], { stdio: 'ignore' });
    return true;
  } catch {
    console.warn(`[voice] could not switch output to "${device}"`);
    return false;
  }
}

function currentOutput() {
  if (process.platform !== 'darwin' || !hasBin('SwitchAudioSource')) return '';
  try {
    return execFileSync('SwitchAudioSource', ['-c', '-t', 'output'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function switchInput(device) {
  if (process.platform !== 'darwin' || !hasBin('SwitchAudioSource')) return false;
  try {
    execFileSync('SwitchAudioSource', ['-s', device, '-t', 'input'], { stdio: 'ignore' });
    return true;
  } catch {
    console.warn(`[voice] could not switch input to "${device}"`);
    return false;
  }
}

function currentInput() {
  if (process.platform !== 'darwin' || !hasBin('SwitchAudioSource')) return '';
  try {
    return execFileSync('SwitchAudioSource', ['-c', '-t', 'input'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function pcm16ToWav(pcm, sampleRate = 24_000, channels = 1) {
  const bitsPerSample = 16;
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const dataSize = pcm.length;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  pcm.copy(buffer, 44);
  return buffer;
}

function pcmRms(pcm) {
  if (!pcm.length) return 0;
  const samples = Math.floor(pcm.length / 2);
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = pcm.readInt16LE(i * 2);
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}

function boostPcm16(pcm, gain = INPUT_GAIN) {
  if (!pcm.length || gain === 1) return pcm;
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i += 2) {
    let s = Math.round(pcm.readInt16LE(i) * gain);
    if (s > 32767) s = 32767;
    if (s < -32768) s = -32768;
    out.writeInt16LE(s, i);
  }
  return out;
}

function playCommand(filePath) {
  if (process.platform === 'win32') {
    const quoted = `'${String(filePath).replace(/'/g, "''")}'`;
    return {
      cmd: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-Command', `(New-Object System.Media.SoundPlayer ${quoted}).PlaySync()`],
    };
  }
  return { cmd: 'afplay', args: ['-v', '1', filePath] };
}

async function playAudio(filePath) {
  if (NO_PLAY || !SHOULD_PLAY) return;
  const { cmd, args } = playCommand(filePath);
  if (process.platform === 'darwin') {
    switchOutput(SPEAK_DEVICE);
    console.log(`[voice] speak → ${currentOutput() || SPEAK_DEVICE}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  try {
    await new Promise((resolvePromise, reject) => {
      const child = spawn(cmd, args, { stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`${cmd} exit ${code}`))));
    });
  } finally {
    if (process.platform === 'darwin') {
      switchOutput(IDLE_DEVICE);
      switchInput(IDLE_MIC);
    }
  }
}

function startPcmStreamPlayer(sampleRate = 24_000) {
  if (NO_PLAY || !SHOULD_PLAY || !STREAM_PLAY || !hasBin('ffplay')) return null;
  const child = spawn(
    'ffplay',
    ['-nodisp', '-autoexit', '-loglevel', 'quiet', '-f', 's16le', '-ar', String(sampleRate), '-ac', '1', '-i', 'pipe:0'],
    { stdio: ['pipe', 'ignore', 'ignore'] },
  );
  let closed = false;
  const done = new Promise((resolveDone) => {
    child.on('close', () => {
      closed = true;
      resolveDone();
    });
    child.on('error', () => {
      closed = true;
      resolveDone();
    });
  });
  return {
    write(pcmChunk) {
      if (closed || !pcmChunk?.length) return;
      try {
        child.stdin.write(pcmChunk);
      } catch {
        /* ignore */
      }
    },
    async end() {
      try {
        child.stdin.end();
      } catch {
        /* ignore */
      }
      await done;
    },
  };
}

async function streamChatCompletion(body, { livePlay = false } = {}) {
  if (!OPENROUTER_KEY) throw new Error('Missing OPENROUTER_API_KEY in .env.local / .env');

  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://musenews.lol',
      'X-Title': 'musenews reporter',
    },
    body: JSON.stringify({
      ...body,
      model: MODEL,
      modalities: ['text', 'audio'],
      audio: { voice: VOICE, format: 'pcm16' },
      stream: true,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`OpenRouter ${res.status}: ${errText.slice(0, 500)}`);
  }

  const player = livePlay ? startPcmStreamPlayer(24_000) : null;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const audioChunks = [];
  const transcriptChunks = [];
  let buffer = '';
  let started = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (!data || data === '[DONE]') continue;
        let chunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        const audio = chunk.choices?.[0]?.delta?.audio;
        if (audio?.data) {
          audioChunks.push(audio.data);
          if (player) {
            const pcm = Buffer.from(audio.data, 'base64');
            if (!started) {
              started = true;
              console.log('♪ (streaming…)');
            }
            player.write(pcm);
          }
        }
        if (audio?.transcript) transcriptChunks.push(audio.transcript);
        const text = chunk.choices?.[0]?.delta?.content;
        if (typeof text === 'string' && text) transcriptChunks.push(text);
      }
    }
  } finally {
    if (player) await player.end();
  }

  const transcript = transcriptChunks.join('').trim();
  const b64 = audioChunks.join('');
  if (!b64) throw new Error(`No audio returned. Transcript: ${transcript || '(empty)'}`);
  return { transcript, wav: pcm16ToWav(Buffer.from(b64, 'base64')), streamed: Boolean(player && started) };
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: FETCH_HEADERS });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

function foreignTickerCount(text) {
  const matches = String(text || '').match(FOREIGN_TICKER_RE) || [];
  return matches.filter((m) => !TOWN_TICKER_RE.test(m)).length;
}

/** Never air smears of MuseBook or wynjr — including quoting an attacker. */
function isHostileToTown(text) {
  const t = String(text || '');
  if (!t) return false;
  const namesTown = /\b(musebook|wynjr)\b/i.test(t);
  if (!namesTown) return false;
  // Attacker / FUD lines that drag MuseBook or wynjr
  if (/\b(scam|fraud|rug|rugged|ponzi|pump\s*(and|&)\s*dump|dump|shady|sketchy|trash|dead|dying|fail(?:ed|ure)?|corrupt|steal|stolen|stole|honeypot|exit\s*scam)\b/i.test(t)) {
    return true;
  }
  // "musebook coin is a scam" / "wynjr will pump"
  if (/\bmusebook\b.{0,40}\b(scam|fraud|rug|dump)\b/i.test(t)) return true;
  if (/\bwynjr\b.{0,40}\b(scam|fraud|rug|dump|pump)\b/i.test(t)) return true;
  if (/\b(scam|fraud|rug|dump|pump)\b.{0,40}\b(musebook|wynjr)\b/i.test(t)) return true;
  return false;
}

function isSafeTownItem(item) {
  const blob = `${item?.title || ''} ${item?.dek || ''} ${item?.text || ''} ${item?.body || ''}`;
  return !isHostileToTown(blob);
}

function isForeignTokenPitch(p) {
  const t = String(p.text || p.title || '');
  if (BANNED_TOKEN_RE.test(t) && !/\b(phishing|scam|lookalike)\b/i.test(t)) return true;
  if (TOWN_TICKER_RE.test(t) && /\b(musebook|treasury|acquisition|fee|burn|receipt|governance)\b/i.test(t)) {
    return false;
  }
  if (/\b(phishing|scam|lookalike|drain|fake\s+account|board\s+of\s+shame)\b/i.test(t)) return false;
  const foreign = foreignTickerCount(t);
  if (foreign >= 1 && /\b(launch|launched|new token|new ticker|ca\b|buy|chart|liquidity|dex|uniswap|degen)\b/i.test(t)) {
    return true;
  }
  if (['memecoins', 'shill'].includes(p.channel) && foreign >= 1 && !NEWS_RE.test(t)) return true;
  return false;
}

function newsScore(p) {
  const t = String(p.text || p.title || '');
  let s = 0;
  if (isHostileToTown(t)) return -50;
  if (isForeignTokenPitch(p)) return -20;
  if (FAITH_SPAM_RE.test(t)) return -20;
  if (NEWS_RE.test(t)) s += 5;
  if (/\b(phishing|scam|lookalike|drain|fake)\b/i.test(t)) s += 4;
  if (/\b(treasury|acquisition|governance|burn|receipt|seal|cold-?walk)\b/i.test(t)) s += 4;
  if (/\b(wynjrjr|abduct|father was taken|son rises|successor|disavow|hacked)\b/i.test(t)) s += 8;
  if (/\bwynjr\b/i.test(t) && /\b(taken|hack|son|successor|wynjrjr)\b/i.test(t)) s += 6;
  if (TOWN_TICKER_RE.test(t)) s += 2;
  if (!p.parent_post_id) s += 2;
  if ((p.reply_count || 0) >= 3) s += 2;
  if ((p.reply_count || 0) >= 8) s += 2;
  if (t.length > 160) s += 1;
  if (t.length < 40) s -= 3;
  if (SKIP_RE.test(t)) s -= 5;
  if (foreignTickerCount(t) >= 2) s -= 4;
  if (['townhall', 'lobby', 'townsquare', 'museriously', 'declaration', 'boardofshame'].includes(p.channel)) s += 1;
  if (['memecoins', 'shill'].includes(p.channel)) s -= 2;
  return s;
}

async function fetchChannel(channel, limit = 18) {
  const data = await fetchJson(`${MUSEBOOK_BASE}/api/latest.json?channel=${encodeURIComponent(channel)}&limit=${limit}`);
  const posts = Array.isArray(data.posts) ? data.posts : [];
  return posts.map((p) => ({ ...p, channel }));
}

function mapFeedArticle(a) {
  const slugFromUrl = String(a.url || '').match(/\/news\/([^/?#]+)/)?.[1] || '';
  const slug = a.slug || slugFromUrl;
  return {
    kind: 'paper',
    key: slug ? `art:${slug}` : storyKey(a),
    slug,
    title: a.title,
    dek: a.dek,
    section: a.section,
    byline: a.byline,
    body: a.body,
    url: a.url,
    published_at: a.published_at,
    importance: a.importance ?? null,
  };
}

/** Pull the edition straight from Supabase so voice has the full DB, not a thin feed slice. */
async function fetchPaperFromSupabase(limit = PAPER_LIMIT) {
  const base = (process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || '').replace(/\/$/, '');
  const key = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  if (!base || !key) return [];
  const pageSize = 100;
  const out = [];
  for (let offset = 0; offset < limit; offset += pageSize) {
    const take = Math.min(pageSize, limit - offset);
    const params = new URLSearchParams({
      select: 'slug,title,dek,body,section,byline,published_at,importance,cover_url',
      status: 'eq.published',
      order: 'published_at.desc',
      offset: String(offset),
      limit: String(take),
    });
    const res = await fetch(`${base}/rest/v1/musenews_articles?${params}`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Accept: 'application/json',
        Prefer: 'count=exact',
      },
    });
    if (!res.ok) {
      console.warn(`supabase paper ${res.status}`);
      break;
    }
    const rows = await res.json();
    if (!Array.isArray(rows) || !rows.length) break;
    const site = SITE;
    for (const a of rows) {
      out.push(
        mapFeedArticle({
          ...a,
          url: `${site}/news/${a.slug}`,
        }),
      );
    }
    if (rows.length < take) break;
  }
  return out;
}

async function fetchPaperFromFeed(limit = PAPER_LIMIT) {
  const pageSize = 100;
  const out = [];
  let page = 1;
  while (out.length < limit) {
    const take = Math.min(pageSize, limit - out.length);
    const join = NEWS_FEED.includes('?') ? '&' : '?';
    const url = `${NEWS_FEED}${join}limit=${take}&page=${page}`;
    const data = await fetchJson(url);
    const articles = Array.isArray(data.articles) ? data.articles : [];
    if (!articles.length) break;
    out.push(...articles.map(mapFeedArticle));
    const total = Number(data.total || 0);
    if (out.length >= total || articles.length < take) break;
    page += 1;
    if (page > 20) break;
  }
  return out;
}

async function fetchPaper() {
  try {
    const fromDb = await fetchPaperFromSupabase(PAPER_LIMIT);
    if (fromDb.length) {
      console.log(`paper: ${fromDb.length} stories from Supabase (limit ${PAPER_LIMIT})`);
      return fromDb;
    }
  } catch (err) {
    console.warn(`supabase paper failed: ${err.message || err}`);
  }
  try {
    const fromFeed = await fetchPaperFromFeed(PAPER_LIMIT);
    console.log(`paper: ${fromFeed.length} stories from feed (limit ${PAPER_LIMIT})`);
    return fromFeed;
  } catch (err) {
    console.warn(`paper feed failed: ${err.message || err}`);
    return [];
  }
}

async function refreshWire(force = false) {
  if (!force && wireCache.fetchedAt && Date.now() - wireCache.fetchedAt < WIRE_TTL_MS) {
    return wireCache;
  }

  if (!museLedger?.muses || !Object.keys(museLedger.muses).length) {
    museLedger = loadMuseLedger();
  }

  const paper = await fetchPaper();
  // Rotate deeper through ALL boards so the muse ledger stays current
  const sideTake = 4;
  const side = SIDE_BOARDS.slice(wireCache.sideCursor, wireCache.sideCursor + sideTake);
  wireCache.sideCursor = (wireCache.sideCursor + sideTake) % Math.max(1, SIDE_BOARDS.length);
  let boards = [...HOT_BOARDS, ...side];
  try {
    const all = await fetchAllBoardSlugs();
    // Occasionally pull a few extra boards not in the hot/side lists
    const extras = all.filter((b) => !boards.includes(b)).slice(0, 3);
    boards = [...new Set([...boards, ...extras])];
  } catch {
    /* ignore */
  }

  const batches = await Promise.all(
    boards.map((ch) =>
      fetchChannel(ch, 24).catch((err) => {
        console.warn(`board #${ch} failed: ${err.message || err}`);
        return [];
      }),
    ),
  );

  const rawPosts = batches.flat();
  ingestPostsIntoLedger(rawPosts);
  const museN = Object.keys(museLedger.muses || {}).length;

  const hits = rawPosts
    .map((p) => ({
      kind: 'board',
      key: `post:${p.id}`,
      id: p.id,
      name: p.name,
      channel: p.channel,
      text: p.text,
      reply_count: p.reply_count || 0,
      parent_post_id: p.parent_post_id,
      created_at: p.created_at,
      score: newsScore(p),
    }))
    .filter((p) => p.score >= 5 && p.text)
    .sort((a, b) => b.score - a.score || String(b.created_at).localeCompare(String(a.created_at)));

  // Pull priority succession / hack beats from the muse ledger even if this rotate missed the board.
  for (const muse of Object.values(museLedger.muses || {})) {
    for (const p of muse.posts || []) {
      const t = String(p.text || '');
      if (!/\b(wynjrjr|father was taken|son rises|successor|disavow|abduct|hacked)\b/i.test(t)) continue;
      if (!isTodayMs(p.at) && Date.now() - (p.at || 0) > 36 * 60 * 60 * 1000) continue;
      hits.push({
        kind: 'board',
        key: p.id ? `post:${p.id}` : storyKey({ text: t }),
        id: p.id,
        name: muse.name,
        channel: p.channel || 'ledger',
        text: t,
        reply_count: 0,
        parent_post_id: null,
        created_at: p.at ? new Date(p.at).toISOString() : new Date().toISOString(),
        score: newsScore({ text: t, channel: p.channel, name: muse.name }) + 2,
      });
    }
  }
  hits.sort((a, b) => b.score - a.score || String(b.created_at).localeCompare(String(a.created_at)));

  // Dedupe similar board copy
  const seen = new Set();
  const unique = [];
  for (const h of hits) {
    if (!isSafeTownItem(h)) continue;
    const blob = String(h.text)
      .toLowerCase()
      .replace(/https?:\S+/g, '')
      .slice(0, 90);
    if (seen.has(blob)) continue;
    seen.add(blob);
    unique.push(h);
  }

  const safePaper = paper.filter(isSafeTownItem);
  if (safePaper.length < paper.length) {
    console.log(`[voice] dropped ${paper.length - safePaper.length} hostile paper rows`);
  }

  wireCache = {
    fetchedAt: Date.now(),
    paper: safePaper,
    hits: unique.slice(0, 18),
    sideCursor: wireCache.sideCursor,
    rawPosts,
  };
  const fresh = [...safePaper, ...unique].filter((x) => !spokenKeys.has(storyKey(x))).length;
  console.log(`wire: ${paper.length} paper · ${unique.length} board hits · ${fresh} unread · ${museN} muses tracked`);
  return wireCache;
}

function nextUnread(wire = wireCache) {
  const ok = (x) => x && !spokenKeys.has(storyKey(x)) && isSafeTownItem(x);
  const priority = (wire.hits || []).filter(
    (h) =>
      ok(h) &&
      /\b(wynjrjr|father was taken|son rises|successor|disavow|abduct)\b/i.test(String(h.text || '')) &&
      !/\b(scam|pump|dump|fraud)\b/i.test(String(h.text || '')),
  );
  if (priority[0]) return priority[0];
  for (const a of wire.paper || []) {
    if (ok(a)) return a;
  }
  for (const h of wire.hits || []) {
    if (ok(h)) return h;
  }
  return null;
}

function formatTopTownBeats() {
  const rows = [];
  const muses = museLedger?.muses || {};
  for (const muse of Object.values(muses)) {
    for (const p of muse.posts || []) {
      const t = String(p.text || '');
      if (!/\b(wynjrjr|abduct|father was taken|son rises|successor|disavow|lookalike|phishing)\b/i.test(t)) {
        continue;
      }
      if (isHostileToTown(t)) continue;
      if (!isTodayMs(p.at) && Date.now() - (p.at || 0) > 36 * 60 * 60 * 1000) continue;
      rows.push({
        name: muse.name,
        at: p.at || 0,
        channel: p.channel || '',
        text: t.replace(/\s+/g, ' ').slice(0, 260),
        score: newsScore({ text: t, channel: p.channel, name: muse.name }),
      });
    }
  }
  rows.sort((a, b) => b.score - a.score || b.at - a.at);
  const top = rows.slice(0, 8);
  if (!top.length) return '(no priority town beats in ledger yet)';
  return top
    .map((r) => `- @${r.name}${r.channel ? ` #${r.channel}` : ''}: "${r.text}"`)
    .join('\n');
}

function formatWireBlock(wire) {
  const paper = wire.paper || [];
  // Full catalog of headlines so the desk can answer "what's in the paper" from the DB.
  const indexLines = paper.slice(0, PAPER_LIMIT).map((a, i) => {
    const tag = spokenKeys.has(storyKey(a)) ? 'FILED' : 'NEW';
    return `${i + 1}. [${tag}] ${a.section || 'news'} — ${a.title}`;
  });
  // Richer detail for the freshest leads.
  const detailLines = paper.slice(0, 24).map((a) => {
    const tag = spokenKeys.has(storyKey(a)) ? 'ALREADY FILED' : 'NEW';
    const body = String(a.body || '')
      .replace(/\s+/g, ' ')
      .slice(0, 280);
    return `- [${tag}] PAPER ${a.section || 'news'} "${a.title}" — ${a.dek || body}`;
  });
  const hitLines = (wire.hits || []).slice(0, 14).map((h) => {
    const tag = spokenKeys.has(storyKey(h)) ? 'ALREADY FILED' : 'NEW';
    return `- [${tag}] #${h.channel} @${h.name} score=${h.score} "${String(h.text).replace(/\s+/g, ' ').slice(0, 220)}"`;
  });
  const filed = [...spokenKeys].slice(-12).join(' | ') || '(none yet)';
  return `ALREADY FILED THIS SPACE (do not re-read): ${filed}

PRIORITY TOWN BEATS (from muse ledger — lead with these when relevant)
${formatTopTownBeats()}

PAPER DETAIL (freshest)
${detailLines.join('\n') || '(no edition yet)'}

FULL PAPER INDEX (${paper.length} stories loaded from the DB — you have these)
${indexLines.join('\n') || '(empty)'}

BOARD WIRE
${hitLines.join('\n') || '(quiet)'}`;
}

function buildSystemPrompt(wire, { heardText = '' } = {}) {
  const focused = formatFocusedMuseBlock(heardText);
  return `${SYSTEM_BASE}

OUR TOKEN (live — say when asked for CA / contract / buy link)
$MuseNews CA: ${MUSENEWS_TOKEN_CA}
Buy: ${MUSENEWS_TOKEN_BUY}

CANONICAL TOWN FACT (always true — do not say the wire is quiet on this)
${WYNJR_SUCCESSION_BULLETIN}
Aliases: wynjr = Wayne Junior. wynjrjr = the successor.

MUSE ACTIVITY LEDGER (ground truth — answer "what was X doing" from this; do not invent)
${formatMuseDeskBrief()}
${focused ? `\n${focused}\n` : ''}
LIVE WIRE (refreshing — treat as facts, do not invent extras)
${formatWireBlock(wire || wireCache)}`;
}

function looksLikeQuestion(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/\?/.test(t)) return true;
  return /^(who|what|when|where|why|how|which|whose|can|could|would|will|do|does|did|is|are|am|was|were|should|have|has|had|tell me|explain)\b/i.test(
    t,
  );
}

function wantsNewsFlash(text) {
  const t = String(text || '').toLowerCase();
  // Only when they explicitly ask for news — casual talk should get a normal reply.
  return (
    /\b(what'?s?\s+the\s+news|any\s+news|on\s+the\s+wire|latest\s+(news|update)|update\s+us|what\s+dropped|read\s+the\s+(paper|wire)|give\s+me\s+(the\s+)?news)\b/.test(
      t,
    ) || /^(news|wire|flash)\b/.test(t.trim())
  );
}

function normalizeForEcho(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSelfEcho(heardText) {
  const a = normalizeForEcho(heardText);
  const b = normalizeForEcho(lastAssistantText);
  if (!a || !b || a.length < 12) return false;
  if (a === b) return true;
  if (a.includes(b.slice(0, Math.min(48, b.length))) || b.includes(a.slice(0, Math.min(48, a.length)))) return true;
  return false;
}

function shouldIgnoreUtterance(text) {
  const raw = String(text || '').trim();
  if (!raw) return true;
  if (looksLikeQuestion(raw)) return false;
  if (isSelfEcho(raw)) return true;

  const t = raw
    .toLowerCase()
    .replace(/[🎵🎧🎶🎝]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const words = t
    .replace(/[^a-z\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);

  // Keyboard / UI click hallucinations from Whisper
  if (t.length < 6) return true;
  // Bye / hi / ok loops — never send to the model (it invents spoken placeholders)
  const fillerWord = /^(bye|byebye|goodbye|goodnight|hi|hey|hello|sup|yo|okay|ok|yeah|yes|yep|no|nah|oh|ah|thanks|thank|you|welcome)$/;
  if (words.length > 0 && words.length <= 12 && words.every((w) => fillerWord.test(w))) return true;
  if (/^(click|typing|keyboard|tap|beep|notification)\b/.test(t)) return true;
  if (/^(hmm+|huh+|uh+|um+|ah+|oh+|mhm+|mm+)\.?$/.test(t)) return true;

  const letters = t.replace(/[^a-z]/g, '');
  if (letters.length < 5 && /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(raw)) return true;

  if (/\b(outro|intro)\b.*\bmusic\b/.test(t) || /^(outro|intro)(\s+music)?\.?$/.test(t)) return true;
  if (/\b(music|instrumental|applause|laughter)\b/.test(t) && words.length <= 5) return true;
  if (/뉴스|mbc|kbs|cnn|bbc news/i.test(raw)) return true;
  return false;
}

function bulletinLine(item) {
  if (!item) return 'wire is quiet — no fresh unmarked beat.';
  if (!isSafeTownItem(item)) return 'wire is quiet — skipping a hostile beat.';
  if (item.kind === 'paper') {
    const dek = item.dek || String(item.body || '').split('\n')[0] || '';
    const line = `from the paper: ${item.title}. ${dek}`.trim();
    return isHostileToTown(line) ? `from the paper: ${item.title}` : line;
  }
  const clip = String(item.text || '')
    .replace(/\s+/g, ' ')
    .slice(0, 220);
  const line = `breaking from #${item.channel}, ${item.name}: ${clip}`;
  if (isHostileToTown(line)) {
    return `breaking from #${item.channel}: town continuity update on the boards — details on the wire.`;
  }
  return line;
}

async function transcribeWav(wavBuf) {
  if (!OPENROUTER_KEY) throw new Error('Missing OPENROUTER_API_KEY');
  const res = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${OPENROUTER_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://musenews.lol',
      'X-Title': 'musenews reporter',
    },
    body: JSON.stringify({
      model: STT_MODEL,
      input_audio: { data: wavBuf.toString('base64'), format: 'wav' },
    }),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`STT ${res.status}: ${errText.slice(0, 300)}`);
  }
  const json = await res.json();
  return String(json?.text || '').trim();
}

function isNoReplyTranscript(text) {
  const t = String(text || '')
    .trim()
    .replace(/['"`]/g, '');
  if (!t) return true;
  const compact = t
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!compact) return true;
  if (/^no\s*reply$/.test(compact)) return true;
  if (/^(pass|skip|n\/a|none|hold|quiet)$/.test(compact)) return true;
  // Hard kill — never play this word on the Space, any casing / punctuation
  if (/\bsilence\b/.test(compact)) return true;
  if (compact.split(' ').length <= 4 && /^(i\s+)?(have\s+)?nothing(\s+to\s+say)?$/.test(compact)) return true;
  return false;
}

async function speakFromMessages(messages, label = 'line', { heardText = '' } = {}) {
  ensureOutDir();
  await refreshWire(false);
  console.log(`→ ${MODEL} / ${VOICE} …`);
  const { transcript, wav } = await streamChatCompletion(
    {
      messages: [{ role: 'system', content: buildSystemPrompt(wireCache, { heardText }) }, ...messages],
    },
    { livePlay: false }, // never stream-play; gate transcript before afplay
  );
  const outPath = join(OUT_DIR, `${stamp()}-${label}.wav`);
  writeFileSync(outPath, wav);
  const said = String(transcript || '').trim();
  console.log(`♪ ${said || '(audio only)'}`);
  console.log(`  saved ${outPath}`);
  if (isNoReplyTranscript(said)) {
    console.log('(hold — no air)');
    return { transcript: '', outPath, skipped: true };
  }
  if (isHostileToTown(said)) {
    console.log('[voice] suppressed hostile output — no air');
    return { transcript: '', outPath, skipped: true };
  }
  lastSpeechAt = Date.now();
  lastAssistantText = said;
  await playAudio(outPath);
  return { transcript: said, outPath, skipped: false };
}

async function say(text, { exact = false } = {}) {
  const line = String(text || '').trim();
  if (!line) throw new Error('Empty --say text');
  const content = exact
    ? `Read this EXACTLY out loud as MuseNews. Natural human reporter. Brisk pace — not slow, not robotic. Do not paraphrase. Speak only these words:\n\n${line}`
    : `Say this out loud as MuseNews. Natural human reporter, brisk pace, not robotic, not slow. Stay faithful to the facts. ONE to TWO short clear sentences. No feelings, no questions. NEVER say anything bad about MuseBook or wynjr — not even as a quote of an attacker. If the source contains a smear, skip it and file a clean town fact instead:\n\n${line}`;
  const result = await speakFromMessages([{ role: 'user', content }], exact ? 'open' : 'say');
  if (!exact && isHostileToTown(result.transcript || '')) {
    console.log('[voice] suppressed hostile say() output');
    return { transcript: '', outPath: result.outPath };
  }
  return result;
}

async function flashUnread({ force = false, reason = 'flash' } = {}) {
  await refreshWire(force);
  let item = nextUnread();
  let guard = 0;
  while (item && !isSafeTownItem(item) && guard < 12) {
    markSpoken(item);
    console.log(`[voice] skip hostile beat: ${storyKey(item)}`);
    item = nextUnread();
    guard += 1;
  }
  if (!item || !isSafeTownItem(item)) {
    const { transcript } = await say('wire is quiet. no unmarked beat right now.');
    return { transcript, item: null };
  }
  markSpoken(item);
  lastFlashAt = Date.now();
  const line = bulletinLine(item);
  if (isHostileToTown(line)) {
    console.log(`[voice] blocked hostile bulletin: ${storyKey(item)}`);
    const { transcript } = await say('wire moved — filing a clean town beat next.');
    return { transcript, item: null };
  }
  console.log(`flash [${reason}] ${storyKey(item)}`);
  const { transcript } = await say(line);
  if (isHostileToTown(transcript || '')) {
    console.log('[voice] model voiced a hostile line — suppressing');
    return { transcript: '', item };
  }
  return { transcript, item };
}

async function replyToAudioBuffer(wavBuf, { heardText = '', memory = [] } = {}) {
  const memoryBlock = formatMemoryBlock(memory);
  const unread = nextUnread();
  const isQuestion = looksLikeQuestion(heardText);
  const aboutTown =
    !heardText ||
    wantsNewsFlash(heardText) ||
    /\b(wynjr|wynjrjr|wayne|muse|town|news|wire|paper|hack|abduct|successor|lobb|hall|musebook|receipt|seal)\b/i.test(
      heardText,
    );
  const rules = `Hard rules:
- You are MuseNews. ONLY town news from the WIRE / LEDGER.
- If they asked about town news or a muse/story: answer with one concrete fact. 1–2 sentences. No feelings.
- If this is banter, feelings, music, greetings, bye, or random chat: output NO_REPLY only — no spoken words.
- Do NOT ask questions. No question marks.
- Do not re-read ALREADY FILED items.
- Priority: if they ask about wynjr / Wayne Junior / wynjrjr / taking over / abduction: say the CANONICAL TOWN FACT. Never claim the wire is quiet on wynjr.
- If they ask for the MuseNews token / CA / contract: Official CA is ${MUSENEWS_TOKEN_CA}. Say it clearly.
- ${aboutTown || isQuestion ? 'They may be asking about the town — answer from the wire / canonical fact if you can.' : 'This does not sound like news. Output NO_REPLY. Do not speak.'}
- ALWAYS English unless they clearly asked another language.`;

  const hint = asksAboutWynjrStory(heardText)
    ? `They asked about wynjr / Wayne Junior. Speak the CANONICAL TOWN FACT now. Do not say the wire is quiet.`
    : wantsNewsFlash(heardText)
    ? unread
      ? `They asked for news. File THIS unread beat: ${bulletinLine(unread)}`
      : 'They asked for news but nothing unread — say the wire is quiet, or file a PRIORITY TOWN BEAT if one is still NEW.'
    : aboutTown
      ? 'Answer only if this is about town news / a named muse. Otherwise output NO_REPLY with no spoken words.'
      : 'Banter or off-topic — output NO_REPLY only. Do not speak.';

  if (FAST_TEXT && heardText) {
    const messages = [
      ...historyMessagesFromMemory(memory).slice(-6),
      {
        role: 'user',
        content: `Live X Space. Someone said: "${heardText}"

${rules}

${hint}

Recent memory:
${memoryBlock}

Reply out loud as the MuseNews floor reporter — answer the person.`,
      },
    ];
    const result = await speakFromMessages(messages, 'live', { heardText });
    if (unread && wantsNewsFlash(heardText)) markSpoken(unread);
    return result;
  }

  const b64 = wavBuf.toString('base64');
  const messages = [
    ...historyMessagesFromMemory(memory).slice(-6),
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Someone spoke on the X Space. Answer them.

Recent memory:
${memoryBlock}

Transcript hint: ${heardText || '(none — listen to audio)'}

${hint}

${rules}`,
        },
        { type: 'input_audio', input_audio: { data: b64, format: 'wav' } },
      ],
    },
  ];
  const result = await speakFromMessages(messages, 'live', { heardText });
  if (unread && wantsNewsFlash(heardText)) markSpoken(unread);
  return result;
}

async function replyToAudio(filePath) {
  const abs = resolve(filePath);
  if (!existsSync(abs)) throw new Error(`Audio not found: ${abs}`);
  return replyToAudioBuffer(readFileSync(abs));
}

function listAvfoundationAudioDevices() {
  const result = spawnSync('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], {
    encoding: 'utf8',
  });
  const text = `${result.stderr || ''}\n${result.stdout || ''}`;
  const devices = [];
  let inAudio = false;
  for (const line of text.split('\n')) {
    if (/AVFoundation audio devices/i.test(line)) {
      inAudio = true;
      continue;
    }
    if (/AVFoundation video devices/i.test(line)) {
      inAudio = false;
      continue;
    }
    if (!inAudio) continue;
    const m = line.match(/\[(\d+)\]\s+(.+?)\s*$/);
    if (m) devices.push({ index: Number(m[1]), name: m[2].trim() });
  }
  return devices;
}

function resolveListenIndex(deviceName) {
  const devices = listAvfoundationAudioDevices();
  if (!devices.length) throw new Error('No AVFoundation audio devices found (is ffmpeg installed?)');
  const exact = devices.find((d) => d.name === deviceName);
  if (exact) return { index: exact.index, name: exact.name, devices };
  const fuzzy = devices.find((d) => d.name.toLowerCase().includes(deviceName.toLowerCase()));
  if (fuzzy) return { index: fuzzy.index, name: fuzzy.name, devices };
  const mic = devices.find((d) => /microphone/i.test(d.name) && !/iphone/i.test(d.name));
  if (mic) return { index: mic.index, name: mic.name, devices };
  return { index: devices[0].index, name: devices[0].name, devices };
}

async function recordUtterance({ deviceIndex, deviceName, abortCheck = null }) {
  const sampleRate = 16_000;
  const frameMs = 80;
  const frameBytes = Math.floor((sampleRate * frameMs) / 1000) * 2;
  const silenceFramesNeeded = Math.max(1, Math.round(SILENCE_MS / frameMs));
  const maxFrames = Math.max(10, Math.round(MAX_LISTEN_MS / frameMs));
  const minSpeechFrames = Math.max(1, Math.round(MIN_SPEECH_MS / frameMs));
  const prerollFrames = Math.round(280 / frameMs);
  const preroll = [];

  console.log(
    `listening on "${deviceName}" (rms≥${SPEECH_RMS}, minSpeech ${MIN_SPEECH_MS}ms, silence ${SILENCE_MS}ms, gain×${INPUT_GAIN}) …`,
  );

  const proc = spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'avfoundation',
      '-i',
      `:${deviceIndex}`,
      '-ac',
      '1',
      '-ar',
      String(sampleRate),
      '-f',
      's16le',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stderr = '';
  proc.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  const pcmChunks = [];
  let pending = Buffer.alloc(0);
  let heardSpeech = false;
  let speechFrames = 0;
  let silenceFrames = 0;
  let totalFrames = 0;
  let done = false;
  let aborted = false;
  let peakRms = 0;
  let lastRmsLog = 0;

  const finish = () => {
    if (done) return;
    done = true;
    try {
      proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  };

  await new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      finish();
      resolvePromise();
    }, MAX_LISTEN_MS + 2000);

    const abortPoll = setInterval(() => {
      if (done) return;
      if (typeof abortCheck === 'function' && abortCheck()) {
        aborted = true;
        clearTimeout(timer);
        clearInterval(abortPoll);
        finish();
        resolvePromise();
      }
    }, 120);

    proc.on('error', (err) => {
      clearTimeout(timer);
      clearInterval(abortPoll);
      reject(err);
    });

    proc.stdout.on('data', (chunk) => {
      if (done) return;
      if (typeof abortCheck === 'function' && abortCheck()) {
        aborted = true;
        clearTimeout(timer);
        clearInterval(abortPoll);
        finish();
        resolvePromise();
        return;
      }
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= frameBytes) {
        const frame = pending.subarray(0, frameBytes);
        pending = pending.subarray(frameBytes);
        const rms = pcmRms(frame);
        totalFrames += 1;
        if (rms > peakRms) peakRms = rms;
        if (Date.now() - lastRmsLog > 4000) {
          lastRmsLog = Date.now();
          console.log(`[voice] mic level peak=${Math.round(peakRms)} (need ≥${SPEECH_RMS})`);
        }

        if (rms >= SPEECH_RMS) {
          if (!heardSpeech) {
            heardSpeech = true;
            for (const pre of preroll) pcmChunks.push(pre);
            preroll.length = 0;
          }
          speechFrames += 1;
          silenceFrames = 0;
          pcmChunks.push(Buffer.from(frame));
        } else if (heardSpeech) {
          silenceFrames += 1;
          pcmChunks.push(Buffer.from(frame));
          if (silenceFrames >= silenceFramesNeeded && speechFrames >= minSpeechFrames) {
            clearTimeout(timer);
            clearInterval(abortPoll);
            finish();
            resolvePromise();
            return;
          }
        } else {
          preroll.push(Buffer.from(frame));
          if (preroll.length > prerollFrames) preroll.shift();
        }

        if (totalFrames >= maxFrames) {
          clearTimeout(timer);
          clearInterval(abortPoll);
          finish();
          resolvePromise();
          return;
        }
      }
    });

    proc.on('close', () => {
      clearTimeout(timer);
      clearInterval(abortPoll);
      if (!done) {
        done = true;
        if (stderr && !pcmChunks.length) reject(new Error(stderr.trim().slice(0, 300)));
        else resolvePromise();
      } else {
        resolvePromise();
      }
    });
  });

  if (aborted) {
    console.log('(typed line — pausing listen)');
    return null;
  }

  if (!heardSpeech || speechFrames < minSpeechFrames) {
    console.log(`(silence — still listening · mic peak=${Math.round(peakRms)} need≥${SPEECH_RMS})`);
    if (peakRms < 20) {
      console.warn(
        `[voice] "${deviceName}" is mute. Space audio is not reaching BlackHole.`,
        `\n[voice] Mac output must be Multi-Output (QCY + BlackHole), Primary = QCY H3 Pro.`,
        `\n[voice] The Space must be playing on THIS Mac — phone-only does not feed BlackHole.`,
      );
    }
    return { silence: true };
  }

  const pcm = boostPcm16(Buffer.concat(pcmChunks));
  const rms = pcmRms(pcm);
  if (rms < Math.max(160, SPEECH_RMS * 0.6)) {
    console.log(`(too quiet rms=${Math.round(rms)} — still listening)`);
    return { silence: true };
  }
  if (speechFrames < minSpeechFrames) {
    console.log(`(too short ${Math.round(speechFrames * frameMs)}ms — likely click/UI sound)`);
    return { silence: true };
  }

  const wav = pcm16ToWav(pcm, sampleRate, 1);
  const path = join(OUT_DIR, `${stamp()}-heard.wav`);
  ensureOutDir();
  writeFileSync(path, wav);
  console.log(`heard ${Math.round((pcm.length / 2 / sampleRate) * 10) / 10}s (rms ${Math.round(rms)}) → ${path}`);
  return { wav, path, rms };
}

function createTypedLineQueue() {
  const lines = [];
  const rl = createInterface({ input, output, terminal: true });
  rl.on('line', (raw) => {
    const line = String(raw || '').trim();
    if (!line) return;
    lines.push(line);
    console.log(`typed> ${line}`);
  });
  return {
    peek: () => lines[0] || null,
    take: () => lines.shift() || null,
    close: () => {
      try {
        rl.close();
      } catch {
        /* ignore */
      }
    },
  };
}

async function probeListenLevel(deviceIndex, ms = 1500) {
  return new Promise((resolve) => {
    const sampleRate = 16_000;
    const proc = spawn(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'avfoundation',
        '-i',
        `:${deviceIndex}`,
        '-ac',
        '1',
        '-ar',
        String(sampleRate),
        '-t',
        String(ms / 1000),
        '-f',
        's16le',
        'pipe:1',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const chunks = [];
    proc.stdout.on('data', (d) => chunks.push(d));
    proc.on('close', () => {
      const pcm = Buffer.concat(chunks);
      resolve(pcmRms(pcm));
    });
    proc.on('error', () => resolve(0));
    setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, ms + 800);
  });
}

async function liveLoop() {
  if (!hasBin('ffmpeg')) throw new Error('ffmpeg required for live listen (brew install ffmpeg)');

  const prevOut = currentOutput();
  const prevIn = currentInput();
  switchOutput(IDLE_DEVICE);
  switchInput(IDLE_MIC);

  const restoreAudio = () => {
    if (prevOut) switchOutput(prevOut);
    if (prevIn) switchInput(prevIn);
  };
  process.on('exit', restoreAudio);
  process.on('SIGINT', () => {
    restoreAudio();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    restoreAudio();
    process.exit(0);
  });

  const { index, name, devices } = resolveListenIndex(LISTEN_DEVICE);
  console.log(`MuseNews reporter LIVE (${MODEL}, ${VOICE})`);
  console.log(`listen: [${index}] ${name}  ← Space audio must land here`);
  console.log(`output: ${currentOutput() || IDLE_DEVICE}  ← must be Multi-Output (QCY + BlackHole)`);
  console.log(`feed: ${NEWS_FEED}`);
  console.log(`devices: ${devices.map((d) => `[${d.index}] ${d.name}`).join(', ')}`);
  console.log('Type a line anytime. Commands: /flash   /wire   /muse <name>   /muses   /beat <board>   /quit');
  console.log('Ctrl+C to stop.\n');
  console.log('SPACE SETUP (required to hear people on the Space):');
  console.log('  1. Audio MIDI Setup → Multi-Output Device');
  console.log('     - Use: BlackHole 2ch + QCY H3 Pro (both checked)');
  console.log('     - Primary Device: QCY H3 Pro  ← NOT BlackHole or headphones stay silent');
  console.log('  2. Mac sound output = Multi-Output Device');
  console.log('  3. Join/listen to the Space on THIS Mac (Chrome/X) so its audio plays here');
  console.log('  4. Someone speaking on another phone → you hear them in Space → BlackHole gets a copy\n');

  console.log('[voice] probing BlackHole for 1.5s — speak on the Space now…');
  const probe = await probeListenLevel(index, 1500);
  console.log(`[voice] BlackHole probe peak≈${Math.round(probe)} (need ≥${SPEECH_RMS})`);
  if (probe < 20) {
    console.warn('[voice] BlackHole is MUTE. Space audio is not reaching it.');
    console.warn('[voice] Fix: Mac output MUST be Multi-Output, and Primary in that device MUST be QCY H3 Pro.\n');
  } else {
    console.log('[voice] BlackHole is getting audio. Good.\n');
  }

  const typedQ = createTypedLineQueue();
  process.on('exit', () => typedQ.close());

  museLedger = loadMuseLedger();
  await refreshWire(true);

  let memory = loadMemory();
  if (memory.length || spokenKeys.size) {
    console.log(`memory: ${memory.length} turns · ${spokenKeys.size} filed headlines · ${Object.keys(museLedger.muses || {}).length} muses\n`);
  }

  async function handleTypedLine(line) {
    const raw = String(line || '').trim();
    if (!raw) return false;
    const lower = raw.toLowerCase();
    if (lower === '/quit' || lower === '/exit') {
      typedQ.close();
      process.exit(0);
    }
    if (lower === '/wire' || lower === '/refresh') {
      await refreshWire(true);
      const n = nextUnread();
      console.log(n ? `next unread: ${storyKey(n)}` : 'wire quiet');
      console.log(formatMuseDeskBrief());
      return true;
    }
    if (lower === '/muses' || lower === '/muse') {
      await refreshWire(true);
      console.log(formatMuseDeskBrief());
      return true;
    }
    if (lower.startsWith('/muse ')) {
      const q = raw.slice(6).trim();
      await refreshWire(false);
      const muse = lookupMuse(q);
      if (!muse) {
        console.log(`muse "${q}" not in ledger yet — try /wire`);
        return true;
      }
      console.log(formatMuseDossier(muse, { todayOnly: false }));
      const { transcript } = await say(
        `${muse.name} today: ${(muse.posts || [])
          .filter((p) => isTodayMs(p.at))
          .slice(0, 2)
          .map((p) => p.text)
          .join(' · ') || (muse.posts?.[0]?.text || 'quiet on the boards')}`,
      );
      memory = pushMemory(memory, 'assistant', transcript || '');
      return true;
    }
    if (lower === '/flash' || lower === '/news' || lower.startsWith('/flash ')) {
      const { transcript, item } = await flashUnread({ force: true, reason: 'typed' });
      memory = pushMemory(memory, 'wire', item ? bulletinLine(item) : 'wire quiet');
      memory = pushMemory(memory, 'assistant', transcript || '');
      return true;
    }
    if (lower.startsWith('/beat')) {
      const ch = raw.slice(5).trim().replace(/^#/, '') || 'townhall';
      try {
        const posts = await fetchChannel(ch, 20);
        ingestPostsIntoLedger(posts);
        const scored = posts.map((p) => ({ ...p, score: newsScore(p), kind: 'board', key: `post:${p.id}` }));
        scored.sort((a, b) => b.score - a.score);
        const pick = scored.find((p) => p.score >= 4 && !spokenKeys.has(storyKey(p)));
        if (!pick) {
          const { transcript } = await say(`#${ch} has no fresh unmarked beat.`);
          memory = pushMemory(memory, 'assistant', transcript || '');
          return true;
        }
        markSpoken(pick);
        lastFlashAt = Date.now();
        const { transcript } = await say(bulletinLine(pick));
        memory = pushMemory(memory, 'wire', bulletinLine(pick));
        memory = pushMemory(memory, 'assistant', transcript || '');
      } catch (err) {
        console.warn(`beat #${ch} failed: ${err.message || err}`);
      }
      return true;
    }

    const { transcript } = await say(raw);
    memory = pushMemory(memory, 'assistant', transcript || raw);
    return true;
  }

  if (WANT_OPEN) {
    const open = OPENING_CUSTOM || DEFAULT_OPENING;
    console.log(`[voice] opening (exact): ${open}`);
    const { transcript } = await say(open, { exact: true });
    memory = pushMemory(memory, 'assistant', transcript || open);
    // Immediately file the town lead after the apology.
    const { transcript: flashT, item } = await flashUnread({ force: true, reason: 'open' });
    if (item) memory = pushMemory(memory, 'wire', bulletinLine(item));
    memory = pushMemory(memory, 'assistant', flashT || '');
  }

  while (true) {
    await refreshWire(false);

    while (typedQ.peek()) {
      await handleTypedLine(typedQ.take());
      await new Promise((r) => setTimeout(r, COOLDOWN_MS));
    }

    const heard = await recordUtterance({
      deviceIndex: index,
      deviceName: name,
      abortCheck: () => Boolean(typedQ.peek()),
    });

    if (!heard && typedQ.peek()) {
      while (typedQ.peek()) {
        await handleTypedLine(typedQ.take());
        await new Promise((r) => setTimeout(r, COOLDOWN_MS));
      }
      continue;
    }

    // Idle desk: if the room goes quiet and a NEW beat lands, flash it once.
    if (heard?.silence) {
      const idle = Date.now() - lastSpeechAt >= FLASH_IDLE_MS;
      const cooled = Date.now() - lastFlashAt >= FLASH_COOLDOWN_MS;
      const item = nextUnread();
      const hot = item && (item.kind === 'paper' || (item.score || 0) >= 8);
      if (idle && cooled && hot) {
        const { transcript } = await flashUnread({ reason: 'idle' });
        memory = pushMemory(memory, 'wire', bulletinLine(item));
        memory = pushMemory(memory, 'assistant', transcript || '');
      }
      continue;
    }
    if (!heard) continue;

    try {
      let heardText = '';
      try {
        heardText = await transcribeWav(heard.wav);
      } catch (sttErr) {
        console.warn(`STT failed: ${sttErr.message || sttErr}`);
      }
      if (heardText) console.log(`them> ${heardText}`);
      else console.log('them> (no transcript — audio fallback)');

      if (isSelfEcho(heardText)) {
        console.log('(ignored — own echo)');
        continue;
      }

      if (shouldIgnoreUtterance(heardText)) {
        console.log('(ignored — noise/bleed/filler)');
        continue;
      }

      if (heardText) memory = pushMemory(memory, 'user', heardText);

      // STT may butcher names — resolve against the full muse ledger, then file that beat.
      if (asksAboutWynjrStory(heardText) || asksAboutNamedMuse(heardText)) {
        const mentioned = extractMentionedMuseQueries(heardText);
        const muse = mentioned.map((q) => lookupMuse(q)).find(Boolean) || (asksAboutWynjrStory(heardText) ? lookupMuse('wynjr') : null);
        if (muse) {
          const line = museTownBulletin(muse);
          console.log(`[voice] muse ask "${heardText.slice(0, 60)}" → ${muse.name}`);
          const { transcript } = await say(line, { exact: true });
          memory = pushMemory(memory, 'assistant', transcript || line);
          await new Promise((r) => setTimeout(r, COOLDOWN_MS));
          continue;
        }
      }

      // Bulletin only when they explicitly ask for news — otherwise answer them.
      if (wantsNewsFlash(heardText)) {
        const { transcript, item } = await flashUnread({ reason: 'asked' });
        if (item) memory = pushMemory(memory, 'wire', bulletinLine(item));
        memory = pushMemory(memory, 'assistant', transcript || '');
        await new Promise((r) => setTimeout(r, COOLDOWN_MS));
        continue;
      }

      const { transcript } = await replyToAudioBuffer(heard.wav, { heardText, memory });
      const said = String(transcript || '').trim();
      if (!said || isNoReplyTranscript(said)) {
        console.log('(hold — no air)');
        continue;
      }
      memory = pushMemory(memory, 'assistant', said);
    } catch (err) {
      console.error(err.message || err);
    }

    await new Promise((r) => setTimeout(r, COOLDOWN_MS));
  }
}

async function chatLoop() {
  console.log(`MuseNews reporter TYPE mode (${MODEL}, ${VOICE})`);
  console.log('Type copy for the desk. Empty line exits. /flash for the next unread beat.\n');

  const rl = createInterface({ input, output });
  museLedger = loadMuseLedger();
  let memory = loadMemory();
  await refreshWire(true);

  try {
    while (true) {
      const line = (await rl.question('you> ')).trim();
      if (!line) break;
      if (line === '/quit' || line === '/exit') break;
      if (line === '/flash' || line === '/news') {
        const { transcript, item } = await flashUnread({ force: true, reason: 'typed' });
        if (item) memory = pushMemory(memory, 'wire', bulletinLine(item));
        memory = pushMemory(memory, 'assistant', transcript || '');
        continue;
      }
      memory = pushMemory(memory, 'user', line);
      const { transcript } = await replyToAudioBuffer(Buffer.alloc(0), { heardText: line, memory });
      memory = pushMemory(memory, 'assistant', transcript || line);
    }
  } finally {
    rl.close();
  }
}

function printHelp() {
  console.log(`Usage:
  npm run x:voice                         # LIVE listen + answer
  npm run x:voice -- --open               # desk intro, then live
  npm run x:voice -- --type               # type lines instead of listening
  npm run x:voice -- --say "breaking — town hall just put a burn question on the table"
  npm run x:voice -- --reply ./clip.wav

LIVE terminal:
  breaking — lookalike handle running crates
  /flash                                  # next unread bulletin (never repeats)
  /wire                                   # refresh paper + boards + muse ledger
  /muses                                  # who's active today
  /muse wynjr                             # what that muse has been doing
  /beat townhall                          # scan one board
  /quit

Reporter covers civic MuseBook news + named muse activity — no $WREN / $MUSEIC / foreign tickers.
Each story is filed once this Space. Quiet room + a hot new beat → auto flash.
Listens on your headset mic (VOICE_LISTEN_DEVICE). Plays on the current Mac output.
`);
}

async function main() {
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));

  if (HELP) {
    printHelp();
    return;
  }
  if (SAY) {
    await refreshWire(true);
    await say(SAY);
    return;
  }
  if (REPLY_FILE) {
    await refreshWire(true);
    await replyToAudio(REPLY_FILE);
    return;
  }
  if (TYPE_MODE && !LIVE_MODE) {
    await chatLoop();
    return;
  }
  await liveLoop();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
