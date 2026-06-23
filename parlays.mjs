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

import { scoreboardOn, ymd, summary, scorePrediction, pregameProjections, matchConditions, poissonCdf } from "./lib.mjs";
import { fotmobXG, fotmobPlayerSOT } from "./fotmob.mjs";
import { actionPublicBetting } from "./actionnetwork.mjs";
import { fanduelCorners, fanduelBTTS, fanduelProps } from "./fanduel.mjs";
import { oddspapiCorners, oddspapiBTTS } from "./oddspapi.mjs";

const amToDec = (ml) => (ml == null ? null : ml > 0 ? ml / 100 + 1 : 100 / -ml + 1);
const decToAm = (d) => (d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1)));
const fmtAm = (ml) => (ml == null ? "-" : ml > 0 ? `+${ml}` : `${ml}`);
// believable ceiling on a single-leg edge. A double-digit edge on a major market is model error,
// not free money — we shrink anything past this toward the market price (see pushLeg).
const MAX_EDGE = 0.10;
// a Draw is allowed back into the card (even when it isn't the predicted result) only if its
// capped edge clears this — i.e. a real value draw like 6/20's +700 ECU, not every coin-flip.
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
    const edge = Math.sign(rawProb - impl) * Math.min(Math.abs(rawProb - impl), MAX_EDGE);
    cands.push({ id: ev.id, game, market, pick, group, modelProb: impl + edge, ml, dec, impl, edge, coherent, fadePublic: fade });
  };

  pushLeg("Moneyline", h.team.abbreviation, pred.wH, fd.home?.ml, "Moneyline", h.team.abbreviation === mlFav, fadePublic(h.team.abbreviation));
  pushLeg("Moneyline", "Draw", pred.wD, fd.draw?.ml, "Moneyline", mlFav === "Draw", fadePublic("Draw"));
  pushLeg("Moneyline", a.team.abbreviation, pred.wA, fd.away?.ml, "Moneyline", a.team.abbreviation === mlFav, fadePublic(a.team.abbreviation));
  // value-draw exception: a Draw isn't usually the predicted result, but if the model's draw
  // probability clears the price by a real margin, let it back in (underdog TEAM MLs stay out).
  const drawLeg = cands.find((l) => l.group === "Moneyline" && l.pick === "Draw");
  if (drawLeg && drawLeg.edge >= DRAW_MIN_EDGE) drawLeg.coherent = true;
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

// can two legs both be true in one match outcome? The only real clash is BTTS Yes (needs >= 2
// goals) against a low Under line. Underdog ML + Under, ML + corners, etc. are all satisfiable.
function legConflict(a, b) {
  const isBTTSyes = (l) => l.group === "BTTS" && /yes/i.test(l.pick);
  const underLine = (l) => (l.group === "Total" && /under/i.test(l.pick)) ? parseFloat(l.pick.replace(/[^0-9.]/g, "")) : null;
  for (const [x, y] of [[a, b], [b, a]]) if (isBTTSyes(x)) { const u = underLine(y); if (u != null && u < 2) return true; }
  return false;
}

// legs for a same-game parlay: only legs that (a) AGREE with the model's predicted side
// (coherent — favoured ML / favoured total etc.), (b) carry a positive capped edge, and (c) the
// sharps aren't fading; ranked by edge, one per group, no impossible combos. Tightened toward
// favourites: higher hit rate, smaller payouts, no bare draw / underdog longshots.
function pickMix(cands, n = 3) {
  const ok = cands.filter((l) => l.coherent && l.edge > 0 && !l.fadePublic).sort((a, b) => b.edge - a.edge);
  const picks = [], groups = new Set();
  for (const l of ok) {
    if (picks.length >= n) break;
    if (groups.has(l.group) || picks.some((p) => legConflict(p, l))) continue;
    picks.push(l); groups.add(l.group);
  }
  return picks;
}

// the best single coherent, positive-edge leg for a game (for the cross-game parlay), or null
function bestLeg(cands) {
  return cands.filter((l) => l.coherent && l.edge > 0 && !l.fadePublic).sort((a, b) => b.edge - a.edge)[0] || null;
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

// the day's parlays: one same-game parlay per upcoming game on today's betting slate + one
// cross-game parlay. The slate spans this calendar day plus tomorrow's post-midnight kickoffs
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
  // up to 3 +edge legs per same-game parlay (underdogs allowed); skip games with no qualifying leg
  const perGame = games
    .map((g) => ({ game: g.game, date: g.date, parlay: buildParlay(pickMix(g.candidates, 3), stake) }))
    .filter((g) => g.parlay);
  // cross-game "value": the best-edge +edge leg per game (needs >= 2 games to be a parlay)
  const crossLegs = games.map((g) => bestLeg(g.candidates)).filter(Boolean);
  const cross = crossLegs.length >= 2 ? buildParlay(crossLegs, stake) : null;
  // cross-game "longshot": the LONGEST-PRICED +edge leg per game — max payout, lower hit rate.
  // This is the swing-for-the-fences ticket (still gated on a real, capped edge per leg).
  const longLegs = games.map((g) => {
    const pos = g.candidates.filter((l) => l.coherent && l.edge > 0 && !l.fadePublic);
    return pos.length ? pos.slice().sort((a, b) => b.dec - a.dec)[0] : null;
  }).filter(Boolean);
  let longshot = longLegs.length >= 2 ? buildParlay(longLegs, stake) : null;
  // don't show the longshot if it's the same ticket as the value cross
  if (longshot && cross && longshot.legs.length === cross.legs.length &&
      longshot.legs.every((l, i) => l.game === cross.legs[i].game && l.pick === cross.legs[i].pick)) longshot = null;
  return { date: events ? bettingDay(events?.[0]?.date || Date.now()) : slate, stake, perGame, cross, longshot };
}

// a readable (ASCII-safe) text block for the morning routine / log
export function formatParlays(out) {
  const pct = (p) => `${Math.round(p * 100)}%`;
  const legLine = (l) => [
    `    - ${l.game} | ${l.market}: ${l.pick} (${fmtAm(l.ml)}, model ${pct(l.modelProb)}, edge ${l.edge >= 0 ? "+" : ""}${Math.round(l.edge * 100)}%)`,
    `        why: ${l.why}`,
  ].join("\n");
  const parBlock = (title, p) => {
    if (!p) return `${title}: (not enough games)`;
    const k = p.kelly > 0.002 ? `Kelly ${(p.kelly * 100).toFixed(1)}% of bankroll` : "Kelly: skip (-EV)";
    return [
      `${title}  ${fmtAm(p.americanOdds)}  ($${p.stake} -> $${p.payout.toFixed(2)})`,
      ...p.legs.map(legLine),
      `    combined model ${pct(p.modelProb)} | model EV ${p.ev >= 0 ? "+" : ""}$${p.ev.toFixed(2)} | ${k}`,
    ].join("\n");
  };
  const lines = [`World Cup parlays | ${out.date} | $${out.stake} each`, ""];
  for (const g of out.perGame) lines.push(parBlock(`> ${g.game}`, g.parlay), "");
  lines.push(parBlock("> ALL GAMES (best value, one leg each)", out.cross));
  if (out.longshot) lines.push("", parBlock("> LONGSHOT (max payout, one leg each)", out.longshot));
  return lines.join("\n");
}
