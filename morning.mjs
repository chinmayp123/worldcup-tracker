#!/usr/bin/env node
// morning — the daily routine: settle yesterday's parlays, generate today's $10 parlays,
// log them, and print everything. Run by the cloud schedule each morning (and by hand any time).
//
//   node morning.mjs            generate + log + settle, print parlays and the running record
//   node morning.mjs --stats    just print the calibration / performance summary

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateDailyParlays, formatParlays } from "./parlays.mjs";
import { recordDay, settle, stats } from "./betlog.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_FILE = join(HERE, "bets", "latest.txt");
const pct = (p) => (p == null ? "-" : `${Math.round(p * 100)}%`);

function statsBlock() {
  const s = stats();
  const lines = ["", "=== Record (model training) ==="];
  lines.push(`Legs settled: ${s.legs} | leg hit rate: ${pct(s.legHitRate)} | Brier: ${s.brier == null ? "-" : s.brier.toFixed(3)} (lower = better calibrated)`);
  lines.push(`Parlays: ${s.parlays} (${s.parlayWins} won) | staked $${s.staked} | returned $${s.returned.toFixed(2)} | profit $${s.profit.toFixed(2)} | ROI ${pct(s.roi)}`);
  if (s.calibration.length) {
    lines.push("Calibration (model says X% -> actually hit Y%):");
    for (const b of s.calibration) lines.push(`  ${b.bucket}: predicted ${pct(b.predicted)} vs actual ${pct(b.actual)}  (n=${b.n})`);
  }
  return lines.join("\n");
}

async function main() {
  if (process.argv.includes("--stats")) { console.log(statsBlock()); return; }
  // settle anything that finished since the last run, then build + log today's slate
  await settle().catch(() => {});
  const out = await generateDailyParlays(10);
  recordDay(out);
  const text = [
    `Generated ${new Date().toLocaleString()}`,
    "",
    formatParlays(out),
    out.singles.length ? "" : "(no upcoming games with FanDuel odds posted yet)",
    statsBlock(),
  ].join("\n");
  console.log(text);
  try { if (!existsSync(dirname(OUT_FILE))) mkdirSync(dirname(OUT_FILE), { recursive: true }); writeFileSync(OUT_FILE, text); } catch { /* ignore */ }
}

main();
