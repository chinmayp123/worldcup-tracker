// betlog — persists the daily parlays, auto-settles each leg from final scores, and tracks
// calibration. The per-leg model probabilities (not just parlay win/loss) are what "trains"
// the model: every leg is a probability-vs-outcome data point for the calibration loop.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { summary, statMap } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG_DIR = join(HERE, "bets");
const LOG_FILE = join(LOG_DIR, "log.json");

function read() {
  try { return JSON.parse(readFileSync(LOG_FILE, "utf8")); } catch { return { days: [] }; }
}
function write(data) {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  writeFileSync(LOG_FILE, JSON.stringify(data, null, 2));
}

// append a day's bets (from generateDailyParlays). Only the straight SINGLES are tracked — the
// for-fun longshot is display-only and never logged, so the record/calibration reflect the real
// strategy. Idempotent per date — re-running the same morning replaces that date's entry.
export function recordDay(out) {
  const data = read();
  const parlays = [];
  for (const g of out.singles || []) if (g.bet) parlays.push({ type: "single", game: g.game, ...g.bet, settled: false, result: null });
  data.days = (data.days || []).filter((d) => d.date !== out.date);
  data.days.push({ date: out.date, stake: out.stake, parlays });
  data.days.sort((a, b) => a.date.localeCompare(b.date));
  write(data);
  return data;
}

// grade a single leg against a final result { hs, as, hAbbr, aAbbr, corners }.
// Returns true (hit) / false (miss) / null (can't grade — e.g. player props, or corner data missing)
function gradeLeg(leg, f) {
  if (leg.market === "Moneyline") {
    const winner = f.hs > f.as ? f.hAbbr : f.as > f.hs ? f.aAbbr : "Draw";
    return leg.pick === winner;
  }
  if (leg.market === "Total") {
    const L = parseFloat(leg.pick.replace(/[^0-9.]/g, ""));
    const total = f.hs + f.as;
    return /over/i.test(leg.pick) ? total > L : total < L;
  }
  if (leg.market === "BTTS") {
    const both = f.hs >= 1 && f.as >= 1;
    return /yes/i.test(leg.pick) ? both : !both;
  }
  if (leg.market === "Corners") {
    if (f.corners == null) return null; // corner stats not available
    const L = parseFloat(leg.pick.replace(/[^0-9.]/g, ""));
    return /over/i.test(leg.pick) ? f.corners > L : f.corners < L;
  }
  return null; // Scorer / SOT player props can't be graded from the team score
}

// settle every unsettled parlay whose games are final; grades each leg + the parlay
export async function settle() {
  const data = read();
  const cache = new Map();
  const finalOf = async (id) => {
    if (cache.has(id)) return cache.get(id);
    let res = null;
    try {
      const sum = await summary(id);
      const comp = sum.header?.competitions?.[0];
      if (comp?.status?.type?.completed) {
        const h = comp.competitors.find((c) => c.homeAway === "home");
        const a = comp.competitors.find((c) => c.homeAway === "away");
        // total corners from the box score (best-effort) so Corners legs can settle
        let corners = null;
        try {
          const teams = sum.boxscore?.teams || [];
          const hc = parseInt(statMap(teams.find((t) => t.team.id === h.team.id) || teams[0] || {}).wonCorners || 0, 10) || 0;
          const ac = parseInt(statMap(teams.find((t) => t.team.id === a.team.id) || teams[1] || {}).wonCorners || 0, 10) || 0;
          if (hc || ac) corners = hc + ac;
        } catch { /* no corner stats */ }
        res = { hs: Number(h.score), as: Number(a.score), hAbbr: h.team.abbreviation, aAbbr: a.team.abbreviation, corners };
      }
    } catch { /* not final / fetch failed */ }
    cache.set(id, res);
    return res;
  };
  for (const day of data.days || []) {
    for (const p of day.parlays) {
      if (p.settled) continue;
      let allGraded = true, allHit = true;
      for (const leg of p.legs) {
        const f = await finalOf(leg.id);
        if (!f) { allGraded = false; continue; }
        const hit = gradeLeg(leg, f);
        leg.result = hit == null ? null : hit ? "hit" : "miss";
        leg.finalScore = `${f.hAbbr} ${f.hs}-${f.as} ${f.aAbbr}`;
        if (hit === false) allHit = false;
      }
      if (allGraded) { p.settled = true; p.result = allHit ? "win" : "loss"; }
    }
  }
  write(data);
  return data;
}

// calibration + performance over a given list of logged days
function computeStats(days) {
  const legs = days.flatMap((d) => d.parlays).flatMap((p) => p.legs).filter((l) => l.result === "hit" || l.result === "miss");
  const buckets = Array.from({ length: 10 }, () => ({ n: 0, hit: 0, psum: 0 }));
  let brier = 0, hits = 0;
  for (const l of legs) {
    const o = l.result === "hit" ? 1 : 0;
    brier += (l.modelProb - o) ** 2;
    hits += o;
    const b = Math.min(9, Math.max(0, Math.floor(l.modelProb * 10)));
    buckets[b].n++; buckets[b].hit += o; buckets[b].psum += l.modelProb;
  }
  const settled = days.flatMap((d) => d.parlays).filter((p) => p.settled);
  let staked = 0, returned = 0, wins = 0;
  for (const p of settled) { staked += p.stake; if (p.result === "win") { returned += p.payout; wins++; } }
  return {
    legs: legs.length,
    legHitRate: legs.length ? hits / legs.length : null,
    brier: legs.length ? brier / legs.length : null,
    calibration: buckets.map((b, i) => ({ bucket: `${i * 10}-${i * 10 + 10}%`, n: b.n, predicted: b.n ? b.psum / b.n : null, actual: b.n ? b.hit / b.n : null })).filter((b) => b.n > 0),
    parlays: settled.length, parlayWins: wins, staked, returned, profit: returned - staked,
    roi: staked ? (returned - staked) / staked : null,
  };
}

// all-time calibration + performance across everything settled
export function stats() { return computeStats(read().days || []); }

// rolling window: stats over just the most recent `nDays` logged days, so a single old lucky
// hit stops skewing the picture as more data comes in. Includes the date range it covers.
export function statsRecent(nDays = 7) {
  const days = (read().days || []).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, nDays);
  return { ...computeStats(days), windowDays: days.length, from: days[days.length - 1]?.date || null, to: days[0]?.date || null };
}

export function readLog() { return read(); }
