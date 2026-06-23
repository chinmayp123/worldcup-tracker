// lib — shared data + model layer for the World Cup tracker.
// Both the CLI (worldcup.mjs) and the desktop widget (widget/) import from here, so the
// fetching, odds, predictions, keeper-saves model, and betting reads live in ONE place.
// Everything here returns plain data — no terminal ANSI, no DOM — so any front end can use it.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { fotmobXG, fotmobTeamRates, fetchFotmobFixtures, fotmobPlayerSOT } from "./fotmob.mjs";
import { actionPublicBetting } from "./actionnetwork.mjs";
import { fanduelProps } from "./fanduel.mjs";

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

// Dixon–Coles low-score dependence correction (rho ≈ -0.05): independent Poisson under-counts
// 0-0/1-1 draws and over-counts 1-0/0-1. Applied only pre-kickoff (0-0), where it's the proper
// full-match scoreline; once goals are in, the in-play rates already carry the dependence.
const DC_RHO = -0.05;
function dcTau(fh, fa, lamH, lamA) {
  if (fh === 0 && fa === 0) return 1 - lamH * lamA * DC_RHO;
  if (fh === 0 && fa === 1) return 1 + lamH * DC_RHO;
  if (fh === 1 && fa === 0) return 1 + lamA * DC_RHO;
  if (fh === 1 && fa === 1) return 1 - DC_RHO;
  return 1;
}
export function outcomeProbs(remLamH, remLamA, hScore, aScore) {
  const pre = hScore === 0 && aScore === 0;
  let pH = 0, pD = 0, pA = 0;
  for (let i = 0; i <= 10; i++)
    for (let j = 0; j <= 10; j++) {
      let p = poissonPmf(i, remLamH) * poissonPmf(j, remLamA);
      const fh = hScore + i, fa = aScore + j;
      if (pre) p *= dcTau(fh, fa, remLamH, remLamA);
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

// --- WC2026 venue conditions (host stadiums): altitude (m) + a heat-risk index (0 mild → 3
// extreme), allowing for air-conditioned/retractable roofs. Matched loosely by name/city. ---
const VENUES = [
  { k: /lumen|seattle/i, alt: 5, heat: 0 },
  { k: /gillette|foxboro|boston/i, alt: 90, heat: 1 },
  { k: /lincoln financial|philadelphia/i, alt: 12, heat: 2 },
  { k: /metlife|rutherford|new jersey|new york/i, alt: 5, heat: 2 },
  { k: /at&t|arlington|dallas/i, alt: 150, heat: 1 },     // retractable roof + AC
  { k: /nrg|houston/i, alt: 15, heat: 1 },                 // retractable roof + AC
  { k: /arrowhead|kansas city/i, alt: 270, heat: 3 },
  { k: /mercedes-benz|atlanta/i, alt: 320, heat: 1 },      // retractable roof + AC
  { k: /hard rock|miami/i, alt: 2, heat: 3 },
  { k: /levi'?s|santa clara|san francisco|bay/i, alt: 9, heat: 2 },
  { k: /sofi|inglewood|los angeles/i, alt: 30, heat: 0 },  // covered
  { k: /bmo|toronto/i, alt: 80, heat: 1 },
  { k: /bc place|vancouver/i, alt: 3, heat: 0 },           // retractable roof
  { k: /azteca|banorte|mexico city|ciudad de m/i, alt: 2240, heat: 1 },
  { k: /akron|guadalajara|zapopan/i, alt: 1566, heat: 2 },
  { k: /bbva|monterrey/i, alt: 500, heat: 3 },
];
function venueInfo(name, city) {
  const s = `${name || ""} ${city || ""}`;
  return VENUES.find((v) => v.k.test(s)) || null;
}
const HEAT_LABEL = ["mild", "warm", "hot", "extreme heat"];

// per-match physical conditions from the schedule + venue: rest days for each side, and the
// venue's altitude/heat. Returns a small λ tilt for the disadvantaged side (capped, since the
// effect is real but noisy) plus display fields. Best-effort; null if data is missing.
export async function matchConditions(ev, homeRef, awayRef) {
  try {
    const v = ev.competitions[0].venue;
    const venue = venueInfo(v?.fullName, v?.address?.city);
    const fixtures = await fetchFotmobFixtures();
    const curMs = new Date(ev.date).getTime();
    const restFor = (ref) => {
      if (!fixtures?.length || !curMs) return null;
      const played = fixtures.filter((f) => f.utcTime && new Date(f.utcTime).getTime() < curMs - 36e5 &&
        (teamsMatch(f.home.name, ref.name) || (ref.abbr && teamsMatch(f.home.name, ref.abbr)) ||
         teamsMatch(f.away.name, ref.name) || (ref.abbr && teamsMatch(f.away.name, ref.abbr))));
      if (!played.length) return null;
      played.sort((a, b) => new Date(b.utcTime) - new Date(a.utcTime));
      return Math.max(0, Math.round((curMs - new Date(played[0].utcTime).getTime()) / 864e5));
    };
    const restH = restFor(homeRef), restA = restFor(awayRef);
    // tilt: altitude saps pace for both sides; a short-rest side relative to the opponent is tilted down
    let tH = 1, tA = 1;
    if (venue && venue.alt >= 1500) { tH *= 0.96; tA *= 0.96; }
    if (venue && venue.heat >= 3) { tH *= 0.98; tA *= 0.98; }
    if (restH != null && restA != null) {
      if (restH <= 3 && restA - restH >= 2) tH *= 0.97;
      if (restA <= 3 && restH - restA >= 2) tA *= 0.97;
    }
    if (!venue && restH == null && restA == null) return null;
    return {
      venue: venue ? { name: v?.fullName || "", alt: venue.alt, heat: venue.heat, heatLabel: HEAT_LABEL[venue.heat] } : null,
      home: { restDays: restH }, away: { restDays: restA },
      tilt: { home: tH, away: tA },
    };
  } catch {
    return null;
  }
}

// model score prediction: run-of-play once live, market-implied pre-match.
// realXG (FotMob, optional) replaces the shot proxy with true cumulative xG when present.
// cond (optional) applies a small fatigue/altitude/heat tilt to expected goals.
export function scorePrediction(ev, sum, liveOdds, realXG = null, priors = null, cond = null) {
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
    const useReal = realXG && typeof realXG.home?.xg === "number";
    const cumH = useReal ? realXG.home.xg : xg(hs);
    const cumA = useReal ? realXG.away.xg : xg(as);
    remLamH = w * ((cumH / elapsed) * remMin) + (1 - w) * priorRem;
    remLamA = w * ((cumA / elapsed) * remMin) + (1 - w) * priorRem;
    basis = useReal ? "run of play · real xG" : "run of play";
  } else {
    const probs = impliedFromOdds(sum, liveOdds);
    const odds = (sum.pickcenter || sum.odds || [])[0];
    const remMin = state === "pre" ? 90 : Math.max(0, FT - (minute ?? 0));
    const total = (Number(odds?.overUnder) || 2.7) * (remMin / 90);
    const sup = probs ? 2.2 * (probs[0] - probs[2]) * (remMin / 90) : 0;
    remLamH = Math.max(0.05, (total + sup) / 2);
    remLamA = Math.max(0.05, (total - sup) / 2);
    basis = "from market";
    // blend in each team's Round 1 xG form (FotMob) so the pregame line reflects how they
    // actually played, not just the market — market gets the majority weight (1 game is noisy)
    if (priors && state === "pre") {
      remLamH = 0.55 * remLamH + 0.45 * priors.home;
      remLamA = 0.55 * remLamA + 0.45 * priors.away;
      basis = "market + R1 form";
    }
  }

  // WC2026 conditions tilt (altitude/heat/rest fatigue) — small, capped
  if (cond && cond.home && cond.away) { remLamH *= cond.home; remLamA *= cond.away; }
  const expH = hScore + remLamH, expA = aScore + remLamA;
  const [wH, wD, wA] = outcomeProbs(remLamH, remLamA, hScore, aScore);
  const early = state === "pre" || (minute != null && minute < 25);
  // derived predictions (live-aware): goals already scored are certain, only the remaining
  // expectation is random.  BTTS = each team scores ≥1 by full time.
  const scored = hScore + aScore;
  const pHomeScore = hScore >= 1 ? 1 : 1 - Math.exp(-remLamH);
  const pAwayScore = aScore >= 1 ? 1 : 1 - Math.exp(-remLamA);
  const pBTTS = pHomeScore * pAwayScore;
  const needOver = Math.max(0, 3 - scored);
  const pOver25 = needOver === 0 ? 1 : 1 - poissonCdf(needOver - 1, remLamH + remLamA);
  // displayed scoreline = the MOST LIKELY exact score (the mode of each side's goal distribution,
  // = floor of expected goals), NOT each side rounded independently. Rounding both up inflated the
  // shown total above the expected total, so "predicted 2-1" could sit next to an Under 2.5 pick.
  // The mode keeps the scoreline consistent with the win % and totals (e.g. 1.66/0.84 -> 1-0).
  return { basis, early, ph: Math.floor(expH), pa: Math.floor(expA), expH, expA, wH, wD, wA, pBTTS, pOver25, remLamH, remLamA };
}

// betting model: run-of-play dominance vs market price → considerations (bet + reasoning).
// realXG (FotMob, optional) feeds true xG into the dominance index and the goals reads.
export function bettingModel(ev, sum, liveOdds, realXG = null, prediction = null) {
  const comp = ev.competitions[0];
  const home = comp.competitors.find((t) => t.homeAway === "home");
  const away = comp.competitors.find((t) => t.homeAway === "away");
  const st = comp.status;
  const halftime = st.type.name === "STATUS_HALFTIME";
  const teams = sum.boxscore?.teams || [];
  const hs = statMap(teams.find((t) => t.team.id === home.team.id) || teams[0] || {});
  const as = statMap(teams.find((t) => t.team.id === away.team.id) || teams[1] || {});
  if (!Object.keys(hs).length) return null;
  const n = (v) => parseFloat(v) || 0;
  const hScore = Number(home.score) || 0, aScore = Number(away.score) || 0;
  const HA = home.team.abbreviation, AA = away.team.abbreviation;

  const xg = (s) => n(s.shotsOnTarget) * 0.33 + Math.max(0, n(s.totalShots) - n(s.shotsOnTarget)) * 0.04;
  const hX = typeof realXG?.home?.xg === "number" ? realXG.home.xg : xg(hs);
  const aX = typeof realXG?.away?.xg === "number" ? realXG.away.xg : xg(as);
  const combinedX = hX + aX;

  const share = (h, a) => { const t = h + a; return t ? h / t : 0.5; };
  const weights = [
    [hX, aX, 0.40],
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

  // looser thresholds at halftime — a full half of evidence and the 2nd-half market resets
  const domT = halftime ? 55 : 60, domStrongT = halftime ? 62 : 67;
  const whenLabel = halftime ? "first half" : "so far";
  // the scoreline model's win prob for the dominant side — gates the "to win" lean so it can
  // never contradict the win bar (a side dominating but trailing late may have ~no real chance)
  const WIN_FLOOR = 0.25;
  const domWin = prediction ? (domSide === "home" ? prediction.wH : prediction.wA) : null;
  if (domPct >= domT && leadByScore !== domSide && (domWin == null || domWin >= WIN_FLOOR)) {
    recs.push({
      conf: domPct >= domStrongT ? "Strong lean" : "Lean",
      bet: `${domAbbr} to win @ ${priceFor(domSide)}`,
      text:
        `${domAbbr} to win the match @ ${priceFor(domSide)} — controlling the game (${domPct}%, xG edge) ` +
        `but ${leadByScore ? "trailing" : "level"}${domWin != null ? `; scoreline model still gives them ${Math.round(domWin * 100)}%` : ""}. The run of play says they're the better side and haven't been rewarded yet.`,
    });
  } else if (domPct >= domT && leadByScore !== domSide && domWin != null && domWin < WIN_FLOOR) {
    // dominant but trailing late — the scoreline model says the comeback is unlikely, so this is
    // information, not a win lean (prevents the old "back TUR" vs "PAR 63%" contradiction)
    recs.push({
      conf: "Low value",
      bet: `${domAbbr} on top but unlikely to recover — model ${Math.round(domWin * 100)}%`,
      text:
        `${domAbbr} are controlling (${domPct}%) but trailing with little time/xG left — the scoreline ` +
        `model gives them only ${Math.round(domWin * 100)}%. Run-of-play dominance without enough runway; not a win lean.`,
    });
  } else if (domPct >= domT - 3 && leadByScore === domSide) {
    recs.push({
      conf: "Low value",
      bet: `${domAbbr} win — fair but priced in (${priceFor(domSide)})`,
      text: `${domAbbr} are both ahead and on top — the price (${priceFor(domSide)}) already reflects it. Fair, but little edge left.`,
    });
  }

  // goals + BTTS reads from the model probabilities (live-aware). Directional — no live
  // totals/BTTS market on the free tier — but they keep a read on the board at halftime.
  const scored = hScore + aScore;
  const bothScored = hScore >= 1 && aScore >= 1;
  if (prediction) {
    const ov = Math.round(prediction.pOver25 * 100);
    if (prediction.pOver25 >= 0.56 && scored <= 2) {
      recs.push({ conf: prediction.pOver25 >= 0.66 ? "Strong lean" : "Lean", bet: `Over 2.5 goals — model ${ov}%`,
        text: `Over 2.5 goals — model ${ov}% (${combinedX.toFixed(2)} combined xG ${whenLabel}, ${scored} scored). Directional.` });
    } else if (prediction.pOver25 <= 0.42) {
      recs.push({ conf: "Lean", bet: `Under 2.5 goals — model ${100 - ov}%`,
        text: `Under 2.5 goals — model ${100 - ov}% (sterile run of play, ${combinedX.toFixed(2)} combined xG ${whenLabel}). Directional.` });
    }
    const bt = Math.round(prediction.pBTTS * 100);
    if (!bothScored && prediction.pBTTS >= 0.55) {
      recs.push({ conf: prediction.pBTTS >= 0.66 ? "Strong lean" : "Lean", bet: `Both teams to score — model ${bt}%`,
        text: `Both teams to score (Yes) — model ${bt}%; both sides creating (${hX.toFixed(2)} / ${aX.toFixed(2)} xG) and ${bothScored ? "both have scored" : "not both on the board yet"}. Directional.` });
    } else if (!bothScored && prediction.pBTTS <= 0.38) {
      recs.push({ conf: "Lean", bet: `Both teams to score: No — model ${100 - bt}%`,
        text: `BTTS No — model ${100 - bt}%; one side offers little going forward (${hX.toFixed(2)} / ${aX.toFixed(2)} xG). Directional.` });
    }
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

// pregame projections from each team's Round 1 form (FotMob): expected corners O/U,
// keeper-saves O/U, and xG priors to blend into the scoreline. null if rates unavailable.
export async function pregameProjections(home, away) {
  const [hr, ar] = await Promise.all([fotmobTeamRates(home), fotmobTeamRates(away)]);
  if (!hr || !ar) return null;
  const mean = (a, b) => (a + b) / 2;
  // attack = blend of xG created and goals actually scored; defence = xG + goals conceded.
  // goals capture finishing/overperformance (a 7-1 lifts attack); falls back to xG if no goals.
  const att = (r) => mean(r.xgFor, r.goalsFor ?? r.xgFor);
  const def = (r) => mean(r.xgAgainst, r.goalsAgainst ?? r.xgAgainst);
  // only one game has been played, so regularize each rate toward a tournament prior
  // (50/50) — keeps a single 0-corner game from producing a nonsensical projection
  const shrink = (v, prior) => (v + prior) / 2;
  // corners: each side's expected count is the average of its own (shrunk) attacking rate and
  // the opponent's (shrunk) conceding rate; total drives an O/U 9.5 via Poisson
  const cH = mean(shrink(hr.cornersFor, 5), shrink(ar.cornersAgainst, 5));
  const cA = mean(shrink(ar.cornersFor, 5), shrink(hr.cornersAgainst, 5));
  const cTotal = cH + cA, cLine = 9.5;
  const pOverC = 1 - poissonCdf(Math.floor(cLine), cTotal);
  // keeper saves: expected shots-on-target faced minus expected goals conceded (xG proxy)
  const sotFacedH = mean(shrink(ar.sotFor, 4), shrink(hr.sotAgainst, 4));
  const sotFacedA = mean(shrink(hr.sotFor, 4), shrink(ar.sotAgainst, 4));
  const gaH = mean(shrink(ar.xgFor, 1.3), shrink(hr.xgAgainst, 1.3));
  const gaA = mean(shrink(hr.xgFor, 1.3), shrink(ar.xgAgainst, 1.3));
  const savesH = Math.max(0, sotFacedH - gaH), savesA = Math.max(0, sotFacedA - gaA);
  const sLine = 2.5;
  // projected shots + shots on target per side (own attacking rate vs opponent conceding rate)
  const shotsH = mean(shrink(hr.shotsFor, 12), shrink(ar.shotsAgainst, 12));
  const shotsA = mean(shrink(ar.shotsFor, 12), shrink(hr.shotsAgainst, 12));
  const sotH = mean(shrink(hr.sotFor, 4), shrink(ar.sotAgainst, 4));
  const sotA = mean(shrink(ar.sotFor, 4), shrink(hr.sotAgainst, 4));
  const pOverSH = 1 - poissonCdf(Math.floor(sLine), savesH), pOverSA = 1 - poissonCdf(Math.floor(sLine), savesA);
  return {
    basis: `recent form (${Math.max(hr.games, ar.games)}g)`,
    shots: { home: { shots: shotsH, sot: sotH }, away: { shots: shotsA, sot: sotA } },
    corners: { home: cH, away: cA, total: cTotal, line: cLine, pOver: pOverC, odds: probToAmerican(pOverC) },
    saves: {
      home: { proj: savesH, line: sLine, pOver: pOverSH, odds: probToAmerican(pOverSH) },
      away: { proj: savesA, line: sLine, pOver: pOverSA, odds: probToAmerican(pOverSA) },
    },
    // attack/defence strength blends xG with REAL goals scored/conceded, so a team that has
    // actually been banging them in (or leaking) moves the scoreline prior — not just chance
    // quality. Each side's prior = its attack vs the opponent's defence.
    xgPrior: { home: mean(att(hr), def(ar)), away: mean(att(ar), def(hr)) },
  };
}

// one match → a complete plain-data view (scores, stats, odds, prediction, recs, keepers, events)
export function buildMatchView(ev, sum, liveOdds, realXG = null, publicBetting = null, priors = null, conditions = null) {
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
    color: t.team.color ? `#${t.team.color}` : null,
    altColor: t.team.alternateColor ? `#${t.team.alternateColor}` : null,
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
  } else if (publicBetting?.fanduel) {
    // real FanDuel moneyline via Action Network (free, no Odds API quota)
    const f = publicBetting.fanduel;
    const cell = (c) => ({ ml: fmtAmerican(c.ml), prob: c.prob });
    odds = { source: "fanduel-an", home: cell(f.home), draw: cell(f.draw), away: cell(f.away) };
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
  const prediction = scorePrediction(ev, sum, liveOdds, realXG, priors?.xgPrior, conditions?.tilt);
  const model = bettingModel(ev, sum, liveOdds, realXG, prediction);
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
  if (prediction && state !== "post" && odds && odds.home?.prob != null) {
    const dec = (mlStr) => { const ml = Number(mlStr); if (!ml) return null; return ml > 0 ? ml / 100 + 1 : 100 / -ml + 1; };
    // half-Kelly stake (fraction of bankroll), capped at 5% — full Kelly is too aggressive and
    // large model "edges" are usually model error, not real value
    const kelly = (p, d) => { if (!d || d <= 1) return 0; const b = d - 1; return Math.min(0.05, Math.max(0, (b * p - (1 - p)) / b / 2)); };
    valueEdges = [
      { label: home.team.abbreviation, model: prediction.wH, mkt: odds.home.prob / 100, ml: odds.home.ml },
      { label: "Draw", model: prediction.wD, mkt: odds.draw?.prob != null ? odds.draw.prob / 100 : null, ml: odds.draw?.ml },
      { label: away.team.abbreviation, model: prediction.wA, mkt: odds.away?.prob != null ? odds.away.prob / 100 : null, ml: odds.away?.ml },
    ].filter((s) => s.mkt != null).map((s) => { const d = dec(s.ml); return { ...s, edge: s.model - s.mkt, dec: d, kelly: kelly(s.model, d) }; })
      .sort((a, b) => b.edge - a.edge);
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

  // real xG (FotMob) for display — team totals (incl. xGOT / big chances) + top per-player
  const xg = realXG && typeof realXG.home?.xg === "number"
    ? {
        source: realXG.source || "fotmob",
        home: realXG.home, away: realXG.away, players: (realXG.players || []).slice(0, 6),
        xgot: realXG.xgot || null, bigChances: realXG.bigChances || null, bigChancesMissed: realXG.bigChancesMissed || null,
      }
    : null;
  // live pressure series, top performers, recent form — all from the same FotMob fetch
  const momentum = realXG?.momentum?.length ? realXG.momentum : null;
  const topPlayers = realXG?.topPlayers || null;
  const form = realXG?.form || null;

  return {
    id: ev.id, state, halftime, minute, statusText, venue: comp.venue?.fullName || "",
    home: teamObj(home), away: teamObj(away),
    possession, stats, xg, momentum, topPlayers, form, odds, prediction, recs, recsBasis, dominance, valueEdges,
    publicBetting: publicBetting || null, pregameProj: priors || null, conditions: conditions || null, keepers, corners, group, events,
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

// market-based predicted scoreline from ESPN's inline scoreboard odds (already on the row, so
// no extra fetch). The picker's fallback when The Odds API is unavailable (e.g. quota used up).
// home/away here are the ESPN home/away, so no swap is needed.
function espnMarketPrediction(ev) {
  const o = (ev.competitions?.[0]?.odds || [])[0];
  const ml = o?.moneyline;
  if (!ml) return null;
  const px = (s) => { const v = s?.current?.odds ?? s?.close?.odds ?? s?.open?.odds; return v == null ? null : Number(v); };
  const pH0 = ml2prob(px(ml.home)), pD0 = ml2prob(px(ml.draw)), pA0 = ml2prob(px(ml.away));
  if (pH0 == null || pA0 == null) return null;
  const s = pH0 + (pD0 || 0) + pA0 || 1;
  const pH = pH0 / s, pA = pA0 / s;
  const total = Number(o.overUnder) || 2.7;
  const sup = 2.2 * (pH - pA);
  const lamH = Math.max(0.05, (total + sup) / 2), lamA = Math.max(0.05, (total - sup) / 2);
  const [wH, wD, wA] = outcomeProbs(lamH, lamA, 0, 0);
  return { ph: Math.round(lamH), pa: Math.round(lamA), wH, wD, wA };
}

// today's matches (today + N days) as lightweight rows for a picker
export async function listMatchesData({ back = 2, ahead = 2 } = {}) {
  // span previous days too (back) so finished games stay viewable, plus today + upcoming (ahead)
  const offsets = [];
  for (let i = -back; i <= ahead; i++) offsets.push(i);
  const boards = await Promise.all(offsets.map((i) => scoreboardOn(ymd(i)).catch(() => ({ events: [] }))));
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
    if (!pred) pred = espnMarketPrediction(ev); // fallback: ESPN's inline line (works without the Odds API)
    return {
      id: ev.id, date: ev.date, state,
      home: home.team.displayName, homeAbbr: home.team.abbreviation, homeScore: Number(home.score) || 0,
      away: away.team.displayName, awayAbbr: away.team.abbreviation, awayScore: Number(away.score) || 0,
      homeLogo: home.team.logo || null, awayLogo: away.team.logo || null,
      homeColor: home.team.color ? `#${home.team.color}` : null, awayColor: away.team.color ? `#${away.team.color}` : null,
      live: state === "in", statusText: state === "in" ? (comp.status.displayClock || "LIVE") : state === "post" ? "FT" : null,
      pred,
    };
  });
}

// the day's $10 parlays for the widget's Parlays view. Generation is expensive (per-game
// model + odds + public-betting fetches), so cache it and rebuild at most every PARLAY_TTL.
// parlays.mjs imports from this module, so import it lazily to avoid a load-time cycle.
let parlayCache = { at: 0, data: null };
const PARLAY_TTL = 30 * 60 * 1000; // 30 min
export async function getDailyParlays(stake = 10) {
  const now = Date.now();
  if (parlayCache.data && now - parlayCache.at < PARLAY_TTL) return parlayCache.data;
  const { generateDailyParlays } = await import("./parlays.mjs");
  const data = await generateDailyParlays(stake);
  parlayCache = { at: now, data };
  return data;
}

// shape FanDuel's single-book props into the same structure the Odds-API path returns, so the
// renderer draws them unchanged. No other book, so best = null (nothing "beats FanDuel").
function mapFanduelProps(fd) {
  const price = (ml, implied) => ({ primary: fmtAmerican(ml), primaryRaw: ml, best: null, bestBook: null, bestRaw: null, beats: false, implied: implied ?? ml2prob(ml) });
  return {
    scorers: fd.scorers.map((s) => ({ player: s.player, prob: null, twoSided: false, price: price(s.ml, s.implied) })),
    sot: fd.sot.map((s) => ({ player: s.player, line: s.line, fairOver: s.fairOver, price: price(s.over) })),
    source: "fanduel",
  };
}

// pregame projections are only computed before kickoff; snapshot them to disk so we can show
// them again (to compare against the live/final stats) once the game has started. Keyed by event.
const PREGAME_FILE = join(dirname(fileURLToPath(import.meta.url)), "bets", "pregame.json");
function loadPregameStore() { try { return JSON.parse(readFileSync(PREGAME_FILE, "utf8")); } catch { return {}; } }
function savePregame(id, proj) {
  try {
    const store = loadPregameStore();
    store[id] = { savedAt: Date.now(), proj };
    if (!existsSync(dirname(PREGAME_FILE))) mkdirSync(dirname(PREGAME_FILE), { recursive: true });
    writeFileSync(PREGAME_FILE, JSON.stringify(store));
  } catch { /* best-effort */ }
}
function loadPregame(id) { const e = loadPregameStore()[id]; return e ? e.proj : null; }

// grade saved pregame projections against the actual final box score (corners total + total
// shots), persisting actuals so finished games aren't refetched. Returns accuracy aggregates:
// { corners: { n, mae, projAvg, actualAvg }, shots: {...} } — answers "are these any good?"
export async function getProjectionAccuracy() {
  const store = loadPregameStore();
  const num = (v) => parseInt(v || 0, 10) || 0;
  let changed = false;
  for (const id of Object.keys(store)) {
    const e = store[id];
    if (e.graded || !e.proj) continue;
    try {
      const sum = await summary(id);
      if (!sum.header?.competitions?.[0]?.status?.type?.completed) continue;
      const teams = sum.boxscore?.teams || [];
      const hm = statMap(teams[0] || {}), am = statMap(teams[1] || {});
      const corners = num(hm.wonCorners) + num(am.wonCorners);
      const shots = num(hm.totalShots) + num(am.totalShots);
      e.actual = { cornersTotal: corners || null, shotsTotal: shots || null };
      e.graded = true; changed = true;
    } catch { /* not final / fetch failed */ }
  }
  if (changed) { try { writeFileSync(PREGAME_FILE, JSON.stringify(store)); } catch { /* ignore */ } }
  const cP = [], cA = [], sP = [], sA = [];
  for (const id of Object.keys(store)) {
    const e = store[id];
    if (!e.graded || !e.actual || !e.proj) continue;
    if (e.actual.cornersTotal != null && e.proj.corners?.total != null) { cP.push(e.proj.corners.total); cA.push(e.actual.cornersTotal); }
    const sProj = (e.proj.shots?.home?.shots || 0) + (e.proj.shots?.away?.shots || 0);
    if (e.actual.shotsTotal != null && sProj) { sP.push(sProj); sA.push(e.actual.shotsTotal); }
  }
  const agg = (P, A) => P.length ? {
    n: P.length,
    mae: P.reduce((s, p, i) => s + Math.abs(p - A[i]), 0) / P.length,
    projAvg: P.reduce((s, p) => s + p, 0) / P.length,
    actualAvg: A.reduce((s, a) => s + a, 0) / A.length,
  } : null;
  return { corners: agg(cP, cA), shots: agg(sP, sA) };
}

// the bet record for the widget: settles finished games, then returns calibration/performance
// stats plus the logged parlay history (newest day first). Cached briefly (settle hits network).
// betlog.mjs imports from this module, so import it lazily to avoid a load-time cycle.
let recordCache = { at: 0, data: null };
const RECORD_TTL = 5 * 60 * 1000; // 5 min
export async function getRecord() {
  const now = Date.now();
  if (recordCache.data && now - recordCache.at < RECORD_TTL) return recordCache.data;
  try {
    const bl = await import("./betlog.mjs");
    await bl.settle().catch(() => {});
    const log = bl.readLog();
    const projAccuracy = await getProjectionAccuracy().catch(() => null);
    const data = { stats: bl.stats(), recent: bl.statsRecent(7), projAccuracy, days: (log.days || []).slice().reverse() }; // newest first
    recordCache = { at: now, data };
    return data;
  } catch (e) {
    return { error: String(e?.message || e), stats: null, days: [] };
  }
}

// knockout rounds in bracket order (ESPN season.slug)
const KO_ORDER = ["round-of-32", "round-of-16", "quarterfinals", "semifinals", "third-place", "final"];
const KO_LABEL = { "round-of-32": "Round of 32", "round-of-16": "Round of 16", quarterfinals: "Quarter-finals", semifinals: "Semi-finals", "third-place": "Third place", final: "Final" };

// scan a window of fixtures for knockout games (season.slug != group-stage), grouped by round
async function scanKnockout() {
  const boards = await Promise.all(Array.from({ length: 16 }, (_, i) => scoreboardOn(ymd(i - 2)).catch(() => ({ events: [] }))));
  const seen = new Set(), byRound = new Map();
  for (const b of boards) for (const ev of b.events || []) {
    const slug = ev.season?.slug || "";
    if (!slug || slug === "group-stage" || seen.has(ev.id)) continue;
    seen.add(ev.id);
    const c = ev.competitions[0];
    const home = c.competitors.find((t) => t.homeAway === "home"), away = c.competitors.find((t) => t.homeAway === "away");
    const st = c.status.type.state;
    (byRound.get(slug) || byRound.set(slug, []).get(slug)).push({
      id: ev.id, date: ev.date,
      homeAbbr: home.team.abbreviation, awayAbbr: away.team.abbreviation, homeLogo: home.team.logo, awayLogo: away.team.logo,
      homeScore: Number(home.score) || 0, awayScore: Number(away.score) || 0,
      state: st, statusText: st === "in" ? (c.status.displayClock || "LIVE") : st === "post" ? "FT" : null,
    });
  }
  return [...byRound.entries()]
    .sort((a, b) => KO_ORDER.indexOf(a[0]) - KO_ORDER.indexOf(b[0]))
    .map(([slug, games]) => ({ slug, label: KO_LABEL[slug] || slug, games: games.sort((x, y) => new Date(x.date) - new Date(y.date)) }));
}

// group standings (all 12 groups) + a knockout bracket once the group stage finishes. Cached.
let standingsCache = { at: 0, data: null };
const STANDINGS_TTL = 10 * 60 * 1000;
export async function getStandings() {
  const now = Date.now();
  if (standingsCache.data && now - standingsCache.at < STANDINGS_TTL) return standingsCache.data;
  try {
    const j = await getJSON("https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings");
    const num = (st, k) => (st[k] ? (st[k].value ?? parseFloat(st[k].displayValue)) : null);
    const groups = (j.children || []).map((g) => {
      const entries = (g.standings?.entries || []).map((e) => {
        const st = Object.fromEntries((e.stats || []).map((s) => [s.name, s]));
        return {
          abbr: e.team?.abbreviation || "", name: e.team?.displayName || "", logo: e.team?.logos?.[0]?.href || null,
          rank: num(st, "rank"), played: num(st, "gamesPlayed") || 0,
          w: num(st, "wins") || 0, d: num(st, "ties") || 0, l: num(st, "losses") || 0,
          gd: st.pointDifferential?.displayValue ?? String(num(st, "pointDifferential") ?? "0"),
          pts: num(st, "points") || 0, advanced: num(st, "advanced") === 1,
        };
      }).sort((a, b) => (a.rank || 9) - (b.rank || 9));
      return { name: g.name || g.abbreviation || "Group", entries };
    });
    const groupStageDone = groups.length > 0 && groups.every((g) => g.entries.length && g.entries.every((e) => e.played >= 3));
    const knockout = await scanKnockout().catch(() => []);
    const data = { groups, groupStageDone, knockout };
    standingsCache = { at: now, data };
    return data;
  } catch (e) {
    return { error: String(e?.message || e), groups: [], knockout: [] };
  }
}

// high-level state for the widget: a single match view (by query, or the lone live game),
// plus the day's match list for the picker. Never throws — returns { error } instead.
export async function getWidgetState(query) {
  try {
    // pull previous days + today + the next 2 (merged, de-duped) so BOTH past (finished) and
    // future games from the picker resolve — not just today's. Previously this used today-only
    // scoreboard(), so clicking a past or future game found nothing and showed a blank view.
    const boards = await Promise.all([-2, -1, 0, 1, 2].map((i) => scoreboardOn(ymd(i)).catch(() => ({ events: [] }))));
    const seen = new Set(), events = [];
    for (const b of boards) for (const e of b.events || []) if (!seen.has(e.id)) { seen.add(e.id); events.push(e); }
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
    const comp0 = ev.competitions[0];
    const h0 = comp0.competitors.find((t) => t.homeAway === "home");
    const a0 = comp0.competitors.find((t) => t.homeAway === "away");
    const homeRef = { name: h0.team.displayName, abbr: h0.team.abbreviation };
    const awayRef = { name: a0.team.displayName, abbr: a0.team.abbreviation };
    // real xG once live; Action Network splits + FanDuel odds always; pregame projections
    // (corners/saves/xG priors from Round 1 form) only before kickoff — all best-effort, parallel
    const isPre = comp0.status.type.state === "pre";
    const [realXG, publicBetting, priors, conditions] = await Promise.all([
      isPre ? Promise.resolve(null) : fotmobXG(homeRef, awayRef, ev.date),
      actionPublicBetting(homeRef, awayRef),
      isPre ? pregameProjections(homeRef, awayRef) : Promise.resolve(null),
      matchConditions(ev, homeRef, awayRef),
    ]);
    // persist the pregame projection while still pre; once live/finished, re-attach the saved
    // snapshot so the section stays visible to compare against the actual stats. (scorePrediction
    // only blends priors when state==="pre", so a restored snapshot never alters the live model.)
    let pregame = priors;
    if (isPre && priors) savePregame(ev.id, priors);
    else if (!isPre) {
      const saved = loadPregame(ev.id);
      if (saved) pregame = { ...saved, basis: `${saved.basis || "pre"} · saved pre-kickoff` };
    }
    const view = buildMatchView(ev, sum, liveOdds, realXG, publicBetting, pregame, conditions);
    // pre-match per-player projections (model est., display-only) from recent form — feeds both
    // the projected shots-on-target and predicted-scorer sections in the widget
    if (isPre) {
      try {
        const [hp, ap] = await Promise.all([fotmobPlayerSOT(homeRef), fotmobPlayerSOT(awayRef)]);
        if ((hp && hp.length) || (ap && ap.length)) view.playerProj = { home: hp || [], away: ap || [] };
      } catch { /* best-effort */ }
    }
    // player props: prefer The Odds API (multi-book, de-vigged consensus). When it's
    // unavailable (no key / quota / 401), fall back to FanDuel's own public prices so the
    // section still populates — single-book, so no cross-market edge, display only.
    let props = null;
    if (liveOdds?.ev?.id) { try { props = await fetchPlayerProps(liveOdds.ev.id); } catch { props = null; } }
    if (!props || (!props.scorers?.length && !props.sot?.length)) {
      try {
        const fd = await fanduelProps(homeRef, awayRef);
        if (fd && (fd.scorers.length || fd.sot.length)) props = mapFanduelProps(fd);
      } catch { /* keep whatever we had */ }
    }
    view.playerProps = props;
    return { match: view, matches };
  } catch (e) {
    return { error: String(e?.message || e), matches: [] };
  }
}
