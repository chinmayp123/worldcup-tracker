// actionnetwork — free public-betting splits (tickets % vs money %) for World Cup matches.
//
// Action Network's web API (api.actionnetwork.com) returns per-outcome public-betting data
// for soccer without auth or a paywall. We read the soccer scoreboard, map a match by team
// name, and orient the splits to the ESPN home/away.
//
// The signal: "tickets %" is the share of BETS on an outcome (the public), "money %" is the
// share of DOLLARS. When money % trails tickets % on the public side, sharper/bigger wagers
// are relatively elsewhere — a contrarian "fade the public" lean (not a lock).
//
// Unofficial source (their public API): best-effort, returns null on any failure. Never throws.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const SCOREBOARD = "https://api.actionnetwork.com/web/v2/scoreboard/soccer?period=game";
const TTL = 3 * 60 * 1000;       // public splits drift slowly; refetch at most every 3 min
const FADE_GAP = 8;              // min tickets−money gap (pts) on the public side to flag a fade

// normalize a team name: drop non-letters and the connectives that differ across feeds
// (e.g. ESPN "Bosnia-Herzegovina" vs Action Network "Bosnia and Herzegovina")
// Action Network book IDs for FanDuel (the main NJ feed first, then state variants)
const FANDUEL_IDS = [69, 252, 647, 213, 79, 972];
const ml2p = (ml) => (ml == null ? null : ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100));

const norm = (s) => (s || "").toLowerCase().replace(/\b(and|the)\b/g, "").replace(/[^a-z]/g, "");
function nameMatch(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}
// does an Action Network team (full name / display / abbr) match an ESPN ref { name, abbr }?
function teamMatches(anTeam, ref) {
  const cands = [anTeam?.full_name, anTeam?.display_name, anTeam?.abbr].filter(Boolean);
  return cands.some((c) => nameMatch(c, ref?.name) || (ref?.abbr && nameMatch(c, ref.abbr)));
}

let _cache = { at: 0, games: null };
export async function fetchActionGames() {
  const now = Date.now();
  if (_cache.games && now - _cache.at < TTL) return _cache.games;
  const res = await fetch(SCOREBOARD, { headers: { "User-Agent": UA, "Accept": "application/json" } });
  if (!res.ok) throw new Error(`Action Network HTTP ${res.status}`);
  const j = await res.json();
  _cache = { at: now, games: j.games || [] };
  return _cache.games;
}

// pull a market's outcomes + public-betting % from whichever book carries bet_info.
// key is "moneyline" | "spread" | "total"; returns { side -> {odds,line,tickets,money} } or null.
function extractMarket(game, key) {
  const markets = game.markets || {};
  for (const bookId of Object.keys(markets)) {
    const arr = markets[bookId]?.event?.[key] || markets[bookId]?.[key];
    if (!Array.isArray(arr)) continue;
    const informed = arr.filter((o) => o.bet_info && (o.bet_info.tickets || o.bet_info.money));
    if (informed.length < 2) continue; // need real public-betting data, not just prices
    const by = {};
    for (const o of arr) {
      if (!o.side) continue;
      const cand = {
        odds: o.odds ?? null,
        line: o.value ?? o.point ?? null,
        tickets: o.bet_info?.tickets?.percent ?? null,
        money: o.bet_info?.money?.percent ?? null,
      };
      // a live game can list a side twice — keep the first outcome that carries real data
      const cur = by[o.side];
      if (!cur || (cur.tickets == null && cand.tickets != null)) by[o.side] = cand;
    }
    if (Object.keys(by).length >= 2) return by;
  }
  return null;
}

// FanDuel's prices for a market (book 69 first, then state variants) → { side: {odds, line} }
function fanduelMarket(game, key) {
  const markets = game.markets || {};
  for (const id of FANDUEL_IDS) {
    const arr = markets[id]?.event?.[key] || markets[id]?.[key];
    if (!Array.isArray(arr)) continue;
    const by = {};
    for (const o of arr) { if (o.side && o.odds != null && by[o.side] == null) by[o.side] = { odds: o.odds, line: o.value ?? o.point ?? null }; }
    if (Object.keys(by).length >= 2) return by;
  }
  return null;
}

// Public-betting splits + real FanDuel odds for an ESPN match, oriented to ESPN home/away.
// home / away are { name, abbr }. Returns { source, outcomes, publicSide, sharpSide, fade,
// spread, total, fanduel } or null. Never throws.
export async function actionPublicBetting(home, away) {
  try {
    const games = await fetchActionGames();
    const g = games.find((x) => {
      const ts = x.teams || [];
      return ts.some((t) => teamMatches(t, home)) && ts.some((t) => teamMatches(t, away));
    });
    if (!g) return null;
    const ml = extractMarket(g, "moneyline");
    if (!ml) return null;

    // orient AN home/away to the ESPN match (AN's home may be the ESPN away)
    const teams = g.teams || [];
    const anHome = teams.find((t) => t.id === g.home_team_id) || teams[0];
    const aligned = teamMatches(anHome, home);
    const outcomes = {
      home: aligned ? ml.home : ml.away,
      draw: ml.draw || null,
      away: aligned ? ml.away : ml.home,
    };

    // spread + total public splits (over/under sides are not home/away, so no orientation)
    const spreadBy = extractMarket(g, "spread");
    const spread = spreadBy ? { home: aligned ? spreadBy.home : spreadBy.away, away: aligned ? spreadBy.away : spreadBy.home } : null;
    const totalBy = extractMarket(g, "total");
    const total = totalBy ? { over: totalBy.over || null, under: totalBy.under || null, line: totalBy.over?.line ?? totalBy.under?.line ?? null } : null;

    // real FanDuel prices (book 69): de-vigged moneyline (oriented) + total over/under for legs
    let fanduel = null;
    const fdMl = fanduelMarket(g, "moneyline");
    if (fdMl) {
      const ml = { home: fdMl.home?.odds, draw: fdMl.draw?.odds, away: fdMl.away?.odds };
      const raw = [ml2p(ml.home), ml2p(ml.draw), ml2p(ml.away)];
      const s = raw.reduce((x, y) => x + (y || 0), 0) || 1;
      const cell = (mlv, p) => ({ ml: mlv ?? null, prob: p != null ? Math.round((p / s) * 100) : null });
      const H = cell(ml.home, raw[0]), D = cell(ml.draw, raw[1]), A = cell(ml.away, raw[2]);
      const fdTot = fanduelMarket(g, "total");
      fanduel = {
        ...(aligned ? { home: H, draw: D, away: A } : { home: A, draw: D, away: H }),
        total: fdTot ? { line: fdTot.over?.line ?? fdTot.under?.line ?? null, over: fdTot.over?.odds ?? null, under: fdTot.under?.odds ?? null } : null,
      };
    }

    // signals: most-bet side (public) and the side with the largest money-over-tickets edge (sharp)
    const sides = ["home", "draw", "away"].filter((s) => outcomes[s] && outcomes[s].tickets != null);
    let publicSide = null, maxT = -1, sharpSide = null, maxDiv = -Infinity;
    for (const s of sides) {
      const c = outcomes[s];
      if (c.tickets > maxT) { maxT = c.tickets; publicSide = s; }
      const div = (c.money ?? c.tickets) - c.tickets;
      if (div > maxDiv) { maxDiv = div; sharpSide = s; }
    }
    const pub = publicSide ? outcomes[publicSide] : null;
    const gap = pub && pub.money != null ? pub.tickets - pub.money : 0;
    const fade = pub && gap >= FADE_GAP
      ? { publicSide, sharpSide, ticketsGap: Math.round(gap) }
      : null;

    return { source: "actionnetwork", outcomes, publicSide, sharpSide, fade, spread, total, fanduel };
  } catch {
    return null;
  }
}
