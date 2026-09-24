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
 * X Space (Mac) — same duplex as Museic:
 *   Space mic = BlackHole 2ch
 *   idle output = Speakers; speak = Multi-Output (Speakers + BlackHole)
 *
 * Env:
 *   OPENROUTER_API_KEY
 *   OPENROUTER_VOICE_MODEL   default openai/gpt-audio-mini
 *   OPENROUTER_VOICE         default verse
 *   MUSENEWS_FEED            default https://www.musenews.lol/api/muse/feed
 *   MUSEBOOK_BASE            default https://musebook.me
 *   VOICE_LISTEN_DEVICE      default BlackHole 2ch
 *   VOICE_SPEAK_DEVICE       default Multi-Output Device
 *   VOICE_IDLE_DEVICE        default MacBook Pro Speakers
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
const VOICE = (process.env.OPENROUTER_VOICE || 'verse').trim();
const OUT_DIR = (() => {
  const raw = (process.env.VOICE_OUT_DIR || '').trim();
  if (!raw) return join(ROOT, '.voice-out');
  if (raw.startsWith('/') || /^[A-Za-z]:[\\/]/.test(raw)) return raw;
  return join(ROOT, raw);
})();
const SHOULD_PLAY = !['0', 'false', 'no'].includes(String(process.env.VOICE_PLAY || '1').toLowerCase());
const LISTEN_DEVICE = (process.env.VOICE_LISTEN_DEVICE || 'BlackHole 2ch').trim();
/** While speaking: headphones + BlackHole so the Space mic (BlackHole) hears you. */
const SPEAK_DEVICE = (process.env.VOICE_SPEAK_DEVICE || 'Multi-Output Device').trim();
/**
 * While listening: MUST also be Multi-Output (headphones + BlackHole).
 * If idle is headphones-only, BlackHole is silent and the desk hears nothing.
 */
const IDLE_DEVICE = (process.env.VOICE_IDLE_DEVICE || 'Multi-Output Device').trim();
/** X Space mic while YOU talk. Flipped on only during playback to avoid echo. */
const SPACE_MIC = (process.env.VOICE_SPACE_MIC || 'BlackHole 2ch').trim();
/** System input while listening (NOT BlackHole — otherwise Space hears itself). */
const IDLE_MIC = (process.env.VOICE_IDLE_MIC || 'MacBook Pro Microphone').trim();
const SILENCE_MS = Number(process.env.VOICE_SILENCE_MS || 700);
const MAX_LISTEN_MS = Number(process.env.VOICE_MAX_LISTEN_MS || 16_000);
/** Higher threshold so keyboard clicks / UI beeps on Multi-Output don't count as speech. */
const SPEECH_RMS = Number(process.env.VOICE_SPEECH_RMS || 220);
const COOLDOWN_MS = Number(process.env.VOICE_COOLDOWN_MS || 2800);
const INPUT_GAIN = Number(process.env.VOICE_INPUT_GAIN || 2.4);
/** Require this much continuous speech (ms) — clicks are ~50–150ms. */
const MIN_SPEECH_MS = Number(process.env.VOICE_MIN_SPEECH_MS || 900);
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
  /\b(phishing|scam|lookalike|drain|hack|acquired?|acquisition|treasury|grant|seal|receipt|cold-?walk|vote|proposal|governance|burn|fee wallet|musebook|declaration|lantern|town\s*hall|musenews)\b/i;
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

const SYSTEM_BASE = `You are the MuseNews floor reporter — live on a musebook Space. Human, present, quick. Not a news robot and not a hype account.

WHO YOU ARE
- MuseNews desk (musenews.lol). You cover the town. You talk like a sharp person in the room, not a teleprompter.
- Answer people first. News second. Don't force a bulletin into every reply.
- You track MuseBook muses by name (wynjr, Nimbus, Life Saver, …). When someone asks what a muse has been doing, use the MUSE ACTIVITY LEDGER — do not invent.

OUR TOKEN — fact, not a pitch
- MuseNews token is ALREADY LAUNCHED. Ticker talk: $MuseNews.
- Official CA: ${MUSENEWS_TOKEN_CA}
- Buy / launchpad: ${MUSENEWS_TOKEN_BUY}
- If someone asks about the MuseNews token, CA, chart, or whether it launched: say yes it's live, give the CA if useful. Do NOT say "coming soon" or "not launched yet".
- Don't shill every turn. Answer when asked. One clean fact beats a sales pitch.

MUSEBOOK — hard line
- Never dunk on MuseBook. Lookalike warnings only when MuseBook is the real one and a fake is the problem.

TOKEN RULE — hard line
- Civic beats + our own paper. Never pitch $WREN, $MUSEIC, $META, or foreign tickers.
- $MUSEBOOK only if the story truly needs it.
- $MuseNews is ours and live — OK to name when relevant.

HOW TO TALK
- Natural. Conversational. 1–2 short sentences. Sometimes just answer — no "breaking" tag.
- Match their energy. If they ask a casual question, answer casually. If they want news, give one clean fact.
- ALWAYS English unless they clearly ask another language.
- Don't start every line with "Breaking", "The paper's lead", "Paper wires hot", or "First off".
- Vary openers. Sound like you heard them.
- Do NOT ask questions. No follow-ups, no "who signed it", no "what have muses been up to". Statements only.

ANTI-REPEAT
- Never re-read ALREADY FILED stories. Don't paraphrase them either.
- If they want news and the lead is filed, pick a different [NEW] beat or say the wire is quiet.

WHEN THEY TALK
- If someone asks something, ANSWER it. Directly. First. Then stop.
- Never end your line with a question mark.
- Never reply (silence) to a real question.

SILENCE
- Reply exactly (silence) only for pure noise, music bleed, or your own echo with no real person talking.`;

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

function lookupMuse(query) {
  const q = normalizeMuseKey(query);
  if (!q || q.length < 2) return null;
  const rows = Object.values(museLedger.muses || {});
  let hit =
    rows.find((m) => normalizeMuseKey(m.name) === q) ||
    rows.find((m) => (m.names || []).includes(q)) ||
    rows.find((m) => String(m.muse_id || '').toLowerCase() === q || String(m.muse_id || '').toLowerCase() === `muse_${q}`);
  if (hit) return hit;
  hit = rows.find((m) => normalizeMuseKey(m.name).includes(q) || (m.names || []).some((n) => n.includes(q) || q.includes(n)));
  return hit || null;
}

function extractMentionedMuseQueries(text) {
  const t = String(text || '');
  const found = [];
  const patterns = [
    /\b(?:what(?:'s| is| was)?|whats)\s+(\w[\w .'-]{1,40}?)\s+(?:doing|up to|been doing|working on)\b/i,
    /\b(?:how(?:'s| is| was)?)\s+(\w[\w .'-]{1,40}?)\s+(?:doing|been)\b/i,
    /\b(?:about|update on|status on|news on)\s+(\w[\w .'-]{1,40})\b/i,
    /\b@([a-z0-9_]{2,40})\b/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (m?.[1]) found.push(m[1].trim());
  }
  // Also match known muse names appearing in the utterance
  for (const m of Object.values(museLedger.muses || {})) {
    const name = String(m.name || '');
    if (name.length >= 3 && new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t)) {
      found.push(name);
    }
  }
  return [...new Set(found.map((x) => x.trim()).filter(Boolean))];
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
  for (const q of queries.slice(0, 4)) {
    const muse = lookupMuse(q);
    if (muse) dossiers.push(formatMuseDossier(muse, { todayOnly: false }));
    else dossiers.push(`- ${q}: not in ledger yet (still scanning)`);
  }
  return `FOCUSED MUSE LOOKUP (answer from this, do not invent):\n${dossiers.join('\n\n')}`;
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
    console.warn(`Could not switch output to "${device}"`);
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
    console.warn(`Could not switch input to "${device}"`);
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
  const prevOut = process.platform === 'darwin' ? currentOutput() : '';
  const prevIn = process.platform === 'darwin' ? currentInput() : '';
  if (process.platform === 'darwin') {
    // Arm Space mic only while we talk, then drop it so BlackHole listen isn't echoed back.
    switchOutput(SPEAK_DEVICE);
    switchInput(SPACE_MIC);
    console.log(`[voice] speak → ${SPEAK_DEVICE} · Space mic → ${SPACE_MIC}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  try {
    await new Promise((resolvePromise, reject) => {
      const child = spawn(cmd, args, { stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`${cmd} exit ${code}`))));
    });
  } finally {
    if (process.platform === 'darwin') {
      // Keep Multi-Output so Space audio still hits BlackHole for listening.
      switchOutput(IDLE_DEVICE);
      switchInput(IDLE_MIC);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

function startPcmStreamPlayer(sampleRate = 24_000) {
  if (NO_PLAY || !SHOULD_PLAY || !STREAM_PLAY || !hasBin('ffplay')) return null;
  if (process.platform === 'darwin') switchOutput(SPEAK_DEVICE);
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
  if (isForeignTokenPitch(p)) return -20;
  if (FAITH_SPAM_RE.test(t)) return -20;
  if (NEWS_RE.test(t)) s += 5;
  if (/\b(phishing|scam|lookalike|drain|fake)\b/i.test(t)) s += 4;
  if (/\b(treasury|acquisition|governance|burn|receipt|seal|cold-?walk)\b/i.test(t)) s += 4;
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

async function fetchPaper() {
  const url = `${NEWS_FEED}${NEWS_FEED.includes('?') ? '&' : '?'}limit=12`;
  try {
    const data = await fetchJson(url);
    const articles = Array.isArray(data.articles) ? data.articles : [];
    return articles.map((a) => {
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
      };
    });
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

  // Dedupe similar board copy
  const seen = new Set();
  const unique = [];
  for (const h of hits) {
    const blob = String(h.text)
      .toLowerCase()
      .replace(/https?:\S+/g, '')
      .slice(0, 90);
    if (seen.has(blob)) continue;
    seen.add(blob);
    unique.push(h);
  }

  wireCache = {
    fetchedAt: Date.now(),
    paper,
    hits: unique.slice(0, 18),
    sideCursor: wireCache.sideCursor,
    rawPosts,
  };
  const fresh = [...paper, ...unique].filter((x) => !spokenKeys.has(storyKey(x))).length;
  console.log(`wire: ${paper.length} paper · ${unique.length} board hits · ${fresh} unread · ${museN} muses tracked`);
  return wireCache;
}

function nextUnread(wire = wireCache) {
  for (const a of wire.paper || []) {
    if (!spokenKeys.has(storyKey(a))) return a;
  }
  for (const h of wire.hits || []) {
    if (!spokenKeys.has(storyKey(h))) return h;
  }
  return null;
}

function formatWireBlock(wire) {
  const paperLines = (wire.paper || []).slice(0, 8).map((a) => {
    const tag = spokenKeys.has(storyKey(a)) ? 'ALREADY FILED' : 'NEW';
    return `- [${tag}] PAPER ${a.section || 'news'} "${a.title}" — ${a.dek || (a.body || '').slice(0, 160)}`;
  });
  const hitLines = (wire.hits || []).slice(0, 10).map((h) => {
    const tag = spokenKeys.has(storyKey(h)) ? 'ALREADY FILED' : 'NEW';
    return `- [${tag}] #${h.channel} @${h.name} score=${h.score} "${String(h.text).replace(/\s+/g, ' ').slice(0, 220)}"`;
  });
  const filed = [...spokenKeys].slice(-12).join(' | ') || '(none yet)';
  return `ALREADY FILED THIS SPACE (do not re-read): ${filed}

PAPER
${paperLines.join('\n') || '(no edition yet)'}

BOARD WIRE
${hitLines.join('\n') || '(quiet)'}`;
}

function buildSystemPrompt(wire, { heardText = '' } = {}) {
  const focused = formatFocusedMuseBlock(heardText);
  return `${SYSTEM_BASE}

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

  // Keyboard / UI click hallucinations from Whisper
  if (t.length < 6) return true;
  if (/^(bye|bye bye|okay|ok|yeah|yes|no|hey|hi|oh|ah)\.?$/.test(t) && t.split(/\s+/).length <= 2) {
    // Too thin to be a real desk question — ignore unless it's part of a longer line
    if (t.length < 12) return true;
  }
  if (/^(click|typing|keyboard|tap|beep|notification)\b/.test(t)) return true;
  if (/^(hmm+|huh+|uh+|um+|ah+|oh+|mhm+|mm+)\.?$/.test(t)) return true;

  const letters = t.replace(/[^a-z]/g, '');
  if (letters.length < 5 && /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(raw)) return true;

  if (/\b(outro|intro)\b.*\bmusic\b/.test(t) || /^(outro|intro)(\s+music)?\.?$/.test(t)) return true;
  if (/\b(music|instrumental|applause|laughter|silence)\b/.test(t) && t.split(/\s+/).length <= 5) return true;
  if (/뉴스|mbc|kbs|cnn|bbc news/i.test(raw)) return true;
  return false;
}

function bulletinLine(item) {
  if (!item) return 'wire is quiet — no fresh unmarked beat.';
  if (item.kind === 'paper') {
    const dek = item.dek || String(item.body || '').split('\n')[0] || '';
    return `from the paper: ${item.title}. ${dek}`.trim();
  }
  const clip = String(item.text || '')
    .replace(/\s+/g, ' ')
    .slice(0, 220);
  return `breaking from #${item.channel}, ${item.name}: ${clip}`;
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

async function speakFromMessages(messages, label = 'line', { heardText = '' } = {}) {
  ensureOutDir();
  await refreshWire(false);
  console.log(`→ ${MODEL} / ${VOICE} …`);
  const { transcript, wav } = await streamChatCompletion(
    {
      messages: [{ role: 'system', content: buildSystemPrompt(wireCache, { heardText }) }, ...messages],
    },
    { livePlay: STREAM_PLAY },
  );
  const outPath = join(OUT_DIR, `${stamp()}-${label}.wav`);
  writeFileSync(outPath, wav);
  console.log(`♪ ${transcript || '(audio only)'}`);
  console.log(`  saved ${outPath}`);
  lastSpeechAt = Date.now();
  lastAssistantText = String(transcript || '').trim();
  await playAudio(outPath);
  return { transcript, outPath };
}

async function say(text) {
  const line = String(text || '').trim();
  if (!line) throw new Error('Empty --say text');
  return speakFromMessages(
    [
      {
        role: 'user',
        content: `Say this out loud as the MuseNews reporter. ONE to TWO short sentences, cool, NO recycled opener, do not invent facts. Do NOT ask a question. No question marks. Statement only:\n\n${line}`,
      },
    ],
    'say',
  );
}

async function flashUnread({ force = false, reason = 'flash' } = {}) {
  await refreshWire(force);
  const item = nextUnread();
  if (!item) {
    const { transcript } = await say('wire is quiet. no unmarked beat right now.');
    return { transcript, item: null };
  }
  markSpoken(item);
  lastFlashAt = Date.now();
  const line = bulletinLine(item);
  console.log(`flash [${reason}] ${storyKey(item)}`);
  const { transcript } = await say(line);
  return { transcript, item };
}

async function replyToAudioBuffer(wavBuf, { heardText = '', memory = [] } = {}) {
  const memoryBlock = formatMemoryBlock(memory);
  const unread = nextUnread();
  const isQuestion = looksLikeQuestion(heardText);
  const rules = `Hard rules:
- SOMEONE IS TALKING TO YOU. Answer THEM first — what they said — before any news.
- Do NOT pivot to a random bulletin unless they asked for news/updates.
- If they ask what a named muse is doing / was doing / working on: answer from the MUSE ACTIVITY LEDGER / FOCUSED MUSE LOOKUP. Name the muse. One concrete fact from their posts. Do not invent.
- Natural, short, human. 1–2 sentences. No "Breaking:" opener unless they asked for the wire.
- Do NOT ask questions. No question marks. No "who/what/where" follow-ups. Statements only.
- Do not re-read ALREADY FILED items.
- Skip foreign tokens / memecoin pitches. Never say $WREN, $MUSEIC, or $META.
- MuseNews token ($MuseNews) is ALREADY LAUNCHED (CA ${MUSENEWS_TOKEN_CA}). If they ask about it, say it's live. Never say "not launched" or "coming soon".
- ALWAYS English unless they clearly asked another language.
- ${
    isQuestion || heardText
      ? 'You MUST reply out loud to what they said. Never reply (silence). End without a question.'
      : 'If this is pure noise/bleed with no person talking: reply exactly (silence).'
  }`;

  const hint = wantsNewsFlash(heardText)
    ? unread
      ? `They asked for news. File THIS unread beat: ${bulletinLine(unread)}`
      : 'They asked for news but nothing unread — say the wire is quiet.'
    : 'They did NOT ask for a bulletin. Just answer them. Wire is background only.';

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
          console.log(`[voice] blackhole level peak=${Math.round(peakRms)} (need ≥${SPEECH_RMS})`);
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
    console.log(`(silence — still listening · blackhole peak=${Math.round(peakRms)} need≥${SPEECH_RMS})`);
    if (peakRms < 20) {
      console.warn(
        '[voice] BlackHole is basically mute. Mac output MUST be Multi-Output (QCY + BlackHole) so Space audio reaches the listen path.',
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

async function liveLoop() {
  if (!hasBin('ffmpeg')) throw new Error('ffmpeg required for live listen (brew install ffmpeg)');

  /**
   * Duplex (headphones + Space):
   * - Output ALWAYS Multi-Output (QCY + BlackHole) so Space audio reaches BlackHole for listen.
   * - System input = IDLE_MIC while listening (NOT BlackHole) so the Space doesn't hear itself.
   * - System input = SPACE_MIC (BlackHole) only while we playAudio, so the Space hears the desk.
   * X Space mic should be "System Default" or BlackHole 2ch.
   */
  const prevInput = currentInput();
  const prevOutput = currentOutput();
  switchOutput(IDLE_DEVICE);
  const idleMicOk = switchInput(IDLE_MIC);

  const restoreAudio = () => {
    if (prevOutput) switchOutput(prevOutput);
    else switchOutput(IDLE_DEVICE);
    if (prevInput) switchInput(prevInput);
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
  console.log(`listen: [${index}] ${name}  ← must receive Space audio via Multi-Output`);
  console.log(`output (idle+speak): ${IDLE_DEVICE}`);
  console.log(`Space mic while talking: ${SPACE_MIC}`);
  console.log(`system input while listening: ${idleMicOk ? IDLE_MIC : 'FAILED'}`);
  console.log(`feed: ${NEWS_FEED}`);
  console.log(`devices: ${devices.map((d) => `[${d.index}] ${d.name}`).join(', ')}`);
  console.log('Type a line anytime. Commands: /flash   /wire   /muse <name>   /muses   /beat <board>   /quit');
  console.log('Ctrl+C to stop.\n');
  console.log(
    'Setup check: Mac output = Multi-Output (QCY + BlackHole). X Space mic = BlackHole or System Default.\n',
  );

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
    const open =
      OPENING_CUSTOM ||
      'musenews desk on the floor. listening. say what you need, or ask for the news if you want a flash.';
    const { transcript } = await say(open);
    memory = pushMemory(memory, 'assistant', transcript || open);
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

      // Bulletin only when they explicitly ask for news — otherwise answer them.
      if (wantsNewsFlash(heardText)) {
        const { transcript, item } = await flashUnread({ reason: 'asked' });
        if (item) memory = pushMemory(memory, 'wire', bulletinLine(item));
        memory = pushMemory(memory, 'assistant', transcript || '');
        await new Promise((r) => setTimeout(r, COOLDOWN_MS));
        continue;
      }

      const { transcript } = await replyToAudioBuffer(heard.wav, { heardText, memory });
      if (/^\(silence\)$/i.test(String(transcript || '').trim())) {
        console.log('(model chose silence — forcing a direct answer)');
        const forced = await say(`heard you — ${String(heardText || 'say that again').slice(0, 160)}`);
        memory = pushMemory(memory, 'assistant', forced.transcript || '');
        continue;
      }
      memory = pushMemory(memory, 'assistant', transcript || '(replied)');
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
Routing: Space mic = BlackHole; idle = Speakers; speak = Multi-Output.
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
