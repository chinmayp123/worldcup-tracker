// fotmob — free xG / shot-level + match data for World Cup matches.
//
// FotMob is a Next.js app. Its /api/* endpoints are gated behind a rotating signed
// `x-mas` header, but the public pages embed the same server-rendered data in a
// <script id="__NEXT_DATA__"> tag, which is NOT gated. We read that JSON: no key, no auth.
//
// One match-page fetch (cached) yields shots, momentum, team stats (real xG / xGOT / big
// chances), top players, and recent form. Unofficial source — best-effort: any failure
// returns null and callers fall back to their proxy. Never throws to callers.

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36";
const WC_LEAGUE = 77;                  // FotMob league id for the FIFA World Cup
const FIXTURES_TTL = 10 * 60 * 1000;   // fixture list changes rarely
const MATCH_TTL = 45 * 1000;           // a live match's data updates as it plays

async function getHtml(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US" } });
  if (!res.ok) throw new Error(`FotMob HTTP ${res.status}`);
  return res.text();
}

// every FotMob page embeds its server props here — `props.pageProps` is the payload
function nextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]).props?.pageProps ?? null; } catch { return null; }
}

const norm = (s) => (s || "").toLowerCase().replace(/\b(and|the)\b/g, "").replace(/[^a-z]/g, "");
function nameMatch(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || x.includes(y) || y.includes(x);
}
const sideMatch = (anName, t) => nameMatch(anName, t?.name) || (t?.abbr && nameMatch(anName, t.abbr));

let _fixtures = { at: 0, data: null };
// full WC fixture list: [{ id, pageUrl, home:{id,name}, away:{id,name}, utcTime, finished, started }]
export async function fetchFotmobFixtures() {
  const now = Date.now();
  if (_fixtures.data && now - _fixtures.at < FIXTURES_TTL) return _fixtures.data;
  const pp = nextData(await getHtml(`https://www.fotmob.com/leagues/${WC_LEAGUE}/matches/world-cup`));
  const all = pp?.fixtures?.allMatches || [];
  const data = all.map((m) => ({
    id: String(m.id),
    pageUrl: m.pageUrl,
    home: { id: m.home?.id, name: m.home?.name },
    away: { id: m.away?.id, name: m.away?.name },
    utcTime: m.status?.utcTime || null,
    finished: !!m.status?.finished,
    started: !!m.status?.started,
  }));
  _fixtures = { at: now, data };
  return data;
}

const _matches = new Map(); // pageUrl -> { at, data }
// raw match content (cached): teams, shots, momentum series, stats blob, top players, form
export async function fetchFotmobMatch(pageUrl) {
  if (!pageUrl) return null;
  const now = Date.now();
  const hit = _matches.get(pageUrl);
  if (hit && now - hit.at < MATCH_TTL) return hit.data;
  const pp = nextData(await getHtml(`https://www.fotmob.com${pageUrl}`));
  const g = pp?.general, content = pp?.content;
  if (!g || !content) return null;
  const data = {
    homeTeam: { id: g.homeTeam?.id, name: g.homeTeam?.name },
    awayTeam: { id: g.awayTeam?.id, name: g.awayTeam?.name },
    shots: content.shotmap?.shots || [],
    momentum: content.momentum?.main?.data || content.matchFacts?.momentum?.main?.data || [],
    stats: content.stats,
    topPlayers: content.matchFacts?.topPlayers,
    teamForm: content.matchFacts?.teamForm,
  };
  _matches.set(pageUrl, { at: now, data });
  return data;
}

// aggregate the shotmap into team + per-player xG, oriented to FotMob's own home/away.
export function aggregateShotmap(shots, homeId, awayId) {
  const side = (teamId) => (teamId === homeId ? "home" : teamId === awayId ? "away" : null);
  const team = { home: { xg: 0, shots: 0, sot: 0, goals: 0 }, away: { xg: 0, shots: 0, sot: 0, goals: 0 } };
  const byPlayer = new Map();
  for (const s of shots || []) {
    const sd = side(s.teamId);
    if (!sd) continue;
    const xg = Number(s.expectedGoals) || 0;
    const isGoal = s.eventType === "Goal";
    team[sd].xg += xg; team[sd].shots += 1;
    if (s.isOnTarget) team[sd].sot += 1;
    if (isGoal) team[sd].goals += 1;
    const key = `${s.playerName}|${sd}`;
    const p = byPlayer.get(key) || { name: s.playerName, side: sd, xg: 0, shots: 0, sot: 0, goals: 0 };
    p.xg += xg; p.shots += 1;
    if (s.isOnTarget) p.sot += 1;
    if (isGoal) p.goals += 1;
    byPlayer.set(key, p);
  }
  return { home: team.home, away: team.away, players: [...byPlayer.values()].sort((a, b) => b.xg - a.xg) };
}

// pull a {home, away} numeric pair for a stat by title from FotMob's stats blob
function statPair(stats, ...titles) {
  const groups = stats?.Periods?.All?.stats || [];
  const want = titles.map((t) => t.toLowerCase());
  for (const g of groups) {
    for (const s of g.stats || []) {
      if (want.includes((s.title || "").toLowerCase()) && Array.isArray(s.stats) && s.stats[0] != null) {
        return { home: Number(s.stats[0]), away: Number(s.stats[1]) };
      }
    }
  }
  return null;
}

// top 3 players by rating per side: [{ name, rating }]
function parseTopPlayers(tp) {
  const conv = (obj) => Object.values(obj || {})
    .map((p) => ({ name: p?.name?.fullName || p?.name, rating: Number(p?.playerRating) || Number(p?.playerRatingRounded) || null }))
    .filter((p) => p.name && p.rating != null)
    .sort((a, b) => b.rating - a.rating)
    .slice(0, 3);
  if (!tp) return null;
  return { home: conv(tp.homeTopPlayers), away: conv(tp.awayTopPlayers) };
}

// recent form as ["W","D","L",...] (most recent last), per side
function parseForm(tf) {
  if (!Array.isArray(tf)) return null;
  const code = { 1: "W", 0: "D", 2: "L" };
  const fmt = (arr) => (arr || []).map((x) => x.resultString || code[x.result] || "").filter(Boolean).slice(-5);
  return { home: fmt(tf[0]), away: fmt(tf[1]) };
}

const orientPair = (pair, aligned) => (!pair ? null : aligned ? pair : { home: pair.away, away: pair.home });

// A team's per-match rates from its most recent finished WC match (Round 1 form), oriented
// to that team as for/against. team is { name, abbr }. Returns null if no finished match.
export async function fotmobTeamRates(team) {
  try {
    const fixtures = await fetchFotmobFixtures();
    const played = fixtures.filter((f) => f.finished && (sideMatch(f.home.name, team) || sideMatch(f.away.name, team)));
    if (!played.length) return null;
    played.sort((a, b) => String(b.utcTime || "").localeCompare(String(a.utcTime || "")));
    const m = await fetchFotmobMatch(played[0].pageUrl);
    if (!m) return null;
    const isHome = sideMatch(m.homeTeam.name, team);
    const pick = (pair) => (pair ? (isHome ? { for: pair.home, against: pair.away } : { for: pair.away, against: pair.home }) : null);
    const xg = pick(statPair(m.stats, "Expected goals (xG)", "Expected goals"));
    const corners = pick(statPair(m.stats, "Corners"));
    const sot = pick(statPair(m.stats, "Shots on target"));
    const shots = pick(statPair(m.stats, "Total shots", "Shots"));
    if (!xg && !corners && !sot && !shots) return null;
    return {
      games: 1,
      xgFor: xg?.for ?? 1.2, xgAgainst: xg?.against ?? 1.2,
      cornersFor: corners?.for ?? 5, cornersAgainst: corners?.against ?? 5,
      sotFor: sot?.for ?? 4, sotAgainst: sot?.against ?? 4,
      shotsFor: shots?.for ?? 12, shotsAgainst: shots?.against ?? 12,
    };
  } catch {
    return null;
  }
}

// High-level resolver: real xG + match data for an ESPN match, oriented to ESPN home/away.
// home / away are { name, abbr }. Returns a rich object or null. Never throws.
export async function fotmobXG(home, away, dateISO) {
  try {
    const fixtures = await fetchFotmobFixtures();
    if (!fixtures?.length) return null;
    const cand = fixtures.filter((f) =>
      (sideMatch(f.home.name, home) && sideMatch(f.away.name, away)) ||
      (sideMatch(f.home.name, away) && sideMatch(f.away.name, home)));
    if (!cand.length) return null;
    const day = dateISO ? new Date(dateISO).toISOString().slice(0, 10) : null;
    const fx = (day && cand.find((f) => f.utcTime && f.utcTime.slice(0, 10) === day)) || cand[0];
    const m = await fetchFotmobMatch(fx.pageUrl);
    if (!m) return null;
    const agg = aggregateShotmap(m.shots, m.homeTeam.id, m.awayTeam.id);

    const aligned = sideMatch(m.homeTeam.name, home);
    const flip = (sd) => (aligned ? sd : sd === "home" ? "away" : "home");
    // prefer FotMob's published team xG; fall back to the shotmap sum
    const xgStat = orientPair(statPair(m.stats, "Expected goals (xG)", "Expected goals"), aligned);
    const shotsAgg = { home: aligned ? agg.home : agg.away, away: aligned ? agg.away : agg.home };
    const homeTeam = { ...shotsAgg.home, xg: xgStat ? xgStat.home : shotsAgg.home.xg };
    const awayTeam = { ...shotsAgg.away, xg: xgStat ? xgStat.away : shotsAgg.away.xg };

    const xgot = orientPair(statPair(m.stats, "xG on target (xGOT)"), aligned);
    const bigCh = orientPair(statPair(m.stats, "Big chances"), aligned);
    const bigChMissed = orientPair(statPair(m.stats, "Big chances missed"), aligned);

    // momentum: positive value = home pressure in FotMob orientation; flip sign if needed
    const momentum = (m.momentum || []).map((d) => ({
      min: d.minute ?? d.min ?? 0,
      v: (Number(d.value) || 0) * (aligned ? 1 : -1),
    }));

    const tp = parseTopPlayers(m.topPlayers);
    const form = parseForm(m.teamForm);

    return {
      source: "fotmob",
      matchId: fx.id,
      home: homeTeam,
      away: awayTeam,
      players: agg.players.map((p) => ({ ...p, side: flip(p.side) })),
      xgot, bigChances: bigCh, bigChancesMissed: bigChMissed,
      momentum,
      topPlayers: tp ? (aligned ? tp : { home: tp.away, away: tp.home }) : null,
      form: form ? (aligned ? form : { home: form.away, away: form.home }) : null,
    };
  } catch {
    return null;
  }
}
