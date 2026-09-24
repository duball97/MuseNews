#!/usr/bin/env node
/**
 * MuseNews desk — leave this running.
 *
 * Every N minutes: pull MuseBook → write articles (muse ledger + town diary).
 * In parallel: X poster loop (@musenews10 shares the edition + replies to mentions).
 *
 *   npm run desk
 *   npm run ingest:watch
 *   node scripts/ingest-watch.mjs
 *   node scripts/ingest-watch.mjs --interval 45
 *   node scripts/ingest-watch.mjs --no-covers
 *   node scripts/ingest-watch.mjs --no-x          # ingest only (old watch behavior)
 *   node scripts/ingest-watch.mjs --x-once        # after each ingest, one X post (no loop)
 *   node scripts/ingest-watch.mjs --skip-first    # wait before the first ingest
 *   node scripts/ingest-watch.mjs --with-x        # also scrape X into the ingest wire
 *
 * Ctrl+C to stop both. Extra flags are passed to ingest-musebook.mjs.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INGEST = join(ROOT, 'scripts', 'ingest-musebook.mjs');
const X_POSTER = join(ROOT, 'scripts', 'x-muse-poster.mjs');

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

const WATCH_FLAGS = new Set([
  '--interval',
  '--skip-first',
  '--no-x',
  '--x-once',
  '--help',
  '-h',
]);

const intervalMin = Math.max(1, Number(argValue('--interval', '45')) || 45);
const skipFirst = process.argv.includes('--skip-first');
const noX = process.argv.includes('--no-x');
const xOnceMode = process.argv.includes('--x-once');
const wantHelp = process.argv.includes('--help') || process.argv.includes('-h');

const passthrough = process.argv.slice(2).filter((a, i, arr) => {
  if (WATCH_FLAGS.has(a)) return false;
  if (i > 0 && arr[i - 1] === '--interval') return false;
  return true;
});

const intervalMs = intervalMin * 60 * 1000;

/** @type {import('node:child_process').ChildProcess | null} */
let xChild = null;
let stopping = false;

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runNode(script, args, label) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    child.on('error', (err) => {
      console.error(`[desk] ${label} failed to start:`, err.message);
      resolve(1);
    });
    child.on('close', (code) => {
      resolve(code ?? 1);
    });
  });
}

function startXLoop() {
  if (noX || xOnceMode || xChild) return;
  console.log(`[desk] starting X poster loop…`);
  xChild = spawn(process.execPath, [X_POSTER], {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
  });
  xChild.on('error', (err) => {
    console.error('[desk] X poster failed to start:', err.message);
    xChild = null;
  });
  xChild.on('exit', (code, signal) => {
    if (stopping) return;
    console.warn(`[desk] X poster exited (code=${code ?? '?'} signal=${signal || 'none'}) — restarting in 15s`);
    xChild = null;
    setTimeout(() => {
      if (!stopping) startXLoop();
    }, 15_000);
  });
}

function stopXLoop() {
  if (!xChild || xChild.killed) {
    xChild = null;
    return;
  }
  const child = xChild;
  xChild = null;
  try {
    child.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

async function runIngest() {
  console.log(`\n──────── ${stamp()} — checking the wire ────────`);
  const code = await runNode(INGEST, passthrough, 'ingest');
  console.log(`[desk] ingest finished with code ${code} — will keep looping`);
  return code;
}

async function runXOnce() {
  if (noX) return 0;
  console.log(`\n──────── ${stamp()} — posting to X ────────`);
  const code = await runNode(X_POSTER, ['--once'], 'x:once');
  console.log(`[desk] X once finished with code ${code}`);
  return code;
}

function printHelp() {
  console.log(`MuseNews desk — ingest every N min + X poster in one process.

  npm run desk
  npm run ingest:watch
  node scripts/ingest-watch.mjs [--interval 45] [--skip-first] [--no-x] [--x-once] [--with-x] [--no-covers]

Default: ingest every 45 minutes, X poster loop running in parallel.
  --no-x       ingest only
  --x-once     after each ingest, one X share (no continuous loop)
  --interval N minutes between ingest runs (default 45)
  --skip-first wait one interval before the first ingest
  --with-x     pass through to ingest (scrape X into the wire)

Ctrl+C stops both.`);
}

async function main() {
  if (wantHelp) {
    printHelp();
    return;
  }

  const mode = noX ? 'ingest-only' : xOnceMode ? 'ingest + X once after each run' : 'ingest + X loop';
  console.log(`[desk] every ${intervalMin} min · ${mode} · Ctrl+C to stop`);
  if (passthrough.length) console.log(`[desk] ingest flags: ${passthrough.join(' ')}`);

  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[desk] stopping…`);
    stopXLoop();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  if (!noX && !xOnceMode) startXLoop();

  if (skipFirst) {
    console.log(`[desk] first ingest in ${intervalMin} min`);
    await sleep(intervalMs);
  }

  while (!stopping) {
    try {
      await runIngest();
      if (xOnceMode) await runXOnce();
    } catch (e) {
      console.error('[desk] run error:', e instanceof Error ? e.message : e);
    }
    if (stopping) break;
    const next = new Date(Date.now() + intervalMs).toISOString().replace('T', ' ').slice(0, 19);
    console.log(`[desk] next ingest at ${next} (in ${intervalMin} min)`);
    await sleep(intervalMs);
  }
}

main();
