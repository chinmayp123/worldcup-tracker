// fanduel — best-effort reads from FanDuel's PUBLIC sportsbook API (no login required).
//
// FanDuel's own website frontend calls these endpoints with a public app key (_ak), so there's
// no auth, no account, and no credentials involved. We use it for ONE thing the free feeds
// (ESPN, Action Network, The Odds API) don't carry: TOTAL MATCH CORNERS over/under, priced for
// real. That lets a corner leg be a genuine model-vs-market edge (our corner projection vs a
// real price) instead of the model grading its own homework. Goal-scorer / shots-on-target
// props come from The Odds API; keeper SAVES are not a market FanDuel posts for soccer, so
// there is nothing to read there — they stay model-only / display-only.
//
// CONFIRMED against the live API: the host, the _ak key, /api/in-play and /api/event-page, and
// the market/runner schema (marketType, runners[].winRunnerOdds.americanDisplayOdds.americanOdds,
// runners[].handicap = the O/U line). The soft part is EVENT DISCOVERY for a specific match —
// we match FanDuel's soccer listing by team name and return null on any miss, so every caller
// degrades cleanly to ML + totals + props. Never throws.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
// FanDuel's public web-app key — a constant baked into their frontend bundle, not a secret.
const AK = "FhMFpcPWXMeyZxOx";

function cfg() {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    return JSON.parse(readFileSync(join(here, "odds.config.json"), "utf8"));
  } catch { return {}; }
}
const REGION = (process.env.FANDUEL_REGION || cfg().fanduelRegion || "nj").toLowerCase();
const BASE = `https://sbapi.${REGION}.sportsbook.fanduel.com/api`;
// the FanDuel page that lists World Cup matches. Paste the slug from the sportsbook URL
// (e.g. sportsbook.fanduel.com/navigation/soccer/fifa-world-cup -> "fifa-world-cup") into
// odds.config.json as "fanduelWorldCupPageId". Without it we can still read LIVE matches via
// /in-play, just not upcoming ones — set it to cover pre-match corner lines.
const WC_PAGE = process.env.FANDUEL_WC_PAGE || cfg().fanduelWorldCupPageId || null;
const H = { "User-Agent": UA, "Accept": "application/json", "Referer": "https://sportsbook.fanduel.com/" };

const norm = (s) => (s || "").toLowerCase().replace(/\b(and|the|fc|afc)\b/g, "").replace(/[^a-z]/g, "");
// does a FanDuel event name contain this team (by full name or 3-letter abbr)?
function nameIn(eventName, ref) {
  const x = norm(eventName); if (!x) return false;
  return [ref?.name, ref?.abbr].filter(Boolean).map(norm).some((c) => c && (x.includes(c) || c.includes(x)));
}

let _cache = { at: 0, events: null };
// FanDuel soccer events (live via /in-play, upcoming via the configured WC page), de-duped.
async function fetchSoccerEvents() {
  const now = Date.now();
  if (_cache.events && now - _cache.at < 120000) return _cache.events;
  const urls = [
    `${BASE}/in-play?_ak=${AK}&timezone=America/New_York`,
    WC_PAGE ? `${BASE}/content-managed-page?page=CUSTOM&customPageId=${encodeURIComponent(WC_PAGE)}&_ak=${AK}&timezone=America/New_York` : null,
  ].filter(Boolean);
  const byId = new Map();
  for (const u of urls) {
    try {
      const r = await fetch(u, { headers: H });
      if (!r.ok) continue;
      const j = await r.json();
      for (const ev of Object.values(j.attachments?.events || {})) if (ev?.eventId) byId.set(ev.eventId, ev);
    } catch { /* skip this source */ }
  }
  _cache = { at: now, events: [...byId.values()] };
  return _cache.events;
}

const _mktCache = new Map(); // eventId -> { at, markets }
async function eventMarkets(eventId) {
  const now = Date.now();
  const hit = _mktCache.get(eventId);
  if (hit && now - hit.at < 120000) return hit.markets;
  const r = await fetch(`${BASE}/event-page?eventId=${eventId}&_ak=${AK}&timezone=America/New_York`, { headers: H });
  if (!r.ok) throw new Error(`FanDuel event-page HTTP ${r.status}`);
  const j = await r.json();
  const markets = Object.values(j.attachments?.markets || {});
  _mktCache.set(eventId, { at: now, markets });
  return markets;
}

// every market for the FanDuel event that matches an ESPN match (home/away { name, abbr }), or null
async function matchMarkets(home, away) {
  const events = await fetchSoccerEvents();
  const ev = events.find((e) => nameIn(e.name, home) && nameIn(e.name, away));
  return ev ? eventMarkets(ev.eventId) : null;
}

// american price off a runner, tolerant of the two shapes FanDuel returns
const american = (runner) =>
  runner?.winRunnerOdds?.americanDisplayOdds?.americanOdds ??
  (typeof runner?.price === "number" ? runner.price : null);
const ml2prob = (ml) => (ml == null ? null : ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100));

// total match corners over/under for an ESPN match (home/away are { name, abbr }), or null.
// Returns { line, over, under, source } with american odds. Main full-match line only — we
// skip team-corners and alternate lines so the parlay prices against the headline number.
export async function fanduelCorners(home, away) {
  try {
    const markets = await matchMarkets(home, away);
    if (!markets) return null;
    const isCorner = (m, strict) => {
      const t = `${m.marketType || ""} ${m.marketName || ""}`.toLowerCase();
      if (!t.includes("corner") || !(m.runners || []).some((r) => /over/i.test(r.runnerName))) return false;
      if (strict) return t.includes("total") && !t.includes("team") && !t.includes("alternate");
      return true;
    };
    const corner = markets.find((m) => isCorner(m, true)) || markets.find((m) => isCorner(m, false));
    if (!corner) return null;
    const over = (corner.runners || []).find((r) => /over/i.test(r.runnerName));
    const under = (corner.runners || []).find((r) => /under/i.test(r.runnerName));
    const line = over?.handicap ?? under?.handicap ?? corner.handicap ?? null;
    if (line == null) return null;
    return { line, over: american(over), under: american(under), source: "fanduel" };
  } catch {
    return null;
  }
}

// debug: list the market names FanDuel posts for a match, so the prop parser can be tightened
// against the real naming. Returns [{ marketType, marketName }] or null. Not used at runtime.
export async function fanduelDumpMarkets(home, away) {
  try {
    const markets = await matchMarkets(home, away);
    return markets ? markets.map((m) => ({ marketType: m.marketType, marketName: m.marketName })) : null;
  } catch { return null; }
}

// both-teams-to-score Yes/No for a match (home/away { name, abbr }), or null.
// Returns { yes, no, source } with american odds. Full-match market only (skips half-time / halves).
export async function fanduelBTTS(home, away) {
  try {
    const markets = await matchMarkets(home, away);
    if (!markets) return null;
    const m = markets.find((mk) => {
      const t = `${mk.marketType || ""} ${mk.marketName || ""}`.toLowerCase();
      return (t.includes("both teams to score") || t.includes("btts"))
        && !t.includes("half") && !t.includes("1st") && !t.includes("2nd") && !t.includes("first") && !t.includes("second")
        && (mk.runners || []).some((r) => /yes/i.test(r.runnerName));
    });
    if (!m) return null;
    const yes = (m.runners || []).find((r) => /yes/i.test(r.runnerName));
    const no = (m.runners || []).find((r) => /no/i.test(r.runnerName));
    if (!yes) return null;
    return { yes: american(yes), no: american(no), source: "fanduel" };
  } catch {
    return null;
  }
}

// is a runner name an over/under side? returns "over" | "under" | null
const ouSide = (s) => (/\bover\b|^o\b|^o\d/i.test(s || "") ? "over" : /\bunder\b|^u\b|^u\d/i.test(s || "") ? "under" : null);

// FanDuel player props for a match: anytime scorer + shots on target, real FanDuel prices.
// Single-book, so NO cross-market edge: scorer is one-sided (vigged implied only); SoT is
// two-sided so we de-vig FanDuel's own over/under into a fair prob. For DISPLAY, not value
// legs (an edge needs a second book — see DATA_SOURCES.md). Returns { scorers, sot } or null.
//
// FanDuel's exact prop market/runner naming for soccer isn't validatable from here, so the
// parsing is defensive across the two common shapes (player in the market name with Over/Under
// runners, or player as the runner name with the line on `handicap`). Confirm with the probe
// in DATA_SOURCES.md if a match shows no props.
export async function fanduelProps(home, away) {
  try {
    const markets = await matchMarkets(home, away);
    if (!markets) return null;
    const scorers = [];
    const sotByPlayer = new Map(); // player -> { player, line, over, under }
    for (const m of markets) {
      const mt = `${m.marketType || ""} ${m.marketName || ""}`.toLowerCase();
      const runners = m.runners || [];
      const isScorer = (mt.includes("goalscorer") || mt.includes("to score") || mt.includes("anytime scorer"))
        && !mt.includes("first") && !mt.includes("last") && !mt.includes("hat") && !mt.includes("brace");
      const isSot = mt.includes("shot") && mt.includes("target");
      if (isScorer) {
        for (const r of runners) {
          const name = r.runnerName;
          if (!name || ouSide(name) || /\byes\b|\bno\b/i.test(name)) continue; // runners are players
          const ml = american(r);
          if (ml != null) scorers.push({ player: name, ml, implied: ml2prob(ml) });
        }
      } else if (isSot) {
        // player may be on the market name (runners = Over/Under) or be the runner name itself
        const namedOnMarket = m.marketName && /[a-z]/i.test(m.marketName) && runners.some((r) => ouSide(r.runnerName));
        for (const r of runners) {
          const side = ouSide(r.runnerName);
          const player = namedOnMarket ? m.marketName.replace(/shots?\s*on\s*target.*/i, "").replace(/[-–|].*/, "").trim() : (side ? null : r.runnerName);
          const key = player || m.marketName;
          if (!key) continue;
          const rec = sotByPlayer.get(key) || { player: key.replace(/\s*o\/?u.*/i, "").trim(), line: r.handicap ?? null, over: null, under: null };
          if (rec.line == null && r.handicap != null) rec.line = r.handicap;
          if (side === "over") rec.over = american(r);
          else if (side === "under") rec.under = american(r);
          sotByPlayer.set(key, rec);
        }
      }
    }
    const sot = [...sotByPlayer.values()]
      .filter((s) => s.over != null && s.line != null)
      .map((s) => {
        const po = ml2prob(s.over), pu = ml2prob(s.under);
        const fairOver = po != null && pu != null ? po / (po + pu) : po; // de-vig FanDuel's own 2-way
        return { player: s.player, line: s.line, over: s.over, under: s.under, fairOver };
      });
    // dedupe scorers (keep shortest price string per player), sort by implied prob
    const byPlayer = new Map();
    for (const s of scorers) if (!byPlayer.has(s.player) || (s.implied ?? 0) > (byPlayer.get(s.player).implied ?? 0)) byPlayer.set(s.player, s);
    const scorersOut = [...byPlayer.values()].sort((a, b) => (b.implied ?? 0) - (a.implied ?? 0)).slice(0, 6);
    sot.sort((a, b) => (b.fairOver ?? 0) - (a.fairOver ?? 0));
    if (!scorersOut.length && !sot.length) return null;
    return { scorers: scorersOut, sot: sot.slice(0, 6), source: "fanduel" };
  } catch {
    return null;
  }
}
