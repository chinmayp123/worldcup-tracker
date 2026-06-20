#!/usr/bin/env node
// morning — the daily routine: settle yesterday's parlays, generate today's $10 parlays,
// log them, and print everything. Run by the cloud schedule each morning (and by hand any time).
//
//   node morning.mjs            generate + log + settle, print parlays and the running record
//   node morning.mjs --stats    just print the calibration / performance summary

import { generateDailyParlays, formatParlays } from "./parlays.mjs";
import { recordDay, settle, stats } from "./betlog.mjs";

const pct = (p) => (p == null ? "—" : `${Math.round(p * 100)}%`);

function printStats() {
  const s = stats();
  console.log("\n=== Record (model training) ===");
  console.log(`Legs settled: ${s.legs} · leg hit rate: ${pct(s.legHitRate)} · Brier: ${s.brier == null ? "—" : s.brier.toFixed(3)} (lower = better calibrated)`);
  console.log(`Parlays: ${s.parlays} (${s.parlayWins} won) · staked $${s.staked} · returned $${s.returned.toFixed(2)} · profit $${s.profit.toFixed(2)} · ROI ${pct(s.roi)}`);
  if (s.calibration.length) {
    console.log("Calibration (model says X% → actually hit Y%):");
    for (const b of s.calibration) console.log(`  ${b.bucket}: predicted ${pct(b.predicted)} vs actual ${pct(b.actual)}  (n=${b.n})`);
  }
}

async function main() {
  if (process.argv.includes("--stats")) { printStats(); return; }
  // settle anything that finished since the last run, then build + log today's slate
  await settle().catch(() => {});
  const out = await generateDailyParlays(10);
  recordDay(out);
  console.log(formatParlays(out));
  if (!out.perGame.length) console.log("(no upcoming games with FanDuel odds posted yet)");
  printStats();
}

main();
