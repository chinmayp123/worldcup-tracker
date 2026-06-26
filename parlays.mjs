// parlays — daily $10 STRAIGHT-SINGLES generator for the FanDuel bankroll experiment.
//
// For each upcoming game it builds candidate legs (moneyline + total + corners + BTTS + scorer)
// from the model's probabilities priced against real FanDuel odds, then bets the single best
// in-band leg per game as a STRAIGHT SINGLE. Singles are the tracked card: they let a real edge
// express itself instead of compounding the book's margin across correlated same-game legs. A
// single cross-game longshot (one leg per game) is still produced, but purely "for fun" — it is
// NOT logged or settled.
//
// WHY SINGLES: a 3-leg same-game parlay multiplies both the model's probabilities AND its errors,
// and the legs are correlated (Under + Draw + BTTS-No all die together when a game runs hot), so
// the parlay concentrates risk instead of spreading it. Singles fix the structurally-low hit rate.
//
// WHY THE EDGE BAND: every leg's edge is measured vs the real FanDuel price. Below EDGE_MIN there's
// no value; at/above EDGE_MAX the "edge" is almost certainly model error against a sharp market, so
// the leg is DISCARDED (the old model capped these and then bet them — and ranked by edge, so it
// picked the biggest model errors first). MAX_EDGE now only shrinks the prob used for EV/Kelly.

import { scoreboardOn, ymd, summary, scorePrediction, pregameProjections, matchConditions, poissonCdf } from "./lib.mjs";
import { fotmobXG, fotmobPlayerSOT } from "./fotmob.mjs";
import { actionPublicBetting } from "./actionnetwork.mjs";
import { fanduelCorners, fanduelBTTS, fanduelProps } from "./fanduel.mjs";
import { oddspapiCorners, oddspapiBTTS } from "./oddspapi.mjs";

const amToDec = (ml) => (ml == null ? null : ml > 0 ? ml / 100 + 1 : 100 / -ml + 1);
const decToAm = (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));
const fmtAm = (ml) => (ml == null ? "-" : ml > 0 ? `+${ml}` : `${ml}`);
// believable BAND for a single leg's edge vs the real market price. Below EDGE_MIN there's no
// real value worth betting; at/above EDGE_MAX the disagreement with a sharp book is almost
// certainly model error, so the leg is discarded (NOT bet). Selection now lives entirely in this
// band — we no longer rank by edge and pick the biggest disagreement first.
const EDGE_MIN = 0.03;
const EDGE_MAX = 0.07;
// MAX_EDGE only shrinks the probability used for EV/Kelly so a wildly over-confident model number
// can't inflate the math. It no longer drives selection (the band does). Kept below EDGE_MAX so
// in-band legs near the top of the band still get a conservative prob.
const MAX_EDGE = 0.05;
// a Draw is allowed back into the card (even when it isn't the predicted result) only if its raw
// edge clears this — i.e. a real value draw, not every coin-flip. Must still pass the band above.
const DRAW_MIN_EDGE = 0.05;

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

  // the model's central prediction, used to tag each leg as coherent (agrees with the predicted
  // game script) or not. We never bet against our own prediction: no underdog ML, no Over when
  // the model leans Under, etc.
  const lamT = pred.expH + pred.expA;
  const mainLine = fd.total && fd.total.line != null ? fd.total.line : 2.5;
  const pOverMain = 1 - poissonCdf(Math.floor(mainLine), lamT);
  const mlFav = pred.wH >= pred.wD && pred.wH >= pred.wA ? h.team.abbreviation
    : pred.wA >= pred.wD ? a.team.abbreviation : "Draw";
  const totalFav = pOverMain >= 0.5 ? "Over" : "Under";
  const bttsFav = (pred.pBTTS ?? 0) >= 0.5 ? "Yes" : "No";

  // Action Network sharp signal: when the public is piling tickets on a side but the money lags
  // there (sharper/bigger bets lean elsewhere), that side is flagged `fade`. We won't bet a
  // moneyline the sharps are fading — using the splits we already fetch, not just the model.
  const fade = publicBetting?.fade; // { publicSide, sharpSide } | null
  const mlSideKey = (pick) => (pick === h.team.abbreviation ? "home" : pick === a.team.abbreviation ? "away" : "draw");
  const fadePublic = (pick) => !!(fade && mlSideKey(pick) === fade.publicSide);

  const cands = [];
  // push a candidate leg. `group` is what pickMix dedupes on (one per group). The edge is SHRUNK
  // toward the market at MAX_EDGE, and modelProb is the shrunk probability, so a wildly
  // over-confident model number can't inflate selection, EV, or Kelly. `coherent` marks whether
  // the leg agrees with the model's predicted script; `fadePublic` flags a side sharps are fading.
  const pushLeg = (market, pick, rawProb, ml, group, coherent, fade = false) => {
    const dec = amToDec(ml);
    if (dec == null || rawProb == null) return;
    const impl = 1 / dec;
    const rawEdge = rawProb - impl; // uncapped: this is what selection's band is judged on
    const edge = Math.sign(rawEdge) * Math.min(Math.abs(rawEdge), MAX_EDGE); // capped, for EV/Kelly only
    cands.push({ id: ev.id, game, market, pick, group, modelProb: impl + edge, ml, dec, impl, edge, rawEdge, coherent, fadePublic: fade });
  };

  pushLeg("Moneyline", h.team.abbreviation, pred.wH, fd.home?.ml, "Moneyline", h.team.abbreviation === mlFav, fadePublic(h.team.abbreviation));
  pushLeg("Moneyline", "Draw", pred.wD, fd.draw?.ml, "Moneyline", mlFav === "Draw", fadePublic("Draw"));
  pushLeg("Moneyline", a.team.abbreviation, pred.wA, fd.away?.ml, "Moneyline", a.team.abbreviation === mlFav, fadePublic(a.team.abbreviation));
  // value-draw exception: a Draw isn't usually the predicted result, but if the model's draw
  // probability clears the price by a real margin, let it back in (underdog TEAM MLs stay out).
  const drawLeg = cands.find((l) => l.group === "Moneyline" && l.pick === "Draw");
  if (drawLeg && drawLeg.rawEdge >= DRAW_MIN_EDGE) drawLeg.coherent = true;
  if (fd.total && fd.total.line != null) {
    const L = fd.total.line, pOver = 1 - poissonCdf(Math.floor(L), lamT);
    pushLeg("Total", `Over ${L}`, pOver, fd.total.over, "Total", totalFav === "Over");
    pushLeg("Total", `Under ${L}`, 1 - pOver, fd.total.under, "Total", totalFav === "Under");
  }

  // anytime-scorer legs: our opponent-adjusted xG model vs FanDuel's REAL anytime price — a
  // genuine model-vs-market edge, same approach as corners/BTTS. All matched scorers share the
  // "Scorer" group, so pickMix takes only the single best-edge scorer (no stacking longshots).
  try {
    const fdProps = await fanduelProps(homeRef, awayRef);
    if (fdProps?.scorers?.length) {
      const [hp, ap] = await Promise.all([fotmobPlayerSOT(homeRef, awayRef), fotmobPlayerSOT(awayRef, homeRef)]);
      const model = [...(hp || []), ...(ap || [])];
      const nrm = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");
      const lastTok = (s) => nrm((s || "").split(/\s+/).filter(Boolean).pop());
      const modelFor = (name) => model.find((p) => {
        const a = nrm(name), b = nrm(p.name); if (!a || !b) return false;
        return a === b || a.includes(lastTok(p.name)) || b.includes(lastTok(name));
      });
      for (const s of fdProps.scorers) {
        const mp = modelFor(s.player);
        if (mp && s.ml != null) pushLeg("Scorer", `${s.player} anytime`, mp.scoreProb, s.ml, "Scorer", true);
      }
    }
  } catch { /* no scorer market / no model — parlay falls back to its other legs */ }

  // real total-corners line (OddsPapi multi-book, FanDuel public API as fallback) vs our
  // INDEPENDENT corner projection (recent form -> Poisson) — model-vs-market edge
  try {
    const fdc = (await oddspapiCorners(homeRef, awayRef)) || (await fanduelCorners(homeRef, awayRef));
    if (fdc && fdc.line != null && priors?.corners?.total != null) {
      const pOver = 1 - poissonCdf(Math.floor(fdc.line), priors.corners.total);
      pushLeg("Corners", `Over ${fdc.line}`, pOver, fdc.over, "Corners", pOver >= 0.5);
      pushLeg("Corners", `Under ${fdc.line}`, 1 - pOver, fdc.under, "Corners", pOver < 0.5);
    }
  } catch { /* no corner market posted — fine */ }

  // real both-teams-to-score price (OddsPapi multi-book, FanDuel fallback) vs the model's
  // INDEPENDENT pBTTS (P(home scores) x P(away scores))
  try {
    const btts = (await oddspapiBTTS(homeRef, awayRef)) || (await fanduelBTTS(homeRef, awayRef));
    if (btts && btts.yes != null && pred.pBTTS != null) {
      pushLeg("BTTS", "Yes", pred.pBTTS, btts.yes, "BTTS", bttsFav === "Yes");
      if (btts.no != null) pushLeg("BTTS", "No", 1 - pred.pBTTS, btts.no, "BTTS", bttsFav === "No");
    }
  } catch { /* no BTTS market — fine */ }

  return { id: ev.id, game, date: ev.date, candidates: cands };
}

// is a leg worth betting at all? It must (a) AGREE with the model's predicted side (coherent),
// (b) NOT be a side the sharps are fading, and (c) sit inside the believable edge band — big
// disagreements (>= EDGE_MAX) are discarded as model error rather than bet as value.
function bettable(l) {
  return l.coherent && !l.fadePublic && l.rawEdge >= EDGE_MIN && l.rawEdge < EDGE_MAX;
}

// the single best bettable leg for a game, ranked by hit probability (steadiest bet — this is
// what we stake as a straight single), or null if the game has no qualifying leg.
function bestSingle(cands) {
  return cands.filter(bettable).sort((a, b) => b.modelProb - a.modelProb)[0] || null;
}

// the longest-priced bettable leg for a game (for the for-fun cross-game longshot), or null
function longLeg(cands) {
  return cands.filter(bettable).sort((a, b) => b.dec - a.dec)[0] || null;
}

// plain-English reason a leg was chosen, from its market, pick and (capped) edge vs the price
function legReason(l) {
  const mp = Math.round(l.modelProb * 100), im = Math.round(l.impl * 100), e = Math.round(l.edge * 100);
  const tag =
    l.group === "Moneyline" ? (l.pick === "Draw" ? "value draw — model rates it well above the price" : "backing the model's projected winner")
    : l.group === "Total" ? (/under/i.test(l.pick) ? "model projects a low-scoring game" : "model projects an open, high-scoring game")
    : l.group === "Corners" ? (/under/i.test(l.pick) ? "model projects few corners" : "model projects plenty of corners")
    : l.group === "BTTS" ? (/yes/i.test(l.pick) ? "model expects both teams to score" : "model expects at least one clean sheet")
    : l.group === "Scorer" ? "model rates this scorer above the price (opponent-adjusted xG)"
    : "positive-edge spot";
  return `${tag} — model ${mp}% vs market ${im}% (${e >= 0 ? "+" : ""}${e}% edge)`;
}

// roll legs into a parlay with model prob, payout, EV and a capped half-Kelly stake fraction
function buildParlay(legs, stake) {
  if (!legs.length) return null;
  const dec = legs.reduce((p, l) => p * l.dec, 1);
  const modelProb = legs.reduce((p, l) => p * l.modelProb, 1); // independence approximation
  const payout = stake * dec;
  const ev = stake * (modelProb * dec - 1);
  const b = dec - 1;
  const kelly = b > 0 ? Math.min(0.05, Math.max(0, (b * modelProb - (1 - modelProb)) / b / 2)) : 0;
  const rationale = legs.length > 1
    ? `${legs.length} positive-edge legs, each siding with the model; combined ${Math.round(modelProb * 100)}% to hit.`
    : `single positive-edge leg; ${Math.round(modelProb * 100)}% to hit.`;
  return {
    legs: legs.map((l) => ({ id: l.id, game: l.game, market: l.market, pick: l.pick, modelProb: l.modelProb, ml: l.ml, edge: l.edge, why: legReason(l) })),
    dec, americanOdds: decToAm(dec), modelProb, stake, payout, ev, kelly, rationale,
  };
}

// betting "day": a game that kicks off before BETTING_DAY_CUTOFF_HRS (local) belongs to the
// PREVIOUS calendar day's slate — e.g. a 12:00am Tue kickoff is bet as part of Monday's card.
// We shift the kickoff back by the cutoff, then take the local date.
const BETTING_DAY_CUTOFF_HRS = 6;
const localDay = (d) => {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
};
const bettingDay = (d) => localDay(new Date(d).getTime() - BETTING_DAY_CUTOFF_HRS * 3600 * 1000);

// the day's card: one straight SINGLE per upcoming game (the best in-band leg), plus one for-fun
// cross-game longshot. The slate spans this calendar day plus tomorrow's post-midnight kickoffs
// (before the cutoff), so a "technically tomorrow" 12am game is bet today, not on tomorrow's card.
// `events` overrides the source (used for testing / a specific day's slate) — no day filter then.
export async function generateDailyParlays(stake = 10, events = null) {
  const slate = bettingDay(Date.now());
  let pool;
  if (events) {
    pool = events;
  } else {
    // today + tomorrow's boards so post-midnight games that belong to today's slate are visible
    const boards = await Promise.all([
      scoreboardOn(ymd(0)).catch(() => ({ events: [] })),
      scoreboardOn(ymd(1)).catch(() => ({ events: [] })),
    ]);
    const seen = new Set();
    pool = [];
    for (const b of boards) for (const e of b.events || []) {
      if (seen.has(e.id) || bettingDay(e.date) !== slate) continue;
      seen.add(e.id);
      pool.push(e);
    }
  }
  const upcoming = pool.filter((e) => e.competitions[0].status.type.state === "pre");
  const games = [];
  for (const ev of upcoming) {
    const ml = await matchLegs(ev).catch(() => null);
    if (ml && ml.candidates.length) games.push(ml);
  }
  // PRIMARY (tracked): one straight single per game — the best in-band leg, staked on its own so
  // a real edge can play out instead of compounding the book's margin across correlated legs.
  const singles = games
    .map((g) => { const l = bestSingle(g.candidates); return l ? { game: g.game, date: g.date, bet: buildParlay([l], stake) } : null; })
    .filter(Boolean);
  // FOR FUN (NOT tracked / not logged): one cross-game longshot — the longest-priced in-band leg
  // per game, across DIFFERENT games so the legs are uncorrelated. Max payout, low hit rate.
  const longLegs = games.map((g) => longLeg(g.candidates)).filter(Boolean);
  const longshot = longLegs.length >= 2 ? buildParlay(longLegs, stake) : null;
  return { date: events ? bettingDay(events?.[0]?.date || Date.now()) : slate, stake, singles, longshot };
}

// a readable (ASCII-safe) text block for the morning routine / log
export function formatParlays(out) {
  const pct = (p) => `${Math.round(p * 100)}%`;
  const legLine = (l) => [
    `    - ${l.game} | ${l.market}: ${l.pick} (${fmtAm(l.ml)}, model ${pct(l.modelProb)}, edge ${l.edge >= 0 ? "+" : ""}${Math.round(l.edge * 100)}%)`,
    `        why: ${l.why}`,
  ].join("\n");
  const betBlock = (title, p) => {
    if (!p) return `${title}: (no qualifying bet)`;
    const k = p.kelly > 0.002 ? `Kelly ${(p.kelly * 100).toFixed(1)}% of bankroll` : "Kelly: skip (-EV)";
    return [
      `${title}  ${fmtAm(p.americanOdds)}  ($${p.stake} -> $${p.payout.toFixed(2)})`,
      ...p.legs.map(legLine),
      `    model ${pct(p.modelProb)} to hit | model EV ${p.ev >= 0 ? "+" : ""}$${p.ev.toFixed(2)} | ${k}`,
    ].join("\n");
  };
  const lines = [`World Cup singles | ${out.date} | $${out.stake} each`, ""];
  if (!out.singles.length) lines.push("(no qualifying single-leg bets on this slate)", "");
  for (const g of out.singles) lines.push(betBlock(`> ${g.game}`, g.bet), "");
  if (out.longshot) lines.push("--- for fun (not tracked) ---", "", betBlock("> LONGSHOT (one leg per game, max payout)", out.longshot));
  return lines.join("\n");
}
