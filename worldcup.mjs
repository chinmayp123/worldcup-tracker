#!/usr/bin/env node
// worldcup — live FIFA World Cup 2026 match tracker (ESPN public API, no key needed)
//
//   node worldcup.mjs                 auto-track the live game (or list if several)
//   node worldcup.mjs list            show today's matches
//   node worldcup.mjs canada          track a match by team name (or event id)
//   node worldcup.mjs usa --once      single snapshot, no refresh loop
//   node worldcup.mjs usa -i 15       refresh every 15s (default 30)

const BASE = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world";

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
const summary = (id) => getJSON(`${BASE}/summary?event=${id}`);

function matchLine(ev) {
  const comp = ev.competitions[0];
  const home = comp.competitors.find((t) => t.homeAway === "home");
  const away = comp.competitors.find((t) => t.homeAway === "away");
  const st = comp.status;
  const state = st.type.state; // pre | in | post
  let status;
  if (state === "in") status = c("green", `LIVE ${st.displayClock || st.type.shortDetail}`);
  else if (state === "post") status = c("gray", "FT");
  else status = c("dim", new Date(ev.date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
  const score = state === "pre" ? "vs" : `${home.score} - ${away.score}`;
  return `  ${c("dim", ev.id)}  ${home.team.displayName.padEnd(22)} ${c("bold", score.padStart(5))}  ${away.team.displayName.padEnd(22)} ${status}`;
}

async function listMatches() {
  const sb = await scoreboard();
  const events = sb.events || [];
  if (!events.length) return console.log("No World Cup matches today.");
  console.log(c("bold", `\n  FIFA World Cup 2026 — ${sb.day?.date || "today"}\n`));
  for (const ev of events) console.log(matchLine(ev));
  console.log(c("dim", "\n  Track one:  node worldcup.mjs <team name or id>\n"));
  return events;
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

// stats worth showing, in display order: [key, label, isPct]
const STAT_ROWS = [
  ["possessionPct", "Possession %", true],
  ["totalShots", "Shots"],
  ["shotsOnTarget", "On Target"],
  ["wonCorners", "Corners"],
  ["foulsCommitted", "Fouls"],
  ["offsides", "Offsides"],
  ["yellowCards", "Yellow Cards"],
  ["redCards", "Red Cards"],
  ["saves", "Saves"],
  ["totalPasses", "Passes"],
  ["passPct", "Pass Accuracy", true],
  ["totalTackles", "Tackles"],
  ["interceptions", "Interceptions"],
  ["effectiveClearance", "Clearances"],
];

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

function renderMatch(ev, sum) {
  const comp = ev.competitions[0];
  const home = comp.competitors.find((t) => t.homeAway === "home");
  const away = comp.competitors.find((t) => t.homeAway === "away");
  const st = comp.status;
  const state = st.type.state;

  const lines = [];
  const clock =
    state === "in"
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
    const W_VAL = 6, W_LABEL = 24;
    const padC = (s, w) => {
      s = String(s);
      const left = Math.max(0, Math.floor((w - s.length) / 2));
      return (" ".repeat(left) + s).padEnd(w);
    };
    const fmt = (key, v) => {
      if (v === "-" || v == null) return "-";
      if (key === "passPct") return `${Math.round(parseFloat(v) * 100)}%`;
      return String(v);
    };
    const poss = parseFloat(homeStats.possessionPct || "50");
    lines.push(`  ${c("cyan", padC(home.team.abbreviation || "HOME", W_VAL))}  ${bar(poss, W_LABEL)}  ${c("magenta", padC(away.team.abbreviation || "AWAY", W_VAL))}`);
    lines.push("");
    for (const [key, label] of STAT_ROWS) {
      const hv = homeStats[key] ?? "-";
      const av = awayStats[key] ?? "-";
      if (hv === "-" && av === "-") continue;
      const hPad = padC(fmt(key, hv), W_VAL);
      const aPad = padC(fmt(key, av), W_VAL);
      const hl = Number(hv) > Number(av) ? c("bold", hPad) : hPad;
      const al = Number(av) > Number(hv) ? c("bold", aPad) : aPad;
      lines.push(`  ${hl}  ${c("dim", padC(label, W_LABEL))}  ${al}`);
    }
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
    lines.push(c("bold", "  Goalkeepers"));
    for (const k of keepers) {
      const saves = k.saves ?? 0;
      const ga = k.goalsConceded ?? 0;
      lines.push(
        `  ${c("bold", (k.abbr || "").padEnd(4))}${k.name.padEnd(24)} ` +
        `${c("green", `${saves} save${saves === 1 ? "" : "s"}`)}  ` +
        c("dim", `${ga} conceded, ${k.shotsFaced ?? 0} shots faced`)
      );
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
    for (const e of keyEvents.slice(-12)) {
      const minute = e.clock?.displayValue || "";
      const teamAbbr =
        e.team?.id === home.team.id ? home.team.abbreviation :
        e.team?.id === away.team.id ? away.team.abbreviation : "";
      const players = (e.participants || [])
        .map((p) => p.athlete?.displayName)
        .filter(Boolean)
        .join(", ");
      lines.push(`  ${c("dim", minute.padStart(4))}  ${eventIcon(e.type?.text)} ${teamAbbr ? c("bold", teamAbbr) + " " : ""}${players || e.type?.text || ""}`);
    }
    lines.push("");
  }
  return lines.join("\n");
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
    if (!once) process.stdout.write("\x1b[2J\x1b[H"); // clear screen
    console.log(renderMatch(ev, sum));
    const state = ev.competitions[0].status.type.state;
    if (once) break;
    if (state === "post") { console.log(c("dim", "  Match finished.\n")); break; }
    console.log(c("dim", `  refreshing every ${interval}s — Ctrl+C to stop`));
    await new Promise((r) => setTimeout(r, interval * 1000));
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
else await track(cmd, { once, interval });
