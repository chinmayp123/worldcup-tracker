#!/usr/bin/env node
// worldcup — live FIFA World Cup 2026 match tracker (ESPN public API, no key needed)
//
//   node worldcup.mjs                 auto-track the live game (or list if several)
//   node worldcup.mjs list            show today's matches
//   node worldcup.mjs canada          track a match by team name (or event id)
//   node worldcup.mjs usa --once      single snapshot, no refresh loop
//   node worldcup.mjs usa -i 15       refresh every 15s (default 30)
//   node worldcup.mjs groups          all 12 group tables
//
// Optional live odds (FanDuel + line shopping): set an ODDS_API_KEY env var, or
// put {"oddsApiKey":"..."} in odds.config.json (gitignored). Without a key it
// falls back to ESPN's pre-match line.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world";

// Optional live-odds key (The Odds API). Read from env or a gitignored config
// file next to this script — never hard-coded, so the public repo stays clean.
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
const ODDS_KEY = loadOddsKey();
const ODDS_BASE = "https://api.the-odds-api.com/v4/sports/soccer_fifa_world_cup/odds";

const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  cyan: "\x1b[36m", magenta: "\x1b[35m", gray: "\x1b[90m",
};
const c = (color, s) => `${C[color]}${s}${C.reset}`;

async function getJSON(url) {
  const res = await fetch(url, { headers: { "User-Agent": "worldcup-cli" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

const scoreboard = () => getJSON(`${BASE}/scoreboard`);
const scoreboardOn = (yyyymmdd) => getJSON(`${BASE}/scoreboard?dates=${yyyymmdd}`);
const summary = (id) => getJSON(`${BASE}/summary?event=${id}`);

// YYYYMMDD for `offset` days from today, built without Date.now()-style calls being an issue
function ymd(daysAhead = 0) {
  const d = new Date(Date.now() + daysAhead * 86400000);
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
}

// implied win % for each outcome, vig-stripped to sum to 100
function impliedProbs(odds) {
  if (!odds || odds.homeTeamOdds?.moneyLine == null) return null;
  const ml2p = (ml) => (ml == null ? 0 : ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100));
  const raw = [ml2p(odds.homeTeamOdds.moneyLine), ml2p(odds.drawOdds?.moneyLine), ml2p(odds.awayTeamOdds?.moneyLine)];
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  return raw.map((p) => Math.round((p / sum) * 100));
}

const ml2prob = (ml) => (ml == null ? null : ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100));
const fmtAmerican = (ml) => (ml == null ? "-" : ml > 0 ? `+${ml}` : `${ml}`);

// Poisson CDF P(X<=k) for integer k>=0, mean lambda — used for model-derived save lines
function poissonCdf(k, lambda) {
  if (k < 0) return 0;
  let term = Math.exp(-lambda), sum = term;
  for (let i = 1; i <= k; i++) { term *= lambda / i; sum += term; }
  return sum;
}
// fair American odds from a probability (no vig) — for model-derived lines, not a book price
function probToAmerican(p) {
  if (!(p > 0) || p >= 1) return null;
  return p > 0.5 ? Math.round((-p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100);
}
// current match minute from status (handles halftime / full time), or null pre-match
function matchMinute(st) {
  if (st?.type?.name === "STATUS_HALFTIME") return 45;
  if (st?.type?.state === "post") return 90;
  if (st?.type?.state !== "in") return null;
  const m = /(\d+)/.exec(st.displayClock || st.type?.shortDetail || "");
  return m ? Number(m[1]) : null;
}
// bracketed, color-coded confidence tag, shared by the live recs and the halftime read
const confTag = (cf) => {
  const label = `[${cf}]`;
  if (cf.startsWith("Strong")) return c("green", label);
  if (cf === "Lean") return c("cyan", label);
  return c("dim", label);
};

// model-derived saves line for a keeper: extrapolate the current save rate to full time
// and price an over/under (default 2.5) via Poisson. NO sportsbook in the feed offers a
// keeper-saves market, so this is explicitly a model estimate, never a real book price.
function keeperSaveLine(saves, minute, state, line = 2.5) {
  const FT = 95; // include typical stoppage time
  if (state === "post") return { proj: saves, settled: true, over: saves > line, line };
  if (minute == null) return null; // pre-match: nothing to project
  const elapsed = Math.max(minute, 10); // guard against early-game noise
  const rate = saves / elapsed; // saves per minute so far
  const remMin = Math.max(0, FT - minute);
  const lambdaRem = rate * remMin; // expected saves still to come
  const proj = saves + lambdaRem;
  const need = Math.ceil(line) - saves; // saves still required to clear the line
  const pOver = need <= 0 ? 1 : 1 - poissonCdf(need - 1, lambdaRem);
  return { proj, lambdaRem, pOver, need, line, settled: false };
}

// --- The Odds API: live multi-book odds (FanDuel + best-of-book line shopping) ---
// Cache to stay under the free tier's 500-request quota: refetch at most every 2 min.
let _oddsCache = { at: 0, events: null };
async function fetchOddsEvents() {
  if (!ODDS_KEY) return null;
  const now = Date.now();
  if (_oddsCache.events && now - _oddsCache.at < 120000) return _oddsCache.events;
  const url = `${ODDS_BASE}/?apiKey=${ODDS_KEY}&regions=us&markets=h2h&oddsFormat=american`;
  const res = await fetch(url, { headers: { "User-Agent": "worldcup-cli" } });
  if (!res.ok) throw new Error(`Odds API HTTP ${res.status}`);
  _oddsCache = {
    at: now,
    events: await res.json(),
    remaining: res.headers.get("x-requests-remaining"),
  };
  return _oddsCache.events;
}

const normTeam = (s) =>
  (s || "").toLowerCase().replace(/[^a-z]/g, "").replace(/^(the)/, "");
function teamsMatch(a, b) {
  const x = normTeam(a), y = normTeam(b);
  return x === y || x.includes(y) || y.includes(x);
}

// find the odds-API event matching an ESPN match, build a per-outcome book comparison
function matchOdds(events, homeName, awayName) {
  if (!events) return null;
  const ev = events.find(
    (e) =>
      (teamsMatch(e.home_team, homeName) && teamsMatch(e.away_team, awayName)) ||
      (teamsMatch(e.home_team, awayName) && teamsMatch(e.away_team, homeName))
  );
  if (!ev) return null;
  // collect every book's price for Home / Draw / Away
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
  const best = (slot) =>
    outcomes[slot].reduce((b, x) => (b == null || x.price > b.price ? x : b), null);
  const live = new Date(ev.commence_time).getTime() < Date.now();
  return { ev, outcomes, book, best, live, swapped: teamsMatch(ev.away_team, homeName) };
}

function matchLine(ev) {
  const comp = ev.competitions[0];
  const home = comp.competitors.find((t) => t.homeAway === "home");
  const away = comp.competitors.find((t) => t.homeAway === "away");
  const st = comp.status;
  const state = st.type.state; // pre | in | post
  let status;
  if (st.type.name === "STATUS_HALFTIME") status = c("yellow", "HT");
  else if (state === "in") status = c("green", `LIVE ${st.displayClock || st.type.shortDetail}`);
  else if (state === "post") status = c("gray", "FT");
  else status = c("dim", new Date(ev.date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
  const score = state === "pre" ? "vs" : `${home.score} - ${away.score}`;
  let line = `  ${c("dim", ev.id)}  ${home.team.displayName.padEnd(22)} ${c("bold", score.padStart(5))}  ${away.team.displayName.padEnd(22)} ${status}`;
  // for upcoming games, append the market's implied odds if posted
  if (state === "pre") {
    const probs = impliedProbs((comp.odds || [])[0]);
    if (probs) line += c("dim", `   ${home.team.abbreviation} ${probs[0]}% / Draw ${probs[1]}% / ${away.team.abbreviation} ${probs[2]}%`);
  }
  return line;
}

async function listMatches({ days = 3 } = {}) {
  // pull today plus the next few days, dedupe, and keep chronological order
  const boards = await Promise.all(
    Array.from({ length: days }, (_, i) => scoreboardOn(ymd(i)).catch(() => ({ events: [] })))
  );
  const seen = new Set();
  const events = [];
  for (const b of boards)
    for (const ev of b.events || [])
      if (!seen.has(ev.id)) { seen.add(ev.id); events.push(ev); }
  events.sort((a, b) => new Date(a.date) - new Date(b.date));
  if (!events.length) return console.log("No World Cup matches scheduled.");

  // odds aren't attached at scoreboard level, so fetch them per upcoming game (capped, in parallel)
  const upcoming = events.filter((e) => e.competitions[0].status.type.state === "pre").slice(0, 14);
  await Promise.all(
    upcoming.map((ev) =>
      summary(ev.id)
        .then((s) => { ev.competitions[0].odds = s.pickcenter || s.odds || []; })
        .catch(() => {})
    )
  );

  console.log(c("bold", "\n  FIFA World Cup 2026\n"));
  let curDay = "";
  for (const ev of events) {
    const day = new Date(ev.date).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    if (day !== curDay) { curDay = day; console.log(c("cyan", `  ── ${day} ──`)); }
    console.log(matchLine(ev));
  }
  console.log(c("dim", "\n  Track one:  node worldcup.mjs <team name or id>\n"));
  return events;
}

const allStandings = () => getJSON(`https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings`);

// render one group's table; `highlight` is a set of team names to emphasize
function renderGroupTable(name, entries, highlight = new Set()) {
  const stat = (e, n) => (e.stats || []).find((s) => s.name === n)?.displayValue ?? "";
  const teamName = (t) => (typeof t === "string" ? t : t?.displayName || t?.name || "?");
  const out = [c("bold", `  ${name}`), c("dim", "      Team                P   W-D-L   GD  Pts")];
  const sorted = [...entries].sort((a, b) => Number(stat(a, "rank")) - Number(stat(b, "rank")));
  for (const e of sorted) {
    const nm = teamName(e.team);
    const rank = Number(stat(e, "rank"));
    // top 2 qualify directly; show a marker
    const mark = rank <= 2 ? c("green", "▲") : " ";
    const row =
      `  ${String(rank).padStart(2)}${mark} ${nm.padEnd(18)} ` +
      `${stat(e, "gamesPlayed").padStart(2)}   ${stat(e, "overall").padEnd(7)} ` +
      `${stat(e, "pointDifferential").padStart(3)}  ${stat(e, "points").padStart(3)}`;
    out.push(highlight.has(nm) ? c("cyan", row) : row);
  }
  return out.join("\n");
}

async function showGroups() {
  const j = await allStandings();
  const groups = j.children || [];
  if (!groups.length) return console.log("No standings available yet.");
  console.log(c("bold", "\n  FIFA World Cup 2026 — Group Standings") + c("dim", "   (▲ = top 2, advance)\n"));
  for (const g of groups) {
    console.log(renderGroupTable(g.name, g.standings?.entries || []));
    console.log("");
  }
}

function findEvent(events, query) {
  const q = query.toLowerCase();
  return events.find((ev) =>
    ev.id === query ||
    ev.competitions[0].competitors.some(
      (t) =>
        t.team.displayName.toLowerCase().includes(q) ||
        (t.team.abbreviation || "").toLowerCase() === q
    )
  );
}

const statMap = (team) =>
  Object.fromEntries((team.statistics || []).map((s) => [s.name, s.displayValue]));

function bar(leftPct, width = 30) {
  const l = Math.round((leftPct / 100) * width);
  return c("cyan", "█".repeat(l)) + c("magenta", "█".repeat(width - l));
}

function eventIcon(type) {
  const t = (type || "").toLowerCase();
  if (t.includes("goal")) return c("green", "⚽ GOAL");
  if (t.includes("own")) return c("red", "⚽ OWN GOAL");
  if (t.includes("penalty")) return c("green", "⚽ PEN");
  if (t.includes("yellow")) return c("yellow", "🟨");
  if (t.includes("red")) return c("red", "🟥");
  if (t.includes("substitution")) return c("gray", "🔁");
  if (t.includes("kickoff")) return c("dim", "▶");
  if (t.includes("halftime") || t.includes("end")) return c("dim", "⏸");
  return c("dim", "•");
}

function renderMatch(ev, sum, liveOdds) {
  const comp = ev.competitions[0];
  const home = comp.competitors.find((t) => t.homeAway === "home");
  const away = comp.competitors.find((t) => t.homeAway === "away");
  const st = comp.status;
  const state = st.type.state;

  const lines = [];
  const clock =
    st.type.name === "STATUS_HALFTIME"
      ? c("yellow", "⏸ HALFTIME")
      : state === "in"
        ? c("green", `● LIVE  ${st.displayClock || st.type.shortDetail}`)
        : state === "post"
          ? c("gray", "FULL TIME")
          : c("dim", `Kickoff ${new Date(ev.date).toLocaleString()}`);

  lines.push("");
  lines.push(`  ${c("bold", home.team.displayName)}  ${c("bold", `${home.score ?? 0} - ${away.score ?? 0}`)}  ${c("bold", away.team.displayName)}    ${clock}`);
  lines.push(c("dim", `  ${comp.venue?.fullName || ""}   updated ${new Date().toLocaleTimeString()}`));
  lines.push("");

  // stats table
  const teams = sum.boxscore?.teams || [];
  const homeStats = statMap(teams.find((t) => t.team.id === home.team.id) || teams[0] || {});
  const awayStats = statMap(teams.find((t) => t.team.id === away.team.id) || teams[1] || {});

  if (Object.keys(homeStats).length) {
    // fixed grid: [value col][label col][value col] — pad BEFORE coloring so
    // ANSI escape codes never throw off the column widths
    const W_VAL = 10, W_LABEL = 20;
    const padC = (s, w) => {
      s = String(s);
      const left = Math.max(0, Math.floor((w - s.length) / 2));
      return (" ".repeat(left) + s).padEnd(w);
    };
    const hs = homeStats, as = awayStats;
    const pct = (v) => `${Math.round(parseFloat(v || 0) * 100)}%`;
    const poss = parseFloat(hs.possessionPct || "50");
    lines.push(
      `  ${c("cyan", padC(`${home.team.abbreviation} ${hs.possessionPct}%`, W_VAL))} ${bar(poss, W_LABEL + 2)} ` +
      c("magenta", padC(`${as.possessionPct}% ${away.team.abbreviation}`, W_VAL))
    );
    // related stats share a row to keep the page short: [label, homeVal, awayVal, homeNum, awayNum]
    const rows = [
      ["Shots (on goal)", `${hs.totalShots} (${hs.shotsOnTarget})`, `${as.totalShots} (${as.shotsOnTarget})`, hs.totalShots, as.totalShots],
      ["Corners", hs.wonCorners, as.wonCorners],
      ["Fouls / Offsides", `${hs.foulsCommitted} / ${hs.offsides}`, `${as.foulsCommitted} / ${as.offsides}`, hs.foulsCommitted, as.foulsCommitted],
      ["Yellow / Red", `${hs.yellowCards} / ${hs.redCards}`, `${as.yellowCards} / ${as.redCards}`, hs.yellowCards, as.yellowCards],
      ["Passes (accuracy)", `${hs.totalPasses} (${pct(hs.passPct)})`, `${as.totalPasses} (${pct(as.passPct)})`, hs.totalPasses, as.totalPasses],
      ["Tkl / Int / Clear", `${hs.totalTackles}/${hs.interceptions}/${hs.effectiveClearance}`, `${as.totalTackles}/${as.interceptions}/${as.effectiveClearance}`, hs.totalTackles, as.totalTackles],
    ];
    for (const [label, hv, av, hn, an] of rows) {
      if (hv == null || String(hv).includes("undefined")) continue;
      const hPad = padC(hv, W_VAL);
      const aPad = padC(av, W_VAL);
      const hl = Number(hn ?? hv) > Number(an ?? av) ? c("bold", hPad) : hPad;
      const al = Number(an ?? av) > Number(hn ?? hv) ? c("bold", aPad) : aPad;
      lines.push(`  ${hl} ${c("dim", padC(label, W_LABEL + 2))} ${al}`);
    }
    lines.push("");
  }

  // betting odds — prefer live multi-book odds (The Odds API) when a key is set,
  // otherwise fall back to ESPN's pre-match opening line.
  if (liveOdds) {
    // home/away in odds-API terms may be swapped vs ESPN; map our home/away to the right slot
    const slotHome = liveOdds.swapped ? "away" : "home";
    const slotAway = liveOdds.swapped ? "home" : "away";
    const fd = (slot) => liveOdds.book(slot, "fanduel");
    const best = (slot) => liveOdds.best(slot);
    // FanDuel line with vig-stripped implied probabilities
    const fdML = [fd(slotHome)?.price, fd("draw")?.price, fd(slotAway)?.price];
    const raw = fdML.map(ml2prob);
    const sumP = raw.reduce((a, b) => a + (b || 0), 0) || 1;
    const probs = raw.map((p) => (p == null ? null : Math.round((p / sumP) * 100)));
    const prob = (p) => (p == null ? "" : c("dim", ` ${p}%`));
    const tag = liveOdds.live ? c("green", "● LIVE") : c("dim", "pre-match");
    lines.push(c("bold", "  FanDuel odds") + `  ${tag}` + c("dim", `  (req left: ${_oddsCache.remaining ?? "?"})`));
    lines.push(
      `  ${c("bold", home.team.abbreviation)} ${fmtAmerican(fdML[0])}${prob(probs[0])}` +
      `   Draw ${fmtAmerican(fdML[1])}${prob(probs[1])}` +
      `   ${c("bold", away.team.abbreviation)} ${fmtAmerican(fdML[2])}${prob(probs[2])}`
    );
    // line shopping: best available price across all books for each outcome
    const bestLine = (label, slot) => {
      const b = best(slot);
      if (!b) return null;
      const isFd = b.book === "fanduel";
      return `${label} ${c("green", fmtAmerican(b.price))} ${c("dim", `@${b.book}${isFd ? "" : " ▲"}`)}`;
    };
    const shop = [
      bestLine(home.team.abbreviation, slotHome),
      bestLine("Draw", "draw"),
      bestLine(away.team.abbreviation, slotAway),
    ].filter(Boolean);
    if (shop.length) lines.push(c("dim", "  best price: ") + shop.join(c("dim", "  ")));
    lines.push("");
  } else {
    // ESPN fallback — pre-match opening line only (no live odds without a key)
    const odds = (sum.pickcenter || sum.odds || [])[0];
    if (odds && odds.homeTeamOdds?.moneyLine != null) {
      const hML = odds.homeTeamOdds.moneyLine;
      const aML = odds.awayTeamOdds?.moneyLine;
      const dML = odds.drawOdds?.moneyLine;
      const raw = [ml2prob(hML), ml2prob(dML), ml2prob(aML)];
      const sumP = raw.reduce((a, b) => a + (b || 0), 0) || 1;
      const [hP, dP, aP] = raw.map((p) => (p == null ? null : Math.round((p / sumP) * 100)));
      const prob = (p) => (p == null ? "" : c("dim", ` ${p}%`));
      lines.push(c("bold", "  Pre-match odds") + c("dim", `  (${odds.provider?.name || "book"} — opening line, not live)`));
      lines.push(
        `  ${c("bold", home.team.abbreviation)} ${fmtAmerican(hML)}${prob(hP)}` +
        `   Draw ${fmtAmerican(dML)}${prob(dP)}` +
        `   ${c("bold", away.team.abbreviation)} ${fmtAmerican(aML)}${prob(aP)}`
      );
      if (odds.details || odds.overUnder != null)
        lines.push(c("dim", `  Spread ${odds.details || "-"}   O/U ${odds.overUnder ?? "-"}`));
      lines.push("");
    }
  }

  // recommended bets — a compact live read shown every refresh during play. The fuller
  // breakdown (run of play + reasoning) appears at halftime via the halftime read.
  if (state === "in" && st.type.name !== "STATUS_HALFTIME") {
    const recLines = recommendedBetsLive(ev, sum, liveOdds);
    if (recLines.length) lines.push(...recLines, "");
  }

  // group standings — table for this match's group, with both teams highlighted
  const group = sum.standings?.groups?.[0];
  if (group?.standings?.entries?.length) {
    const here = new Set([home.team.displayName, away.team.displayName]);
    lines.push(renderGroupTable(group.header || "Group", group.standings.entries, here));
    lines.push("");
  }

  // goalkeepers — name, saves, goals against, shots faced (covers subbed-in keepers too)
  const keepers = [];
  for (const r of sum.rosters || []) {
    const abbr =
      r.team?.id === home.team.id ? home.team.abbreviation :
      r.team?.id === away.team.id ? away.team.abbreviation : r.team?.abbreviation || "";
    for (const p of r.roster || []) {
      if (p.position?.abbreviation !== "G") continue;
      const ps = Object.fromEntries((p.stats || []).map((s) => [s.name, s.value]));
      if (!ps.appearances) continue; // unused bench keeper
      keepers.push({ abbr, name: p.athlete?.displayName || "?", ...ps });
    }
  }
  if (keepers.length) {
    const minute = matchMinute(st);
    lines.push(c("bold", "  Goalkeepers") + c("dim", "   saves: live · proj to FT · O/U 2.5 (model estimate, not a book line)"));
    for (const k of keepers) {
      const saves = k.saves ?? 0;
      const ga = k.goalsConceded ?? 0;
      const base =
        `  ${c("bold", (k.abbr || "").padEnd(4))}${k.name.padEnd(22)} ` +
        `${c("green", `${saves} save${saves === 1 ? "" : "s"}`.padEnd(8))} ` +
        c("dim", `${ga} GA, ${k.shotsFaced ?? 0} faced`);
      // model-derived saves line — projection to full time + over/under 2.5 with fair odds
      const ln = keeperSaveLine(saves, minute, state);
      let proj = "";
      if (ln && !ln.settled) {
        const odds = probToAmerican(ln.pOver);
        const pct = Math.round(ln.pOver * 100);
        const ou = ln.need <= 0
          ? c("green", `O${ln.line} ✓ hit`)
          : `O${ln.line} ${pct}%${odds != null ? c("dim", ` (${fmtAmerican(odds)})`) : ""}`;
        proj = c("dim", "  ·  proj ") + ln.proj.toFixed(1) + "  " + ou;
      } else if (ln && ln.settled) {
        proj = c("dim", `  ·  final ${saves}  `) + (ln.over ? c("green", `O${ln.line} ✓`) : c("dim", `O${ln.line} ✗`));
      }
      lines.push(base + proj);
    }
    lines.push("");
  }

  // key events (goals, cards, subs) — newest last
  const keyEvents = (sum.keyEvents || []).filter((e) => {
    const t = (e.type?.text || "").toLowerCase();
    if (t.includes("delay")) return false;
    return t.includes("goal") || t.includes("card") || t.includes("substitution") ||
           t.includes("penalty") || t.includes("kickoff") || t.includes("halftime") ||
           t.includes("end");
  });
  if (keyEvents.length) {
    lines.push(c("bold", "  Match events"));
    for (const e of keyEvents.slice(-8)) {
      const minute = e.clock?.displayValue || "";
      const teamAbbr =
        e.team?.id === home.team.id ? home.team.abbreviation :
        e.team?.id === away.team.id ? away.team.abbreviation : "";
      const players = (e.participants || [])
        .map((p) => p.athlete?.displayName)
        .filter(Boolean)
        .join(", ");
      lines.push(`  ${c("dim", minute.padStart(7))}  ${eventIcon(e.type?.text)} ${teamAbbr ? c("bold", teamAbbr) + " " : ""}${players || e.type?.text || ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// Betting model: compare the run of play (xG-proxy, shots, possession, corners) against
// the score and the live market price, and surface betting *considerations*. Each rec has
// a compact `bet` (for the live section) and a full `text` (for the halftime read). These
// are heuristics, not a system that beats the books — framed honestly throughout.
function bettingModel(ev, sum, liveOdds) {
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

  // crude xG proxy: shots on target are worth far more than off-target attempts
  const xg = (s) => n(s.shotsOnTarget) * 0.33 + Math.max(0, n(s.totalShots) - n(s.shotsOnTarget)) * 0.04;
  const hX = xg(hs), aX = xg(as), combinedX = hX + aX;

  // dominance index: weighted share of the underlying numbers
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

  // market implied probs from FanDuel (vig-stripped), if we have live odds
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

  // build considerations
  const recs = [];
  const leadByScore = hScore === aScore ? null : hScore > aScore ? "home" : "away";
  const domSide = domLeader.side, domAbbr = domLeader.abbr, domPct = domLeader.dom;
  const totalShots = n(hs.totalShots) + n(as.totalShots);
  const priceFor = (side) => (mkt ? `${fmtAmerican(mkt[side].price)} (${mkt[side].prob}%)` : "no live price");

  // 1) dominant side not yet ahead → they're the better team, second half favors them
  if (domPct >= 60 && leadByScore !== domSide) {
    const strong = domPct >= 67;
    recs.push({
      conf: strong ? "Strong lean" : "Lean",
      bet: `${c("bold", domAbbr)} to win @ ${c("green", priceFor(domSide))}`,
      text:
        `${c("bold", domAbbr)} to win the match @ ${c("green", priceFor(domSide))} — ` +
        `controlling the game (${domPct}%, xG edge) but ${leadByScore ? "trailing" : "level"}; ` +
        `the run of play says they're the better side and haven't been rewarded yet.`,
    });
  }

  // 2) dominant side already leading → market likely short, flag as chalk
  if (domPct >= 58 && leadByScore === domSide) {
    recs.push({
      conf: "Low value",
      bet: `${c("bold", domAbbr)} win — fair but priced in (${priceFor(domSide)})`,
      text:
        `${c("bold", domAbbr)} are both ahead and on top — the price (${priceFor(domSide)}) already reflects it. ` +
        `Fair, but little edge left.`,
    });
  }

  // 3) goals direction (no live totals price on the free tier — directional only)
  if (combinedX >= 1.3 && hScore + aScore <= 2) {
    recs.push({
      conf: "Lean",
      bet: `Over goals / BTTS — ${combinedX.toFixed(2)} xG, only ${hScore + aScore} scored`,
      text:
        `Over goals / both-teams-to-score — ${combinedX.toFixed(2)} combined xG with chances flowing ` +
        `(${totalShots} shots) but only ${hScore + aScore} scored so far. ` +
        c("dim", "(no live totals price on the free tier — directional)"),
    });
  } else if (combinedX < 0.6 && totalShots <= 6) {
    recs.push({
      conf: "Lean",
      bet: `Under goals / draw-no-bet — sterile (${combinedX.toFixed(2)} xG)`,
      text:
        `Under goals / draw-no-bet — sterile half (${combinedX.toFixed(2)} combined xG, few clear chances). ` +
        c("dim", "(directional)"),
    });
  }

  // 4) tight & even → no edge
  if (!recs.length) {
    recs.push({
      conf: "No edge",
      bet: "No clear edge — sit this one out",
      text: "Even contest with no clear trend-vs-price gap — nothing stands out. Sit this one out.",
    });
  }

  return { recs, domLeader, hX, aX, combinedX, HA, AA, hScore, aScore };
}

// compact live recommended-bets read, shown on every refresh during play. The fuller
// breakdown (run of play + reasoning) appears at halftime via halftimeRead.
function recommendedBetsLive(ev, sum, liveOdds) {
  const m = bettingModel(ev, sum, liveOdds);
  if (!m) return [];
  const out = [
    c("bold", "  Recommended bets") +
    c("dim", `  (model lean: ${m.domLeader.abbr} ${m.domLeader.dom}% control — heuristic, stake small)`),
  ];
  // prefer actionable leans; fall back to whatever the model produced
  const actionable = m.recs.filter((r) => r.conf === "Strong lean" || r.conf === "Lean");
  const picks = (actionable.length ? actionable : m.recs).slice(0, 2);
  for (const r of picks) out.push(`  ${confTag(r.conf)} ${r.bet}`);
  return out;
}

// Halftime read: the expanded version — run of play, full reasoning, and disclaimer.
function halftimeRead(ev, sum, liveOdds) {
  const m = bettingModel(ev, sum, liveOdds);
  if (!m) return [];
  const out = [];
  out.push(c("bold", c("yellow", "  ── HALFTIME READ ──")));
  out.push(
    `  Run of play: ${c("bold", m.domLeader.abbr)} on top (${m.domLeader.dom}% control)` +
    c("dim", `   xG ${m.HA} ${m.hX.toFixed(2)} – ${m.aX.toFixed(2)} ${m.AA}   score ${m.hScore}-${m.aScore}`)
  );
  for (const r of m.recs) out.push(`  ${confTag(r.conf)} ${r.text}`);
  out.push(c("dim", "  ⚠ Heuristic read, not financial advice. Odds are -EV on average; stake small."));
  return out;
}

async function track(query, { once, interval }) {
  const sb = await scoreboard();
  const events = sb.events || [];
  let ev;
  if (query) {
    ev = findEvent(events, query);
    if (!ev) {
      console.log(`No match found for "${query}". Today's matches:`);
      for (const e of events) console.log(matchLine(e));
      process.exit(1);
    }
  } else {
    const live = events.filter((e) => e.competitions[0].status.type.state === "in");
    if (live.length === 1) ev = live[0];
    else { await listMatches(); return; }
  }

  const scoreOf = (e) =>
    e.competitions[0].competitors.map((t) => Number(t.score) || 0);
  let prevScore = null;

  for (;;) {
    let sum;
    try {
      const [freshSb, freshSum] = await Promise.all([scoreboard(), summary(ev.id)]);
      ev = (freshSb.events || []).find((e) => e.id === ev.id) || ev;
      sum = freshSum;
    } catch (err) {
      console.error(c("red", `  fetch failed: ${err.message} — retrying in ${interval}s`));
      if (once) process.exit(1);
      await new Promise((r) => setTimeout(r, interval * 1000));
      continue;
    }
    // detect a goal: total score went up since the last refresh
    const score = scoreOf(ev);
    const isGoal = prevScore && score[0] + score[1] > prevScore[0] + prevScore[1];
    prevScore = score;

    // live multi-book odds (cached ~2 min); silently skip if no key or fetch fails
    let liveOdds = null;
    if (ODDS_KEY) {
      try {
        const comp = ev.competitions[0];
        const h = comp.competitors.find((t) => t.homeAway === "home");
        const a = comp.competitors.find((t) => t.homeAway === "away");
        liveOdds = matchOdds(await fetchOddsEvents(), h.team.displayName, a.team.displayName);
      } catch { /* fall back to ESPN pre-match odds */ }
    }

    if (!once) process.stdout.write("\x1b[2J\x1b[3J\x1b[H"); // clear screen AND scrollback (3J) so stale frames don't linger above
    if (isGoal) {
      const comp = ev.competitions[0];
      const h = comp.competitors.find((t) => t.homeAway === "home");
      const a = comp.competitors.find((t) => t.homeAway === "away");
      process.stdout.write("\x07"); // terminal bell
      console.log(c("green", c("bold", `\n  ⚽⚽⚽  GOAL!  ${h.team.abbreviation} ${h.score} - ${a.score} ${a.team.abbreviation}  ⚽⚽⚽\n`)));
    }
    console.log(renderMatch(ev, sum, liveOdds));
    const status = ev.competitions[0].status;
    if (once) break;
    if (status.type.state === "post") { console.log(c("dim", "  Match finished.\n")); break; }
    // during halftime, back off to a slow poll until the second half starts
    const halftime = status.type.name === "STATUS_HALFTIME";
    if (halftime) {
      const read = halftimeRead(ev, sum, liveOdds);
      if (read.length) console.log("\n" + read.join("\n") + "\n");
    }
    const wait = halftime ? Math.max(interval, 120) : interval;
    console.log(c("dim", halftime
      ? `  halftime — refresh paused, checking again in ${wait}s — Ctrl+C to stop`
      : `  refreshing every ${interval}s — Ctrl+C to stop`));
    await new Promise((r) => setTimeout(r, wait * 1000));
  }
}

// --- arg parsing ---
const args = process.argv.slice(2);
const once = args.includes("--once");
let interval = 30;
const iIdx = args.findIndex((a) => a === "-i" || a === "--interval");
if (iIdx !== -1) interval = Math.max(10, Number(args[iIdx + 1]) || 30);
const positional = args.filter((a, idx) => !a.startsWith("-") && (iIdx === -1 || idx !== iIdx + 1));
const cmd = positional[0];

if (cmd === "list") await listMatches();
else if (cmd === "groups" || cmd === "table" || cmd === "standings") await showGroups();
else await track(cmd, { once, interval });
