// lib — shared data + model layer for the World Cup tracker.
// Both the CLI (worldcup.mjs) and the desktop widget (widget/) import from here, so the
// fetching, odds, predictions, keeper-saves model, and betting reads live in ONE place.
// Everything here returns plain data — no terminal ANSI, no DOM — so any front end can use it.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

export const BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world";
const SPORT_BASE = "https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup";
const ODDS_BASE = `${SPORT_BASE}/odds`;

// Optional live-odds key (The Odds API). Read from env or a gitignored config file next to
// this module — never hard-coded, so the public repo stays clean.
function loadOddsKey() {
  if (process.env.ODDS_API_KEY) return process.env.ODDS_API_KEY.trim();
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const cfg = JSON.parse(readFileSync(join(here, "odds.config.json"), "utf8"));
    return (cfg.oddsApiKey || "").trim() || null;
  } catch {
    return null;
  }
}
export const ODDS_KEY = loadOddsKey();

export async function getJSON(url) {
  const res = await fetch(url, { headers: { "User-Agent": "worldcup-cli" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

export const scoreboard = () => getJSON(`${BASE}/scoreboard`);
export const scoreboardOn = (yyyymmdd) => getJSON(`${BASE}/scoreboard?dates=${yyyymmdd}`);
export const summary = (id) => getJSON(`${BASE}/summary?event=${id}`);
export const allStandings = () =>
  getJSON(`https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings`);

// YYYYMMDD for `daysAhead` days from today
export function ymd(daysAhead = 0) {
  const d = new Date(Date.now() + daysAhead * 86400000);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

// implied win % for each outcome, vig-stripped to sum to 100 (ESPN pickcenter shape)
export function impliedProbs(odds) {
  if (!odds || odds.homeTeamOdds?.moneyLine == null) return null;
  const ml2p = (ml) => (ml == null ? 0 : ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100));
  const raw = [ml2p(odds.homeTeamOdds.moneyLine), ml2p(odds.drawOdds?.moneyLine), ml2p(odds.awayTeamOdds?.moneyLine)];
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  return raw.map((p) => Math.round((p / sum) * 100));
}

export const ml2prob = (ml) => (ml == null ? null : ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100));
export const fmtAmerican = (ml) => (ml == null ? "-" : ml > 0 ? `+${ml}` : `${ml}`);

// --- The Odds API: live multi-book odds (FanDuel + best-of-book line shopping) ---
// Cache to stay under the free tier's 500-request quota: refetch at most every 2 min.
export const oddsState = { remaining: null };
let _oddsCache = { at: 0, events: null };
export async function fetchOddsEvents() {
  if (!ODDS_KEY) return null;
  const now = Date.now();
  if (_oddsCache.events && now - _oddsCache.at < 120000) return _oddsCache.events;
  const url = `${ODDS_BASE}/?apiKey=${ODDS_KEY}&regions=us&markets=h2h,totals&oddsFormat=american`;
  const res = await fetch(url, { headers: { "User-Agent": "worldcup-cli" } });
  if (!res.ok) throw new Error(`Odds API HTTP ${res.status}`);
  _oddsCache = { at: now, events: await res.json() };
  oddsState.remaining = res.headers.get("x-requests-remaining");
  return _oddsCache.events;
}

// --- player props (The Odds API per-event endpoint) ---
// Real book markets, de-vigged. No saves/corners market exists for soccer; the props that
// DO exist are goal-scorer, shots, shots-on-target, assists, cards. We pull scorer + SoT.
// Cached per event (2 min) to respect the free-tier quota. Player props may require a paid
// plan — on a free key the request can 401/422, which we swallow (section just stays empty).
const PROP_MARKETS = "player_goal_scorer_anytime,player_shots_on_target";
const _propCache = new Map(); // oddsEventId -> { at, data }
const bestPrice = (arr) => arr.reduce((b, x) => (b == null || x.price > b.price ? x : b), null);
// the book the user actually bets on — shown first; others only flagged when they beat it
export const PRIMARY_BOOK = "fanduel";

// pick the primary book's price for a side, plus the best elsewhere and whether it beats primary
function priceView(side) {
  const fd = side.find((x) => x.book === PRIMARY_BOOK);
  const best = bestPrice(side);
  return {
    primary: fd ? fmtAmerican(fd.price) : null,
    primaryRaw: fd ? fd.price : null,
    best: best ? fmtAmerican(best.price) : null,
    bestBook: best?.book || null,
    bestRaw: best ? best.price : null,
    beats: best && fd ? best.price > fd.price : !!best && !fd, // another book wins (or FD absent)
    implied: fd ? ml2prob(fd.price) : best ? ml2prob(best.price) : null,
  };
}

// fair probability of side A, by de-vigging each book's two-sided price then averaging
function devigPair(sideA, sideB) {
  const mapB = new Map(sideB.map((x) => [x.book, x.price]));
  const probs = [];
  for (const a of sideA) {
    const bp = mapB.get(a.book);
    if (bp == null) continue;
    const pa = ml2prob(a.price), pb = ml2prob(bp);
    if (pa == null || pb == null) continue;
    probs.push(pa / (pa + pb)); // multiplicative de-vig
  }
  return probs.length ? probs.reduce((x, y) => x + y, 0) / probs.length : null;
}

function parsePlayerProps(ev) {
  if (!ev || !ev.bookmakers) return { scorers: [], sot: [] };
  const scorerAgg = new Map();  // player -> { player, yes:[], no:[] }
  const sotAgg = new Map();     // `player|line` -> { player, line, over:[], under:[] }
  for (const bk of ev.bookmakers) {
    for (const mk of bk.markets || []) {
      if (mk.key === "player_goal_scorer_anytime") {
        for (const o of mk.outcomes || []) {
          const p = o.description || o.name;
          if (!p) continue;
          const rec = scorerAgg.get(p) || { player: p, yes: [], no: [] };
          rec[/^no$/i.test(o.name) ? "no" : "yes"].push({ book: bk.key, price: o.price });
          scorerAgg.set(p, rec);
        }
      } else if (mk.key === "player_shots_on_target") {
        for (const o of mk.outcomes || []) {
          const p = o.description;
          if (!p) continue;
          const key = `${p}|${o.point}`;
          const rec = sotAgg.get(key) || { player: p, line: o.point, over: [], under: [] };
          rec[/under/i.test(o.name) ? "under" : "over"].push({ book: bk.key, price: o.price });
          sotAgg.set(key, rec);
        }
      }
    }
  }
  const scorers = [...scorerAgg.values()]
    .map((r) => ({ player: r.player, prob: devigPair(r.yes, r.no), price: priceView(r.yes), twoSided: r.no.length > 0 }))
    .filter((s) => s.price.primary || s.price.best)
    .sort((a, b) => (b.prob ?? b.price.implied ?? 0) - (a.prob ?? a.price.implied ?? 0))
    .slice(0, 6);
  const sot = [...sotAgg.values()]
    .map((r) => ({ player: r.player, line: r.line, fairOver: devigPair(r.over, r.under), price: priceView(r.over) }))
    .filter((s) => (s.price.primary || s.price.best) && s.fairOver != null)
    .sort((a, b) => b.fairOver - a.fairOver)
    .slice(0, 6);
  return { scorers, sot };
}

export async function fetchPlayerProps(oddsEventId) {
  if (!ODDS_KEY || !oddsEventId) return null;
  const now = Date.now();
  const hit = _propCache.get(oddsEventId);
  if (hit && now - hit.at < 120000) return hit.data;
  const url = `${SPORT_BASE}/events/${oddsEventId}/odds?apiKey=${ODDS_KEY}&regions=us&markets=${PROP_MARKETS}&oddsFormat=american`;
  const res = await fetch(url, { headers: { "User-Agent": "worldcup-cli" } });
  if (!res.ok) throw new Error(`Odds API props HTTP ${res.status}`);
  oddsState.remaining = res.headers.get("x-requests-remaining");
  const data = parsePlayerProps(await res.json());
  _propCache.set(oddsEventId, { at: now, data });
  return data;
}

const normTeam = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "").replace(/^(the)/, "");
export function teamsMatch(a, b) {
  const x = normTeam(a), y = normTeam(b);
  return x === y || x.includes(y) || y.includes(x);
}

// find the odds-API event matching an ESPN match, build a per-outcome book comparison
export function matchOdds(events, homeName, awayName) {
  if (!events) return null;
  const ev = events.find(
    (e) =>
      (teamsMatch(e.home_team, homeName) && teamsMatch(e.away_team, awayName)) ||
      (teamsMatch(e.home_team, awayName) && teamsMatch(e.away_team, homeName))
  );
  if (!ev) return null;
  const outcomes = { home: [], draw: [], away: [] };
  for (const bk of ev.bookmakers || []) {
    const m = (bk.markets || []).find((mk) => mk.key === "h2h");
    if (!m) continue;
    for (const o of m.outcomes || []) {
      const slot = teamsMatch(o.name, ev.home_team) ? "home"
        : teamsMatch(o.name, ev.away_team) ? "away"
        : /draw/i.test(o.name) ? "draw" : null;
      if (slot) outcomes[slot].push({ book: bk.key, price: o.price });
    }
  }
  const book = (slot, key) => outcomes[slot].find((x) => x.book === key);
  const best = (slot) => outcomes[slot].reduce((b, x) => (b == null || x.price > b.price ? x : b), null);
  const live = new Date(ev.commence_time).getTime() < Date.now();
  return { ev, outcomes, book, best, live, swapped: teamsMatch(ev.away_team, homeName) };
}

export function findEvent(events, query) {
  const q = String(query).toLowerCase();
  return events.find((ev) =>
    ev.id === query ||
    ev.competitions[0].competitors.some(
      (t) =>
        t.team.displayName.toLowerCase().includes(q) ||
        (t.team.abbreviation || "").toLowerCase() === q
    )
  );
}

export const statMap = (team) =>
  Object.fromEntries((team.statistics || []).map((s) => [s.name, s.displayValue]));

// --- math helpers for the model ---
export function poissonCdf(k, lambda) {
  if (k < 0) return 0;
  let term = Math.exp(-lambda), sum = term;
  for (let i = 1; i <= k; i++) { term *= lambda / i; sum += term; }
  return sum;
}
export function poissonPmf(k, lambda) {
  if (k < 0) return 0;
  let t = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) t *= lambda / i;
  return t;
}
export function probToAmerican(p) {
  if (!(p > 0) || p >= 1) return null;
  return p > 0.5 ? Math.round((-p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100);
}
export function matchMinute(st) {
  if (st?.type?.name === "STATUS_HALFTIME") return 45;
  if (st?.type?.state === "post") return 90;
  if (st?.type?.state !== "in") return null;
  const m = /(\d+)/.exec(st.displayClock || st.type?.shortDetail || "");
  return m ? Number(m[1]) : null;
}

// model-derived saves line for a keeper (no book offers this market — model estimate only)
export function keeperSaveLine(saves, minute, state, line = 2.5) {
  const FT = 95;
  if (state === "post") return { proj: saves, settled: true, over: saves > line, line };
  if (minute == null) return null;
  const elapsed = Math.max(minute, 10);
  const rate = saves / elapsed;
  const remMin = Math.max(0, FT - minute);
  const lambdaRem = rate * remMin;
  const proj = saves + lambdaRem;
  const need = Math.ceil(line) - saves;
  const pOver = need <= 0 ? 1 : 1 - poissonCdf(need - 1, lambdaRem);
  return { proj, lambdaRem, pOver, need, line, settled: false };
}

// model-derived corners line per side + total O/U. Corners per side ARE real live data
// (ESPN box score); there's no corners betting market in the feed, so the O/U is a model
// estimate. Extrapolate each side's corner rate to full time; price the total via Poisson.
export function cornersModel(hC, aC, minute, state, line = 9.5) {
  const FT = 95;
  if (state === "post") { const total = hC + aC; return { settled: true, home: hC, away: aC, total, over: total > line, line }; }
  if (minute == null) return null; // pre-match: no corners yet
  const elapsed = Math.max(minute, 10);
  const remMin = Math.max(0, FT - minute);
  const projH = hC + (hC / elapsed) * remMin;
  const projA = aC + (aC / elapsed) * remMin;
  const lambdaRemTotal = ((hC + aC) / elapsed) * remMin;
  const need = Math.ceil(line) - (hC + aC);
  const pOver = need <= 0 ? 1 : 1 - poissonCdf(need - 1, lambdaRemTotal);
  return { settled: false, home: hC, away: aC, projH, projA, totalProj: projH + projA, pOver, need, line, odds: probToAmerican(pOver) };
}

export function outcomeProbs(remLamH, remLamA, hScore, aScore) {
  let pH = 0, pD = 0, pA = 0;
  for (let i = 0; i <= 10; i++)
    for (let j = 0; j <= 10; j++) {
      const p = poissonPmf(i, remLamH) * poissonPmf(j, remLamA);
      const fh = hScore + i, fa = aScore + j;
      if (fh > fa) pH += p; else if (fh < fa) pA += p; else pD += p;
    }
  const s = pH + pD + pA || 1;
  return [pH / s, pD / s, pA / s];
}

export function impliedFromOdds(sum, liveOdds) {
  if (liveOdds) {
    const sH = liveOdds.swapped ? "away" : "home", sA = liveOdds.swapped ? "home" : "away";
    const price = (slot) => liveOdds.book(slot, "fanduel")?.price;
    const raw = [price(sH), price("draw"), price(sA)].map(ml2prob);
    if (raw[0] != null) { const s = raw.reduce((a, b) => a + (b || 0), 0) || 1; return raw.map((p) => (p || 0) / s); }
  }
  const odds = (sum.pickcenter || sum.odds || [])[0];
  if (odds && odds.homeTeamOdds?.moneyLine != null) {
    const raw = [ml2prob(odds.homeTeamOdds.moneyLine), ml2prob(odds.drawOdds?.moneyLine), ml2prob(odds.awayTeamOdds?.moneyLine)];
    const s = raw.reduce((a, b) => a + (b || 0), 0) || 1;
    return raw.map((p) => (p || 0) / s);
  }
  return null;
}

// model score prediction: run-of-play once live, market-implied pre-match
export function scorePrediction(ev, sum, liveOdds) {
  const comp = ev.competitions[0];
  const home = comp.competitors.find((t) => t.homeAway === "home");
  const away = comp.competitors.find((t) => t.homeAway === "away");
  const st = comp.status, state = st.type.state;
  if (state === "post") return null;
  const minute = matchMinute(st);
  const hScore = Number(home.score) || 0, aScore = Number(away.score) || 0;
  const FT = 95, AVG_TEAM = 1.35;
  const n = (v) => parseFloat(v) || 0;

  const teams = sum.boxscore?.teams || [];
  const hs = statMap(teams.find((t) => t.team.id === home.team.id) || teams[0] || {});
  const as = statMap(teams.find((t) => t.team.id === away.team.id) || teams[1] || {});
  const haveStats = Object.keys(hs).length > 0;
  const xg = (s) => n(s.shotsOnTarget) * 0.33 + Math.max(0, n(s.totalShots) - n(s.shotsOnTarget)) * 0.04;

  let remLamH, remLamA, basis;
  if (state === "in" && haveStats && minute != null && minute > 0) {
    const elapsed = Math.max(minute, 1), remMin = Math.max(0, FT - minute);
    const w = Math.min(1, elapsed / 70);
    const priorRem = AVG_TEAM * (remMin / 90);
    remLamH = w * ((xg(hs) / elapsed) * remMin) + (1 - w) * priorRem;
    remLamA = w * ((xg(as) / elapsed) * remMin) + (1 - w) * priorRem;
    basis = "run of play";
  } else {
    const probs = impliedFromOdds(sum, liveOdds);
    const odds = (sum.pickcenter || sum.odds || [])[0];
    const remMin = state === "pre" ? 90 : Math.max(0, FT - (minute ?? 0));
    const total = (Number(odds?.overUnder) || 2.7) * (remMin / 90);
    const sup = probs ? 2.2 * (probs[0] - probs[2]) * (remMin / 90) : 0;
    remLamH = Math.max(0.05, (total + sup) / 2);
    remLamA = Math.max(0.05, (total - sup) / 2);
    basis = "from market";
  }

  const expH = hScore + remLamH, expA = aScore + remLamA;
  const [wH, wD, wA] = outcomeProbs(remLamH, remLamA, hScore, aScore);
  const early = state === "pre" || (minute != null && minute < 25);
  return { basis, early, ph: Math.round(expH), pa: Math.round(expA), expH, expA, wH, wD, wA };
}

// betting model: run-of-play dominance vs market price → considerations (bet + reasoning)
export function bettingModel(ev, sum, liveOdds) {
  const comp = ev.competitions[0];
  const home = comp.competitors.find((t) => t.homeAway === "home");
  const away = comp.competitors.find((t) => t.homeAway === "away");
  const teams = sum.boxscore?.teams || [];
  const hs = statMap(teams.find((t) => t.team.id === home.team.id) || teams[0] || {});
  const as = statMap(teams.find((t) => t.team.id === away.team.id) || teams[1] || {});
  if (!Object.keys(hs).length) return null;
  const n = (v) => parseFloat(v) || 0;
  const hScore = Number(home.score) || 0, aScore = Number(away.score) || 0;
  const HA = home.team.abbreviation, AA = away.team.abbreviation;

  const xg = (s) => n(s.shotsOnTarget) * 0.33 + Math.max(0, n(s.totalShots) - n(s.shotsOnTarget)) * 0.04;
  const hX = xg(hs), aX = xg(as), combinedX = hX + aX;

  const share = (h, a) => { const t = h + a; return t ? h / t : 0.5; };
  const weights = [
    [xg(hs), xg(as), 0.40],
    [n(hs.shotsOnTarget), n(as.shotsOnTarget), 0.25],
    [n(hs.totalShots), n(as.totalShots), 0.15],
    [n(hs.possessionPct), n(as.possessionPct), 0.10],
    [n(hs.wonCorners), n(as.wonCorners), 0.10],
  ];
  const hDom = Math.round(weights.reduce((acc, [h, a, w]) => acc + share(h, a) * w, 0) * 100);
  const aDom = 100 - hDom;
  const domLeader = hDom >= aDom ? { abbr: HA, dom: hDom, side: "home" } : { abbr: AA, dom: aDom, side: "away" };

  let mkt = null;
  if (liveOdds) {
    const sH = liveOdds.swapped ? "away" : "home";
    const sA = liveOdds.swapped ? "home" : "away";
    const price = (slot) => liveOdds.book(slot, "fanduel")?.price;
    const pH = price(sH), pD = price("draw"), pA = price(sA);
    const raw = [pH, pD, pA].map(ml2prob);
    const sum2 = raw.reduce((x, y) => x + (y || 0), 0) || 1;
    mkt = {
      home: { price: pH, prob: Math.round((raw[0] / sum2) * 100) },
      draw: { price: pD, prob: Math.round((raw[1] / sum2) * 100) },
      away: { price: pA, prob: Math.round((raw[2] / sum2) * 100) },
    };
  }

  const recs = [];
  const leadByScore = hScore === aScore ? null : hScore > aScore ? "home" : "away";
  const domSide = domLeader.side, domAbbr = domLeader.abbr, domPct = domLeader.dom;
  const totalShots = n(hs.totalShots) + n(as.totalShots);
  const priceFor = (side) => (mkt ? `${fmtAmerican(mkt[side].price)} (${mkt[side].prob}%)` : "no live price");

  if (domPct >= 60 && leadByScore !== domSide) {
    const strong = domPct >= 67;
    recs.push({
      conf: strong ? "Strong lean" : "Lean",
      bet: `${domAbbr} to win @ ${priceFor(domSide)}`,
      text:
        `${domAbbr} to win the match @ ${priceFor(domSide)} — controlling the game (${domPct}%, xG edge) ` +
        `but ${leadByScore ? "trailing" : "level"}; the run of play says they're the better side and haven't been rewarded yet.`,
    });
  }
  if (domPct >= 58 && leadByScore === domSide) {
    recs.push({
      conf: "Low value",
      bet: `${domAbbr} win — fair but priced in (${priceFor(domSide)})`,
      text:
        `${domAbbr} are both ahead and on top — the price (${priceFor(domSide)}) already reflects it. Fair, but little edge left.`,
    });
  }
  if (combinedX >= 1.3 && hScore + aScore <= 2) {
    recs.push({
      conf: "Lean",
      bet: `Over goals / BTTS — ${combinedX.toFixed(2)} xG, only ${hScore + aScore} scored`,
      text:
        `Over goals / both-teams-to-score — ${combinedX.toFixed(2)} combined xG with chances flowing ` +
        `(${totalShots} shots) but only ${hScore + aScore} scored so far. (no live totals price on the free tier — directional)`,
    });
  } else if (combinedX < 0.6 && totalShots <= 6) {
    recs.push({
      conf: "Lean",
      bet: `Under goals / draw-no-bet — sterile (${combinedX.toFixed(2)} xG)`,
      text: `Under goals / draw-no-bet — sterile half (${combinedX.toFixed(2)} combined xG, few clear chances). (directional)`,
    });
  }
  if (!recs.length) {
    recs.push({
      conf: "No edge",
      bet: "No clear edge — sit this one out",
      text: "Even contest with no clear trend-vs-price gap — nothing stands out. Sit this one out.",
    });
  }

  return { recs, domLeader, hDom, aDom, hX, aX, combinedX, HA, AA, hScore, aScore };
}

// pre-match picks derived from the score prediction (the prediction is market-based before
// kickoff, so these are fair-value reads, not a claimed edge — labeled honestly).
export function prematchPicks(p, HA, AA) {
  const picks = [];
  const total = p.expH + p.expA;
  const favIsHome = p.wH >= p.wA;
  const favAbbr = favIsHome ? HA : AA;
  const favProb = Math.round((favIsHome ? p.wH : p.wA) * 100);

  // match result
  if (favProb >= 60) {
    picks.push({
      conf: favProb >= 70 ? "Strong lean" : "Lean",
      bet: `${favAbbr} to win — model ${favProb}%`,
      text: `${favAbbr} projected to win (model ${favProb}%, predicted ${p.ph}–${p.pa}). Pre-match read off the market line — fair value, not an edge.`,
    });
  } else {
    picks.push({
      conf: "Lean",
      bet: `Tight — double chance ${favAbbr}/Draw`,
      text: `No clear favourite (model ${favAbbr} ${favProb}%, predicted ${p.ph}–${p.pa}). Double chance ${favAbbr}/Draw is the safer pre-match lean.`,
    });
  }

  // total goals
  if (total >= 2.7) {
    picks.push({ conf: "Lean", bet: `Over 2.5 goals — proj ${total.toFixed(1)}`, text: `Model projects ${total.toFixed(1)} total goals (${p.ph}–${p.pa}) → Over 2.5 lean.` });
  } else if (total <= 2.1) {
    picks.push({ conf: "Lean", bet: `Under 2.5 goals — proj ${total.toFixed(1)}`, text: `Model projects ${total.toFixed(1)} total goals (${p.ph}–${p.pa}) → Under 2.5 lean.` });
  }

  // both teams to score
  if (p.expH >= 0.9 && p.expA >= 0.9) {
    picks.push({ conf: "Lean", bet: `Both teams to score — proj ${p.expH.toFixed(1)} / ${p.expA.toFixed(1)}`, text: `Both sides project ~1+ goal (${p.expH.toFixed(1)} / ${p.expA.toFixed(1)}) → BTTS lean.` });
  }
  return picks;
}

// --- structured views (no ANSI / no DOM) for any front end ---

// one match → a complete plain-data view (scores, stats, odds, prediction, recs, keepers, events)
export function buildMatchView(ev, sum, liveOdds) {
  const comp = ev.competitions[0];
  const home = comp.competitors.find((t) => t.homeAway === "home");
  const away = comp.competitors.find((t) => t.homeAway === "away");
  const st = comp.status, state = st.type.state;
  const minute = matchMinute(st);
  const halftime = st.type.name === "STATUS_HALFTIME";

  const statusText = halftime ? "HALFTIME"
    : state === "in" ? `LIVE ${st.displayClock || st.type.shortDetail || ""}`.trim()
    : state === "post" ? "FULL TIME"
    : new Date(ev.date).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });

  const teamObj = (t) => ({
    id: t.team.id, name: t.team.displayName, abbr: t.team.abbreviation,
    score: state === "pre" ? null : Number(t.score) || 0,
    logo: t.team.logo || (t.team.logos && t.team.logos[0]?.href) || null,
  });

  // stats
  const teams = sum.boxscore?.teams || [];
  const hs = statMap(teams.find((t) => t.team.id === home.team.id) || teams[0] || {});
  const as = statMap(teams.find((t) => t.team.id === away.team.id) || teams[1] || {});
  const pct = (v) => `${Math.round(parseFloat(v || 0) * 100)}%`;
  let possession = null, stats = [];
  if (Object.keys(hs).length) {
    possession = { home: parseFloat(hs.possessionPct || "50"), away: parseFloat(as.possessionPct || "50"), homeAbbr: home.team.abbreviation, awayAbbr: away.team.abbreviation };
    const rows = [
      ["Shots (on target)", `${hs.totalShots} (${hs.shotsOnTarget})`, `${as.totalShots} (${as.shotsOnTarget})`, hs.totalShots, as.totalShots],
      ["Corners", hs.wonCorners, as.wonCorners, hs.wonCorners, as.wonCorners],
      ["Fouls / Offsides", `${hs.foulsCommitted} / ${hs.offsides}`, `${as.foulsCommitted} / ${as.offsides}`, hs.foulsCommitted, as.foulsCommitted],
      ["Yellow / Red", `${hs.yellowCards} / ${hs.redCards}`, `${as.yellowCards} / ${as.redCards}`, hs.yellowCards, as.yellowCards],
      ["Passes (acc)", `${hs.totalPasses} (${pct(hs.passPct)})`, `${as.totalPasses} (${pct(as.passPct)})`, hs.totalPasses, as.totalPasses],
      ["Tkl/Int/Clr", `${hs.totalTackles}/${hs.interceptions}/${hs.effectiveClearance}`, `${as.totalTackles}/${as.interceptions}/${as.effectiveClearance}`, hs.totalTackles, as.totalTackles],
    ];
    for (const [label, hv, av, hn, an] of rows) {
      if (hv == null || String(hv).includes("undefined")) continue;
      stats.push({ label, home: String(hv), away: String(av), homeLeads: Number(hn) > Number(an), awayLeads: Number(an) > Number(hn) });
    }
  }

  // odds (live multi-book if a key is set, else ESPN pre-match opening line)
  let odds = null;
  if (liveOdds) {
    const slotHome = liveOdds.swapped ? "away" : "home";
    const slotAway = liveOdds.swapped ? "home" : "away";
    const fd = (slot) => liveOdds.book(slot, "fanduel");
    const fdML = [fd(slotHome)?.price, fd("draw")?.price, fd(slotAway)?.price];
    const raw = fdML.map(ml2prob);
    const sumP = raw.reduce((a, b) => a + (b || 0), 0) || 1;
    const probs = raw.map((p) => (p == null ? null : Math.round((p / sumP) * 100)));
    const mk = (slot, i) => {
      const b = liveOdds.best(slot);
      return {
        ml: fmtAmerican(fdML[i]), prob: probs[i],
        best: b ? fmtAmerican(b.price) : null, bestBook: b ? b.book : null, beatsFd: b ? b.book !== "fanduel" : false,
      };
    };
    odds = { source: liveOdds.live ? "live" : "pre", reqLeft: oddsState.remaining,
      home: mk(slotHome, 0), draw: mk("draw", 1), away: mk(slotAway, 2) };
  } else {
    const o = (sum.pickcenter || sum.odds || [])[0];
    if (o && o.homeTeamOdds?.moneyLine != null) {
      const raw = [ml2prob(o.homeTeamOdds.moneyLine), ml2prob(o.drawOdds?.moneyLine), ml2prob(o.awayTeamOdds?.moneyLine)];
      const sumP = raw.reduce((a, b) => a + (b || 0), 0) || 1;
      const probs = raw.map((p) => (p == null ? null : Math.round((p / sumP) * 100)));
      odds = { source: "pre-espn", provider: o.provider?.name || "book",
        home: { ml: fmtAmerican(o.homeTeamOdds.moneyLine), prob: probs[0] },
        draw: { ml: fmtAmerican(o.drawOdds?.moneyLine), prob: probs[1] },
        away: { ml: fmtAmerican(o.awayTeamOdds?.moneyLine), prob: probs[2] } };
    }
  }

  // corners per side + model total O/U (per-side counts are real live data)
  let corners = null;
  if (Object.keys(hs).length) {
    const hC = parseInt(hs.wonCorners || 0, 10) || 0;
    const aC = parseInt(as.wonCorners || 0, 10) || 0;
    corners = cornersModel(hC, aC, minute, state);
  }

  // prediction + recommended bets — run-of-play model once live, market-based pre-match
  const prediction = scorePrediction(ev, sum, liveOdds);
  const model = bettingModel(ev, sum, liveOdds);
  let recs = model ? model.recs : [];
  let recsBasis = model ? "run of play" : null;
  if ((!recs || !recs.length) && prediction && state !== "post") {
    recs = prematchPicks(prediction, home.team.abbreviation, away.team.abbreviation);
    recsBasis = "pre-match model";
  }
  const dominance = model ? { leader: model.domLeader.abbr, pct: model.domLeader.dom } : null;

  // model-vs-market gap (live only): where the run-of-play model's win prob diverges from
  // the de-vigged market price. A divergence signal, NOT a guaranteed edge.
  let valueEdges = null;
  if (state === "in" && prediction && odds && odds.home?.prob != null) {
    valueEdges = [
      { label: home.team.abbreviation, model: prediction.wH, mkt: odds.home.prob / 100 },
      { label: "Draw", model: prediction.wD, mkt: odds.draw?.prob != null ? odds.draw.prob / 100 : null },
      { label: away.team.abbreviation, model: prediction.wA, mkt: odds.away?.prob != null ? odds.away.prob / 100 : null },
    ].filter((s) => s.mkt != null).map((s) => ({ ...s, edge: s.model - s.mkt })).sort((a, b) => b.edge - a.edge);
  }

  // keepers with model saves line
  const keepers = [];
  for (const r of sum.rosters || []) {
    const abbr = r.team?.id === home.team.id ? home.team.abbreviation
      : r.team?.id === away.team.id ? away.team.abbreviation : r.team?.abbreviation || "";
    for (const p of r.roster || []) {
      if (p.position?.abbreviation !== "G") continue;
      const ps = Object.fromEntries((p.stats || []).map((s) => [s.name, s.value]));
      if (!ps.appearances) continue;
      const saves = ps.saves ?? 0;
      const ln = keeperSaveLine(saves, minute, state);
      keepers.push({
        abbr, name: p.athlete?.displayName || "?", saves, ga: ps.goalsConceded ?? 0, faced: ps.shotsFaced ?? 0,
        line: ln ? (ln.settled ? { settled: true, over: ln.over, value: ln.line }
          : { settled: false, proj: ln.proj, pOver: ln.pOver, need: ln.need, value: ln.line, odds: probToAmerican(ln.pOver) })
          : null,
      });
    }
  }

  // group standings for this match's group
  let group = null;
  const g = sum.standings?.groups?.[0];
  if (g?.standings?.entries?.length) {
    const stat = (e, nm) => (e.stats || []).find((s) => s.name === nm)?.displayValue ?? "";
    const teamName = (t) => (typeof t === "string" ? t : t?.displayName || t?.name || "?");
    const here = new Set([home.team.displayName, away.team.displayName]);
    const entries = [...g.standings.entries]
      .sort((a, b) => Number(stat(a, "rank")) - Number(stat(b, "rank")))
      .map((e) => ({
        rank: Number(stat(e, "rank")), name: teamName(e.team), gp: stat(e, "gamesPlayed"),
        record: stat(e, "overall"), gd: stat(e, "pointDifferential"), pts: stat(e, "points"),
        highlight: here.has(teamName(e.team)),
      }));
    group = { header: g.header || "Group", entries };
  }

  // events (goals, cards, subs)
  const events = (sum.keyEvents || [])
    .filter((e) => {
      const t = (e.type?.text || "").toLowerCase();
      if (t.includes("delay")) return false;
      return ["goal", "card", "substitution", "penalty", "kickoff", "halftime", "end"].some((k) => t.includes(k));
    })
    .slice(-10)
    .map((e) => ({
      min: e.clock?.displayValue || "",
      type: e.type?.text || "",
      teamAbbr: e.team?.id === home.team.id ? home.team.abbreviation : e.team?.id === away.team.id ? away.team.abbreviation : "",
      players: (e.participants || []).map((p) => p.athlete?.displayName).filter(Boolean).join(", "),
    }));

  return {
    id: ev.id, state, halftime, minute, statusText, venue: comp.venue?.fullName || "",
    home: teamObj(home), away: teamObj(away),
    possession, stats, odds, prediction, recs, recsBasis, dominance, valueEdges, keepers, corners, group, events,
  };
}

// quick market-based predicted scoreline for a match, from an odds-API event's consensus
// h2h + totals lines. Cheap enough to run for every row in the picker. null if no odds.
function marketPrediction(oddsEv, homeName) {
  if (!oddsEv) return null;
  const homeP = [], drawP = [], awayP = [];
  let totalLine = null;
  for (const bk of oddsEv.bookmakers || []) {
    const h2h = (bk.markets || []).find((m) => m.key === "h2h");
    if (h2h) {
      let ph, pd, pa;
      for (const o of h2h.outcomes || []) {
        if (/draw/i.test(o.name)) pd = ml2prob(o.price);
        else if (teamsMatch(o.name, oddsEv.home_team)) ph = ml2prob(o.price);
        else pa = ml2prob(o.price);
      }
      if (ph != null && pa != null) {
        const s = ph + (pd || 0) + pa || 1;
        homeP.push(ph / s); drawP.push((pd || 0) / s); awayP.push(pa / s);
      }
    }
    if (totalLine == null) {
      const pt = (bk.markets || []).find((m) => m.key === "totals")?.outcomes?.find((o) => o.point != null)?.point;
      if (pt != null) totalLine = pt;
    }
  }
  if (!homeP.length) return null;
  const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  let pH = avg(homeP), pD = avg(drawP), pA = avg(awayP);
  if (teamsMatch(oddsEv.away_team, homeName)) { const t = pH; pH = pA; pA = t; } // map to ESPN home/away
  const total = totalLine != null ? Number(totalLine) : 2.7;
  const sup = 2.2 * (pH - pA);
  const lamH = Math.max(0.05, (total + sup) / 2), lamA = Math.max(0.05, (total - sup) / 2);
  const [wH, wD, wA] = outcomeProbs(lamH, lamA, 0, 0);
  return { ph: Math.round(lamH), pa: Math.round(lamA), wH, wD, wA };
}

// today's matches (today + N days) as lightweight rows for a picker
export async function listMatchesData({ days = 3 } = {}) {
  const boards = await Promise.all(
    Array.from({ length: days }, (_, i) => scoreboardOn(ymd(i)).catch(() => ({ events: [] })))
  );
  const seen = new Set(), events = [];
  for (const b of boards)
    for (const ev of b.events || [])
      if (!seen.has(ev.id)) { seen.add(ev.id); events.push(ev); }
  events.sort((a, b) => new Date(a.date) - new Date(b.date));
  // one cached odds fetch covers every row's predicted scoreline
  let oddsEvents = null;
  if (ODDS_KEY) { try { oddsEvents = await fetchOddsEvents(); } catch { /* no predictions */ } }
  return events.map((ev) => {
    const comp = ev.competitions[0];
    const home = comp.competitors.find((t) => t.homeAway === "home");
    const away = comp.competitors.find((t) => t.homeAway === "away");
    const state = comp.status.type.state;
    let pred = null;
    if (oddsEvents) {
      const hn = home.team.displayName, an = away.team.displayName;
      const oe = oddsEvents.find((e) =>
        (teamsMatch(e.home_team, hn) && teamsMatch(e.away_team, an)) ||
        (teamsMatch(e.home_team, an) && teamsMatch(e.away_team, hn)));
      pred = marketPrediction(oe, hn);
    }
    return {
      id: ev.id, date: ev.date, state,
      home: home.team.displayName, homeAbbr: home.team.abbreviation, homeScore: Number(home.score) || 0,
      away: away.team.displayName, awayAbbr: away.team.abbreviation, awayScore: Number(away.score) || 0,
      live: state === "in", statusText: state === "in" ? (comp.status.displayClock || "LIVE") : state === "post" ? "FT" : null,
      pred,
    };
  });
}

// high-level state for the widget: a single match view (by query, or the lone live game),
// plus the day's match list for the picker. Never throws — returns { error } instead.
export async function getWidgetState(query) {
  try {
    const sb = await scoreboard();
    const events = sb.events || [];
    let ev = null;
    if (query) {
      ev = findEvent(events, query);
    } else {
      // auto: prefer a live game; otherwise fall back to the soonest upcoming one so the
      // widget always shows something useful
      const live = events.filter((e) => e.competitions[0].status.type.state === "in");
      if (live.length) ev = live[0];
      else {
        const upcoming = events
          .filter((e) => e.competitions[0].status.type.state === "pre")
          .sort((a, b) => new Date(a.date) - new Date(b.date));
        ev = upcoming[0] || events[0] || null;
      }
    }
    const matches = await listMatchesData().catch(() => []);
    if (!ev) return { match: null, matches };

    const sum = await summary(ev.id);
    let liveOdds = null;
    if (ODDS_KEY) {
      try {
        const comp = ev.competitions[0];
        const h = comp.competitors.find((t) => t.homeAway === "home");
        const a = comp.competitors.find((t) => t.homeAway === "away");
        liveOdds = matchOdds(await fetchOddsEvents(), h.team.displayName, a.team.displayName);
      } catch { /* fall back to ESPN pre-match */ }
    }
    const view = buildMatchView(ev, sum, liveOdds);
    // attach real de-vigged player props for the displayed match (best-effort)
    if (liveOdds?.ev?.id) {
      try { view.playerProps = await fetchPlayerProps(liveOdds.ev.id); }
      catch { view.playerProps = null; }
    }
    return { match: view, matches };
  } catch (e) {
    return { error: String(e?.message || e), matches: [] };
  }
}
