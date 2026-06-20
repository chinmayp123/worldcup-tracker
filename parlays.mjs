// parlays — daily $10 parlay generator for the FanDuel bankroll experiment.
//
// For each upcoming game it builds candidate legs (moneyline + total) from the model's
// probabilities priced against real FanDuel odds, assembles a balanced same-game parlay per
// game, plus one cross-game parlay (best leg per game). Every leg carries the model probability
// so the bet log can settle each leg individually and feed the calibration loop.
//
// HONEST NOTE: parlays compound the book's margin, so most are -EV even when legs have small
// edges — Kelly will often say "skip". Same-game parlay odds here MULTIPLY leg prices as an
// estimate; FanDuel's actual SGP price is correlation-adjusted and will be shorter.

import { scoreboard, summary, scorePrediction, pregameProjections, matchConditions, poissonCdf } from "./lib.mjs";
import { fotmobXG } from "./fotmob.mjs";
import { actionPublicBetting } from "./actionnetwork.mjs";

const amToDec = (ml) => (ml == null ? null : ml > 0 ? ml / 100 + 1 : 100 / -ml + 1);
const decToAm = (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));
const fmtAm = (ml) => (ml == null ? "-" : ml > 0 ? `+${ml}` : `${ml}`);

// candidate legs for one event: each { game, market, pick, modelProb, ml, dec, impl, edge }
async function matchLegs(ev) {
  const comp = ev.competitions[0];
  const h = comp.competitors.find((t) => t.homeAway === "home");
  const a = comp.competitors.find((t) => t.homeAway === "away");
  const homeRef = { name: h.team.displayName, abbr: h.team.abbreviation };
  const awayRef = { name: a.team.displayName, abbr: a.team.abbreviation };
  const game = `${h.team.abbreviation} v ${a.team.abbreviation}`;
  const sum = await summary(ev.id);
  const [publicBetting, priors, conditions] = await Promise.all([
    actionPublicBetting(homeRef, awayRef),
    pregameProjections(homeRef, awayRef),
    matchConditions(ev, homeRef, awayRef),
  ]);
  const pred = scorePrediction(ev, sum, null, null, priors?.xgPrior, conditions?.tilt);
  const fd = publicBetting?.fanduel;
  if (!pred || !fd) return null;

  const cands = [];
  const addLeg = (market, pick, prob, ml) => {
    const dec = amToDec(ml);
    if (dec == null || prob == null) return;
    cands.push({ id: ev.id, game, market, pick, modelProb: prob, ml, dec, impl: 1 / dec, edge: prob - 1 / dec });
  };
  addLeg("Moneyline", h.team.abbreviation, pred.wH, fd.home?.ml);
  addLeg("Moneyline", "Draw", pred.wD, fd.draw?.ml);
  addLeg("Moneyline", a.team.abbreviation, pred.wA, fd.away?.ml);
  if (fd.total && fd.total.line != null) {
    const L = fd.total.line, lamT = pred.expH + pred.expA;
    const pOver = 1 - poissonCdf(Math.floor(L), lamT);
    addLeg("Total", `Over ${L}`, pOver, fd.total.over);
    addLeg("Total", `Under ${L}`, 1 - pOver, fd.total.under);
  }
  return { id: ev.id, game, date: ev.date, candidates: cands };
}

// a balanced mix: best positive-edge leg + most-confident leg, max one leg per market
function pickMix(cands, n = 2) {
  const byEdge = [...cands].sort((x, y) => y.edge - x.edge);
  const byConf = [...cands].sort((x, y) => y.modelProb - x.modelProb);
  const picks = [], markets = new Set();
  const add = (l) => { if (l && !markets.has(l.market)) { picks.push(l); markets.add(l.market); } };
  add(byEdge.find((l) => l.edge > 0) || byEdge[0]); // value (or least-bad)
  add(byConf[0]);                                    // confidence, different market
  for (const l of byEdge) { if (picks.length >= n) break; add(l); }
  return picks.slice(0, n);
}

// roll legs into a parlay with model prob, payout, EV and a capped half-Kelly stake fraction
function buildParlay(legs, stake) {
  const dec = legs.reduce((p, l) => p * l.dec, 1);
  const modelProb = legs.reduce((p, l) => p * l.modelProb, 1); // independence approximation
  const payout = stake * dec;
  const ev = stake * (modelProb * dec - 1);
  const b = dec - 1;
  const kelly = b > 0 ? Math.min(0.05, Math.max(0, (b * modelProb - (1 - modelProb)) / b / 2)) : 0;
  return {
    legs: legs.map((l) => ({ id: l.id, game: l.game, market: l.market, pick: l.pick, modelProb: l.modelProb, ml: l.ml, edge: l.edge })),
    dec, americanOdds: decToAm(dec), modelProb, stake, payout, ev, kelly,
  };
}

// the day's parlays: one same-game parlay per upcoming game + one cross-game parlay.
// `events` overrides the source (used for testing / looking at a specific day's slate).
export async function generateDailyParlays(stake = 10, events = null) {
  const sb = events ? { events } : await scoreboard();
  const upcoming = (sb.events || []).filter((e) => e.competitions[0].status.type.state === "pre");
  const games = [];
  for (const ev of upcoming) {
    const ml = await matchLegs(ev).catch(() => null);
    if (ml && ml.candidates.length) games.push(ml);
  }
  const perGame = games.map((g) => ({ game: g.game, date: g.date, parlay: buildParlay(pickMix(g.candidates, 2), stake) }));
  const crossLegs = games.map((g) => [...g.candidates].sort((x, y) => y.edge - x.edge)[0]).filter(Boolean);
  const cross = crossLegs.length >= 2 ? buildParlay(crossLegs, stake) : null;
  return { date: new Date(sb.events?.[0]?.date || Date.now()).toISOString().slice(0, 10), stake, perGame, cross };
}

// a readable text block for the morning routine / log
export function formatParlays(out) {
  const pct = (p) => `${Math.round(p * 100)}%`;
  const legLine = (l) => `    • ${l.game} — ${l.market}: ${l.pick} (${fmtAm(l.ml)}, model ${pct(l.modelProb)}, edge ${l.edge >= 0 ? "+" : ""}${Math.round(l.edge * 100)}%)`;
  const parBlock = (title, p) => {
    if (!p) return `${title}: (not enough games)`;
    const k = p.kelly > 0.002 ? `Kelly ${(p.kelly * 100).toFixed(1)}% of bankroll` : "Kelly: skip (−EV)";
    return [
      `${title}  ${fmtAm(p.americanOdds)}  ($${p.stake} → $${p.payout.toFixed(2)})`,
      ...p.legs.map(legLine),
      `    combined model ${pct(p.modelProb)} · model EV ${p.ev >= 0 ? "+" : ""}$${p.ev.toFixed(2)} · ${k}`,
    ].join("\n");
  };
  const lines = [`World Cup parlays · ${out.date} · $${out.stake} each`, ""];
  for (const g of out.perGame) lines.push(parBlock(`▸ ${g.game}`, g.parlay), "");
  lines.push(parBlock("▸ ALL GAMES (one leg each)", out.cross));
  return lines.join("\n");
}
