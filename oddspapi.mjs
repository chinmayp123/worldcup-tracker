// oddspapi — Corners (O/U) and Both-Teams-To-Score markets for World Cup games via the OddsPapi
// API (free tier, multi-book). FanDuel's public API is flaky to reach; OddsPapi reliably carries
// these for WC fixtures, so we use it as the PRIMARY source for corner + BTTS legs (FanDuel's
// public API stays a fallback). One odds-by-tournaments call covers every game, so it's light on
// the 250-req/month free quota. Never throws — returns null on any miss.
//
// Key lives in odds.config.json as "oddspapiKey" (gitignored), or the ODDSPAPI_KEY env var.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const API = "https://api.oddspapi.io/v4";
const SOCCER = 10, WC = 16;
const H = { Accept: "application/json", "User-Agent": "worldcup-tracker" };

function cfg() {
  try { return JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "odds.config.json"), "utf8")); }
  catch { return {}; }
}
const KEY = process.env.ODDSPAPI_KEY || cfg().oddspapiKey || null;
// books to try in order for the price (the venue you bet first, then a liquid backup). Kept to
// two to limit how many calls a cache-miss can cost against the 250-req/month free quota.
const BOOKS = (process.env.ODDSPAPI_BOOKS || cfg().oddspapiBooks || "fanduel,bet365").split(",").map((s) => s.trim()).filter(Boolean);

const get = async (path) => {
  const r = await fetch(`${API}${path}${path.includes("?") ? "&" : "?"}apiKey=${KEY}`, { headers: H });
  if (!r.ok) throw new Error(`OddsPapi HTTP ${r.status}`);
  return r.json();
};
const arr = (j) => (Array.isArray(j) ? j : (j?.data || []));
const norm = (s) => (s || "").toLowerCase().replace(/[^a-z]/g, "");

// static market catalogue: marketId -> { marketName, marketType, handicap, outcomes } (cached 12h)
let _markets = { at: 0, map: null };
async function marketsRef() {
  const now = Date.now();
  if (_markets.map && now - _markets.at < 12 * 3600 * 1000) return _markets.map;
  const map = {};
  for (const m of arr(await get("/markets"))) map[m.marketId] = m;
  _markets = { at: now, map };
  return map;
}

// WC fixtures with team names/abbrs, keyed by fixtureId (cached 2h — fixtures don't change intraday)
let _fix = { at: 0, map: null };
async function fixtureNames() {
  const now = Date.now();
  if (_fix.map && now - _fix.at < 2 * 3600 * 1000) return _fix.map;
  const ymd = (off) => new Date(now + off * 86400000).toISOString().slice(0, 10);
  const map = {};
  for (const f of arr(await get(`/fixtures?sportId=${SOCCER}&tournamentIds=${WC}&from=${ymd(-2)}&to=${ymd(7)}`)))
    map[f.fixtureId] = [f.participant1Abbr, f.participant1Name, f.participant2Abbr, f.participant2Name].map(norm);
  _fix = { at: now, map };
  return map;
}

// one bookmaker's odds for every WC fixture (all markets), cached per book (30 min — matches the
// parlay cache, and pre-match corner/BTTS lines barely move; keeps monthly call count low)
const _odds = new Map();
async function tournamentOdds(book) {
  const now = Date.now();
  const hit = _odds.get(book);
  if (hit && now - hit.at < 30 * 60 * 1000) return hit.data;
  const data = arr(await get(`/odds-by-tournaments?bookmaker=${book}&tournamentIds=${WC}`));
  _odds.set(book, { at: now, data });
  return data;
}

// the markets object for the first book that covers this ESPN match (home/away { name, abbr })
async function matchMarkets(home, away) {
  if (!KEY) return null;
  const names = await fixtureNames();
  const wantH = [norm(home.abbr), norm(home.name)].filter(Boolean);
  const wantA = [norm(away.abbr), norm(away.name)].filter(Boolean);
  const hit = (toks, wants) => wants.some((w) => toks.some((t) => t && (t === w || t.includes(w) || w.includes(t))));
  for (const book of BOOKS) {
    let odds;
    try { odds = await tournamentOdds(book); } catch { continue; }
    const fx = odds.find((f) => {
      const toks = names[f.fixtureId];
      return f.bookmakerOdds?.[book] && toks && hit(toks, wantH) && hit(toks, wantA);
    });
    if (fx) return { markets: fx.bookmakerOdds[book].markets || {}, book };
  }
  return null;
}

// american price for the first outcome whose name matches rx, via the market catalogue
function priceByName(market, ref, rx) {
  for (const o of ref.outcomes || []) {
    if (rx.test(o.outcomeName)) {
      const p = Object.values(market.outcomes?.[o.outcomeId]?.players || {})[0];
      if (p?.priceAmerican != null) return Number(p.priceAmerican);
    }
  }
  return null;
}
const implied = (ml) => (ml == null ? null : ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100));

// full-match total corners over/under for a match → { line, over, under } (main line) or null
export async function oddspapiCorners(home, away) {
  try {
    const mm = await matchMarkets(home, away);
    if (!mm) return null;
    const ref = await marketsRef();
    const lines = [];
    for (const id of Object.keys(mm.markets)) {
      const r = ref[id];
      if (!r || r.marketType !== "totals-corners" || /half/i.test(r.marketName)) continue;
      const over = priceByName(mm.markets[id], r, /over/i), under = priceByName(mm.markets[id], r, /under/i);
      if (r.handicap != null && over != null) lines.push({ line: r.handicap, over, under });
    }
    if (!lines.length) return null;
    // main line = the most balanced (over-implied closest to 50%) — the book's headline number
    lines.sort((a, b) => Math.abs(implied(a.over) - 0.5) - Math.abs(implied(b.over) - 0.5));
    return { ...lines[0], source: "oddspapi" };
  } catch { return null; }
}

// full-match both-teams-to-score for a match → { yes, no } or null
export async function oddspapiBTTS(home, away) {
  try {
    const mm = await matchMarkets(home, away);
    if (!mm) return null;
    const ref = await marketsRef();
    for (const id of Object.keys(mm.markets)) {
      const r = ref[id];
      if (!r || r.marketType !== "bothteamsscore" || /half/i.test(r.marketName)) continue;
      const yes = priceByName(mm.markets[id], r, /yes/i), no = priceByName(mm.markets[id], r, /no/i);
      if (yes != null) return { yes, no, source: "oddspapi" };
    }
    return null;
  } catch { return null; }
}
