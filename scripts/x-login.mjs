#!/usr/bin/env node
/**
 * One-time X login for MuseNews wire (same Chrome profile as x-search-wire).
 *
 *   npm run x:login
 */
import { runLogin } from './x-search-wire.mjs';

runLogin().catch((err) => {
  console.error('[x:login] fatal', err);
  process.exit(1);
});
