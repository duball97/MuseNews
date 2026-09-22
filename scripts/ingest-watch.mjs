#!/usr/bin/env node
/**
 * Leave this running — pulls MuseBook and prints a new edition on a timer.
 *
 *   npm run ingest:watch
 *   node scripts/ingest-watch.mjs
 *   node scripts/ingest-watch.mjs --interval 45
 *   node scripts/ingest-watch.mjs --no-covers
 *   node scripts/ingest-watch.mjs --skip-first   # wait before the first run
 *
 * Ctrl+C to stop. Extra flags after -- are passed to ingest-musebook.mjs.
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INGEST = join(ROOT, 'scripts', 'ingest-musebook.mjs');

function argValue(flag, fallback) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return fallback;
  return process.argv[i + 1];
}

const intervalMin = Math.max(1, Number(argValue('--interval', '45')) || 45);
const skipFirst = process.argv.includes('--skip-first');
const passthrough = process.argv
  .slice(2)
  .filter((a, i, arr) => {
    if (a === '--interval' || a === '--skip-first') return false;
    if (i > 0 && arr[i - 1] === '--interval') return false;
    return true;
  });

const intervalMs = intervalMin * 60 * 1000;

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runIngest() {
  return new Promise((resolve) => {
    console.log(`\n──────── ${stamp()} — checking the wire ────────`);
    const child = spawn(process.execPath, [INGEST, ...passthrough], {
      cwd: ROOT,
      env: process.env,
      stdio: 'inherit',
    });
    child.on('error', (err) => {
      console.error('[ingest:watch] failed to start ingest:', err.message);
      resolve(1);
    });
    child.on('close', (code) => {
      console.log(`[ingest:watch] finished with code ${code ?? 1} — will keep looping`);
      resolve(code ?? 1);
    });
  });
}

async function main() {
  console.log(`[ingest:watch] every ${intervalMin} min · Ctrl+C to stop`);
  if (passthrough.length) console.log(`[ingest:watch] flags: ${passthrough.join(' ')}`);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[ingest:watch] stopping…`);
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  if (skipFirst) {
    console.log(`[ingest:watch] first run in ${intervalMin} min`);
    await sleep(intervalMs);
  }

  while (!stopping) {
    try {
      await runIngest();
    } catch (e) {
      console.error('[ingest:watch] run error:', e instanceof Error ? e.message : e);
    }
    if (stopping) break;
    const next = new Date(Date.now() + intervalMs).toISOString().replace('T', ' ').slice(0, 19);
    console.log(`[ingest:watch] next check at ${next} (in ${intervalMin} min)`);
    await sleep(intervalMs);
  }
}

main();
