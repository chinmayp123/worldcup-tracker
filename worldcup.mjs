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
  if (st.type.name === "STATUS_HALFTIME") status = c("yellow", "HT");
  else if (state === "in") status = c("green", `LIVE ${st.displayClock || st.type.shortDetail}`);
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

  // betting odds — ESPN's free API only carries the PRE-MATCH line (no live in-play
  // odds), so label it honestly and add implied win probabilities from the moneylines
  const odds = (sum.pickcenter || sum.odds || [])[0];
  if (odds && odds.homeTeamOdds?.moneyLine != null) {
    const ml2prob = (ml) =>
      ml == null ? null : ml > 0 ? 100 / (ml + 100) : -ml / (-ml + 100);
    const fmtML = (ml) => (ml == null ? "-" : ml > 0 ? `+${ml}` : `${ml}`);
    const hML = odds.homeTeamOdds.moneyLine;
    const aML = odds.awayTeamOdds?.moneyLine;
    const dML = odds.drawOdds?.moneyLine;
    // normalize implied probs so the three outcomes sum to 100% (strips the vig)
    const raw = [ml2prob(hML), ml2prob(dML), ml2prob(aML)];
    const sumP = raw.reduce((a, b) => a + (b || 0), 0) || 1;
    const [hP, dP, aP] = raw.map((p) => (p == null ? null : Math.round((p / sumP) * 100)));
    const prob = (p) => (p == null ? "" : c("dim", ` ${p}%`));
    lines.push(c("bold", "  Pre-match odds") + c("dim", `  (${odds.provider?.name || "book"} — opening line, not live)`));
    lines.push(
      `  ${c("bold", home.team.abbreviation)} ${fmtML(hML)}${prob(hP)}` +
      `   Draw ${fmtML(dML)}${prob(dP)}` +
      `   ${c("bold", away.team.abbreviation)} ${fmtML(aML)}${prob(aP)}`
    );
    if (odds.details || odds.overUnder != null)
      lines.push(c("dim", `  Spread ${odds.details || "-"}   O/U ${odds.overUnder ?? "-"}`));
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
        `${c("green", `${saves} save${saves === 1 ? "" : "s"}`.padEnd(8))}  ` +
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
    if (!once) process.stdout.write("\x1b[2J\x1b[3J\x1b[H"); // clear screen AND scrollback (3J) so stale frames don't linger above
    console.log(renderMatch(ev, sum));
    const status = ev.competitions[0].status;
    if (once) break;
    if (status.type.state === "post") { console.log(c("dim", "  Match finished.\n")); break; }
    // during halftime, back off to a slow poll until the second half starts
    const halftime = status.type.name === "STATUS_HALFTIME";
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
else await track(cmd, { once, interval });
