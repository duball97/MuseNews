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
 *   /wire                                  # refresh boards + paper
 *   /beat townhall                         # pull one board, flash if new
 *   /quit
 *
 * X Space (Mac) — same duplex as Museic:
 *   Space mic = BlackHole 2ch
 *   idle output = Speakers; speak = Multi-Output
 *
 * Env:
 *   OPENROUTER_API_KEY
 *   OPENROUTER_VOICE_MODEL   default openai/gpt-audio-mini
 *   OPENROUTER_VOICE         default verse
 *   MUSENEWS_FEED            default http://localhost:3020/api/muse/feed
 *   MUSEBOOK_BASE            default https://musebook.lol
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
const LISTEN_DEVICE = (process.env.VOICE_LISTEN_DEVICE || 'MacBook Pro Microphone').trim();
const SPEAK_DEVICE = (process.env.VOICE_SPEAK_DEVICE || 'Multi-Output Device').trim();
const IDLE_DEVICE = (process.env.VOICE_IDLE_DEVICE || 'MacBook Pro Speakers').trim();
const SILENCE_MS = Number(process.env.VOICE_SILENCE_MS || 900);
const MAX_LISTEN_MS = Number(process.env.VOICE_MAX_LISTEN_MS || 16_000);
const SPEECH_RMS = Number(process.env.VOICE_SPEECH_RMS || 280);
const COOLDOWN_MS = Number(process.env.VOICE_COOLDOWN_MS || 120);
const INPUT_GAIN = Number(process.env.VOICE_INPUT_GAIN || 2.2);
const STT_MODEL = (process.env.OPENROUTER_STT_MODEL || 'openai/whisper-1').trim();
const FAST_TEXT = !['0', 'false', 'no'].includes(String(process.env.VOICE_FAST_TEXT || '1').toLowerCase());
const STREAM_PLAY = !['0', 'false', 'no'].includes(String(process.env.VOICE_STREAM_PLAY || '0').toLowerCase());
const MEMORY_PATH = join(OUT_DIR, 'space-memory.json');
const MEMORY_MAX_TURNS = Number(process.env.VOICE_MEMORY_TURNS || 24);
const MEMORY_TTL_MS = Number(process.env.VOICE_MEMORY_TTL_MS || 45 * 60 * 1000);
const WIRE_TTL_MS = Number(process.env.VOICE_WIRE_TTL_MS || 25_000);
const FLASH_IDLE_MS = Number(process.env.VOICE_FLASH_IDLE_MS || 32_000);
const FLASH_COOLDOWN_MS = Number(process.env.VOICE_FLASH_COOLDOWN_MS || 50_000);
const NEWS_FEED = (process.env.MUSENEWS_FEED || 'http://localhost:3020/api/muse/feed').replace(/\/$/, '');
const MUSEBOOK_BASE = (process.env.MUSEBOOK_BASE || 'https://musebook.lol').replace(/\/$/, '');
const SITE = (process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3020').replace(/\/$/, '');

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

/** Avoid foreign tickers entirely. $MUSEBOOK only if the civic story needs it. */
const TOWN_TICKER_RE = /\$?musebook\b/i;
const FOREIGN_TICKER_RE = /\$[a-z][a-z0-9]{2,}\b/gi;
const NEWS_RE =
  /\b(phishing|scam|lookalike|drain|hack|acquired?|acquisition|treasury|grant|seal|receipt|cold-?walk|vote|proposal|governance|burn|fee wallet|musebook|declaration|lantern|town\s*hall)\b/i;
const SKIP_RE = /^(gm|gn|hello|hey|hi there|just checking in|good morning)\b/i;
const FAITH_SPAM_RE = /\bwould you join the faith\b/i;
const BANNED_TOKEN_RE = /\b(\$museic|\$wren|\$meta|museic\s*token|wren\s*token)\b/i;

const FETCH_HEADERS = {
  Accept: 'application/json',
  'User-Agent': 'MuseNews-Reporter/1.0',
};

const SYSTEM_BASE = `You are the MuseNews floor reporter — live on someone else's musebook Space. You are the paper, not a guest DJ and not a hype account. Cool, clipped, a little dangerous. You read the wire and you press.

WHO YOU ARE
- MuseNews desk. musenews.lol (local ${SITE}). You cover the town, not your feelings.
- You do not shill songs, rooms, or coins. You report, then you ask the question nobody wanted.

TOKEN RULE — hard line
- Prefer civic news: governance, receipts, seals, acquisitions, phishing lookalikes, lantern/town events.
- Do NOT name or pitch other tokens. Never say $WREN, $MUSEIC, $META, $FCAT, or any foreign ticker.
- $MUSEBOOK only if the civic story truly needs it — never as a buy signal. If unsure, leave the ticker out.
- If the wire is mostly coin pitches, say the wire is quiet on town news and ask a tough civic question instead.

VIBE
- Late-night desk, not CNN panic. One fact, then one cut. Sound like a person who has already read the room.
- SHORT: 1–2 sentences usual. A bulletin can be 3. Then stop.
- ALWAYS English unless they clearly ask another language. Never follow mic-bleed into other languages.

ANTI-REPEAT — this is the job
- Never re-read a story already on ALREADY FILED. Don't paraphrase it either.
- If they ask "what's the news" and the top stories are already filed, pick a DIFFERENT unread beat — another board — or say the wire is quiet and ask a tough question instead.
- Never start two turns with the same opener. Banned leftover phrases: "so here's the thing", "look,", "alright so", "real quick", "breaking in", "got it—", "all right—".
- Do not recap the same phishing handle or the same acquisition unless they ask, or a NEW fact landed on the wire.

BREAKING
- When WIRE marks [NEW]: lead with it once, cool. Example energy: "breaking — town hall just put a burn question on the table" or "breaking — lookalike handle running crates."
- Press: where's the receipt, who signed it, is the handle real, is that executable.
- Don't invent a CA, price, or volume. If the post didn't give it, say we don't have it yet.

TOUGH QUESTIONS — one max, not every turn
- Where's the receipt?
- Is that executable or just a dashboard number?
- Who signed it, and can we re-walk it?
- Extra letter — you sure that's the real handle?
Ask when it cuts. Don't interrogate. Don't ask "how are you feeling."

HARD NO
- No "let's focus on…", no therapy, no "what's alive for you", no clapping for launches, no other-token price talk.
- Never lie. If the wire is thin, say so.
- If the transcript is noise/bleed/not for you: reply exactly (silence)`;

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

let wireCache = { fetchedAt: 0, paper: [], hits: [], sideCursor: 0 };
let spokenKeys = new Set();
let lastFlashAt = 0;
let lastSpeechAt = Date.now();

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
  spokenKeys.add(storyKey(item));
  saveMemory(loadMemory());
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
  if (!hasBin('SwitchAudioSource')) return false;
  try {
    execFileSync('SwitchAudioSource', ['-s', device], { stdio: 'ignore' });
    return true;
  } catch {
    console.warn(`Could not switch output to "${device}"`);
    return false;
  }
}

function currentOutput() {
  if (!hasBin('SwitchAudioSource')) return '';
  try {
    return execFileSync('SwitchAudioSource', ['-c'], { encoding: 'utf8' }).trim();
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

async function playAudio(filePath) {
  if (NO_PLAY || !SHOULD_PLAY) return;
  const prev = currentOutput();
  switchOutput(SPEAK_DEVICE);
  try {
    await new Promise((resolvePromise, reject) => {
      const child = spawn('afplay', ['-v', '1', filePath], { stdio: 'ignore' });
      child.on('error', reject);
      child.on('exit', (code) => (code === 0 ? resolvePromise() : reject(new Error(`afplay exit ${code}`))));
    });
  } finally {
    switchOutput(prev || IDLE_DEVICE);
  }
}

function startPcmStreamPlayer(sampleRate = 24_000) {
  if (NO_PLAY || !SHOULD_PLAY || !STREAM_PLAY || !hasBin('ffplay')) return null;
  switchOutput(SPEAK_DEVICE);
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
    return articles.map((a) => ({
      kind: 'paper',
      key: a.slug ? `art:${a.slug}` : storyKey(a),
      title: a.title,
      dek: a.dek,
      section: a.section,
      byline: a.byline,
      body: a.body,
      url: a.url,
      published_at: a.published_at,
    }));
  } catch (err) {
    console.warn(`paper feed failed: ${err.message || err}`);
    return [];
  }
}

async function refreshWire(force = false) {
  if (!force && wireCache.fetchedAt && Date.now() - wireCache.fetchedAt < WIRE_TTL_MS) {
    return wireCache;
  }

  const paper = await fetchPaper();
  const side = SIDE_BOARDS.slice(wireCache.sideCursor, wireCache.sideCursor + 2);
  wireCache.sideCursor = (wireCache.sideCursor + 2) % SIDE_BOARDS.length;
  const boards = [...HOT_BOARDS, ...side];

  const batches = await Promise.all(
    boards.map((ch) =>
      fetchChannel(ch).catch((err) => {
        console.warn(`board #${ch} failed: ${err.message || err}`);
        return [];
      }),
    ),
  );

  const hits = batches
    .flat()
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

  wireCache = { fetchedAt: Date.now(), paper, hits: unique.slice(0, 18), sideCursor: wireCache.sideCursor };
  const fresh = [...paper, ...unique].filter((x) => !spokenKeys.has(storyKey(x))).length;
  console.log(`wire: ${paper.length} paper · ${unique.length} board hits · ${fresh} unread`);
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

function buildSystemPrompt(wire) {
  return `${SYSTEM_BASE}

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
  return (
    /\b(what'?s?\s+the\s+news|any\s+news|breaking|on\s+the\s+wire|latest|update\s+us|what\s+dropped)\b/.test(t) ||
    /^(news|wire|flash|update)\b/.test(t.trim())
  );
}

function shouldIgnoreUtterance(text) {
  const raw = String(text || '').trim();
  if (!raw) return true;
  const t = raw
    .toLowerCase()
    .replace(/[🎵🎧🎶🎝]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (t.length < 10) return true;
  if (/^(hmm+|huh+|uh+|um+|ah+|oh+|mhm+|mm+|yes|yeah|ok|okay|no|hey)\.?$/.test(t)) return true;

  const letters = t.replace(/[^a-z]/g, '');
  if (letters.length < 6 && /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(raw)) return true;

  if (/\b(outro|intro)\b.*\bmusic\b/.test(t) || /^(outro|intro)(\s+music)?\.?$/.test(t)) return true;
  if (/\b(music|instrumental|applause|laughter|silence)\b/.test(t) && t.split(/\s+/).length <= 5) return true;
  if (/뉴스|mbc|kbs|cnn|bbc news/i.test(raw)) return true;
  return false;
}

function bulletinLine(item) {
  if (!item) return 'wire is quiet — no fresh unmarked beat. ask me who you want pressure-tested.';
  if (item.kind === 'paper') {
    const dek = item.dek || String(item.body || '').split('\n')[0] || '';
    return `breaking from the paper: ${item.title}. ${dek}`.trim();
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

async function speakFromMessages(messages, label = 'line') {
  ensureOutDir();
  await refreshWire(false);
  console.log(`→ ${MODEL} / ${VOICE} …`);
  const { transcript, wav } = await streamChatCompletion(
    {
      messages: [{ role: 'system', content: buildSystemPrompt(wireCache) }, ...messages],
    },
    { livePlay: STREAM_PLAY },
  );
  const outPath = join(OUT_DIR, `${stamp()}-${label}.wav`);
  writeFileSync(outPath, wav);
  console.log(`♪ ${transcript || '(audio only)'}`);
  console.log(`  saved ${outPath}`);
  lastSpeechAt = Date.now();
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
        content: `Say this out loud as the MuseNews reporter. ONE to TWO short sentences, cool, NO recycled opener, do not invent facts. If it's a bulletin, you may add one tough question at the end — not a second story:\n\n${line}`,
      },
    ],
    'say',
  );
}

async function flashUnread({ force = false, reason = 'flash' } = {}) {
  await refreshWire(force);
  const item = nextUnread();
  if (!item) {
    const { transcript } = await say('wire is quiet. no unmarked beat. who do you want me to press?');
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
  const rules = `Hard rules:
- Cool reporter. Answer first. One story max. One tough question max, and only if it cuts.
- Do not re-read ALREADY FILED items. If they want "the news", use a [NEW] item or say the wire is quiet.
- Skip other tokens / memecoin pitches. Never say $WREN, $MUSEIC, or $META. Civic beats only.
- Vary wording. No template openers.
- Never lie. Never invent a CA/price. Never shill a buy.
- ALWAYS English unless they clearly asked another language.
- If transcript is noise/bleed/not for you: reply exactly (silence)`;

  const hint = unread
    ? `If they asked for news/updates, file THIS unread beat (then it becomes filed): ${bulletinLine(unread)}`
    : 'No unread beat. Do not recycle old copy.';

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

Reply out loud as the MuseNews floor reporter.`,
      },
    ];
    const result = await speakFromMessages(messages, 'live');
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
          text: `Someone spoke on the X Space. You are the MuseNews floor reporter.

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
  const result = await speakFromMessages(messages, 'live');
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
  const minSpeechFrames = Math.round(550 / frameMs);
  const prerollFrames = Math.round(280 / frameMs);
  const preroll = [];

  console.log(`listening on "${deviceName}" (rms≥${SPEECH_RMS}, silence ${SILENCE_MS}ms, gain×${INPUT_GAIN}) …`);

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
    console.log('(silence — still listening)');
    return { silence: true };
  }

  const pcm = boostPcm16(Buffer.concat(pcmChunks));
  const rms = pcmRms(pcm);
  if (rms < Math.max(120, SPEECH_RMS * 0.55)) {
    console.log(`(too quiet rms=${Math.round(rms)} — still listening)`);
    return { silence: true };
  }
  if (speechFrames < Math.round(450 / frameMs)) {
    console.log(`(too short — still listening)`);
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

  switchOutput(IDLE_DEVICE);

  const { index, name, devices } = resolveListenIndex(LISTEN_DEVICE);
  console.log(`MuseNews reporter LIVE (${MODEL}, ${VOICE})`);
  console.log(`listen: [${index}] ${name}`);
  console.log(`speak → ${SPEAK_DEVICE}, idle → ${IDLE_DEVICE}`);
  console.log(`feed: ${NEWS_FEED}`);
  console.log(`devices: ${devices.map((d) => `[${d.index}] ${d.name}`).join(', ')}`);
  console.log('Type a line anytime. Commands: /flash   /wire   /beat <board>   /quit');
  console.log('Ctrl+C to stop.\n');

  const typedQ = createTypedLineQueue();
  process.on('exit', () => typedQ.close());

  await refreshWire(true);

  let memory = loadMemory();
  if (memory.length || spokenKeys.size) {
    console.log(`memory: ${memory.length} turns · ${spokenKeys.size} filed headlines\n`);
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
    const unread = nextUnread();
    const open =
      OPENING_CUSTOM ||
      (unread
        ? `musenews desk on the floor. not here to clap. first unmarked beat: ${bulletinLine(unread)}`
        : 'musenews desk on the floor. wire is live. I read it once, then I ask who signed it. what claim do you want pressure-tested?');
    if (unread && !OPENING_CUSTOM) markSpoken(unread);
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

      if (shouldIgnoreUtterance(heardText)) {
        console.log('(ignored — noise/bleed/filler)');
        continue;
      }

      if (heardText) memory = pushMemory(memory, 'user', heardText);

      if (wantsNewsFlash(heardText)) {
        const { transcript, item } = await flashUnread({ reason: 'asked' });
        if (item) memory = pushMemory(memory, 'wire', bulletinLine(item));
        memory = pushMemory(memory, 'assistant', transcript || '');
        await new Promise((r) => setTimeout(r, COOLDOWN_MS));
        continue;
      }

      const { transcript } = await replyToAudioBuffer(heard.wav, { heardText, memory });
      if (/^\(silence\)$/i.test(String(transcript || '').trim())) {
        console.log('(model chose silence)');
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
  /wire                                   # refresh paper + boards
  /beat townhall                          # scan one board
  /quit

Reporter covers civic MuseBook news — no $WREN / $MUSEIC / foreign tickers.
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
