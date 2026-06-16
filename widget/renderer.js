// renderer — draws the widget from the plain JSON the main process sends. No data fetching
// here; main owns that. Built with createElement + textContent (CSP blocks inline, and we
// avoid innerHTML with API strings).
const app = document.getElementById("app");
const body = document.getElementById("body");
const titleEl = document.getElementById("title");

let expanded = false;
let pinned = true;
let viewMode = "match"; // "match" | "pick"
let last = null;        // last data payload

// tiny DOM helper
function h(tag, opts = {}, kids = []) {
  const el = document.createElement(tag);
  if (opts.class) el.className = opts.class;
  if (opts.text != null) el.textContent = opts.text;
  if (opts.title) el.title = opts.title;
  if (opts.onclick) el.addEventListener("click", opts.onclick);
  for (const k of [].concat(kids)) if (k) el.appendChild(k);
  return el;
}
const frag = (kids) => { const f = document.createDocumentFragment(); for (const k of kids) if (k) f.appendChild(k); return f; };

// The Odds API book keys → readable names (fallback: capitalize the key)
const BOOKS = {
  fanduel: "FanDuel", draftkings: "DraftKings", betmgm: "BetMGM", williamhill_us: "Caesars",
  caesars: "Caesars", betrivers: "BetRivers", betonlineag: "BetOnline", bovada: "Bovada",
  mybookieag: "MyBookie", betus: "BetUS", lowvig: "LowVig", pointsbetus: "PointsBet",
  superbook: "SuperBook", espnbet: "ESPN BET", fanatics: "Fanatics", hardrockbet: "Hard Rock",
  unibet_us: "Unibet", betparx: "betPARX", wynnbet: "WynnBET", twinspires: "TwinSpires",
};
const bookName = (k) => BOOKS[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : "");

// --- controls ---
document.getElementById("btn-expand").addEventListener("click", async () => {
  expanded = await window.wc.toggleExpand();
  applyMode(); render();
});
document.getElementById("btn-pin").addEventListener("click", async () => {
  pinned = await window.wc.togglePin();
  document.getElementById("btn-pin").classList.toggle("on", pinned);
});
document.getElementById("btn-pick").addEventListener("click", () => {
  viewMode = viewMode === "pick" ? "match" : "pick";
  render();
});
document.getElementById("btn-hide").addEventListener("click", () => window.wc.hide());
document.getElementById("btn-quit").addEventListener("click", () => window.wc.quit());

function applyMode() {
  app.classList.toggle("expanded", expanded);
  app.classList.toggle("compact", !expanded);
}

window.wc.onConfig((cfg) => {
  expanded = !!cfg.expanded;
  pinned = !!cfg.pinned;
  document.getElementById("btn-pin").classList.toggle("on", pinned);
  applyMode();
});

window.wc.onUpdate((data) => {
  last = data;
  render();
});

// --- rendering ---
function render() {
  if (!last) return;
  body.replaceChildren();

  if (viewMode === "pick") { body.appendChild(renderPicker(last.matches || [])); return; }

  if (last.error) {
    titleEl.textContent = "WorldCup ⚽";
    body.appendChild(h("div", { class: "center muted", text: `Couldn’t load: ${last.error}` }));
    return;
  }
  if (!last.match) {
    titleEl.textContent = "WorldCup ⚽";
    body.appendChild(h("div", { class: "center muted", text: "No live match right now." }));
    const hint = h("div", { class: "center muted", text: "Tap ≡ to pick a game." });
    hint.style.fontSize = "11px"; hint.style.paddingTop = "0";
    body.appendChild(hint);
    return;
  }
  renderMatch(last.match);
}

function liveClass(m) { return m.state === "pre" ? "pre" : m.state === "post" ? "ft" : ""; }

function renderMatch(m) {
  titleEl.textContent = `${m.home.abbr} v ${m.away.abbr}`;
  const blocks = [];

  // status + score
  blocks.push(h("div", { class: `live ${liveClass(m)}`, text: (m.state === "in" ? "● " : "") + m.statusText }));
  blocks.push(h("div", { class: "score-row" }, [
    h("span", { class: "team", text: expanded ? m.home.name : m.home.abbr }),
    h("span", { class: "score", text: m.state === "pre" ? "vs" : `${m.home.score} – ${m.away.score}` }),
    h("span", { class: "team", text: expanded ? m.away.name : m.away.abbr }),
  ]));
  if (expanded && m.venue) blocks.push(h("div", { class: "venue", text: m.venue }));

  // prediction
  if (m.prediction) {
    const p = m.prediction;
    blocks.push(h("div", { class: "label", text: `Predicted final${expanded ? " · " + p.basis : ""}${p.early ? " · low conf" : ""}` }));
    const pred = h("div", { class: "pred" }, [
      h("span", { class: "h", text: m.home.abbr }),
      document.createTextNode(` ${p.ph} – ${p.pa} `),
      h("span", { class: "a", text: m.away.abbr }),
    ]);
    if (expanded) pred.appendChild(h("span", { class: "exp", text: `exp ${p.expH.toFixed(1)}–${p.expA.toFixed(1)}` }));
    blocks.push(pred);
    const wH = Math.round(p.wH * 100), wD = Math.round(p.wD * 100), wA = Math.round(p.wA * 100);
    const wb = h("div", { class: "winbar" }, [
      Object.assign(h("span", { class: "h" }), { style: `flex:${Math.max(p.wH, 0.001)}` }),
      Object.assign(h("span", { class: "d" }), { style: `flex:${Math.max(p.wD, 0.001)}` }),
      Object.assign(h("span", { class: "a" }), { style: `flex:${Math.max(p.wA, 0.001)}` }),
    ]);
    blocks.push(wb);
    blocks.push(h("div", { class: "winlegend" }, [
      h("span", { text: `${m.home.abbr} ${wH}%` }),
      h("span", { text: `Draw ${wD}%` }),
      h("span", { text: `${m.away.abbr} ${wA}%` }),
    ]));
  }

  // recommended bets
  if (m.recs && m.recs.length) {
    const note = m.dominance ? ` · ${m.dominance.leader} ${m.dominance.pct}%` : m.recsBasis ? ` · ${m.recsBasis}` : "";
    blocks.push(h("div", { class: "label", text: "Recommended bets" + note }));
    const picks = expanded ? m.recs : pickTop(m.recs, 2);
    for (const r of picks) {
      const tagClass = r.conf.split(" ")[0]; // Strong | Lean | Low | No
      blocks.push(h("div", { class: "rec" }, [
        h("span", { class: `tag ${tagClass}`, text: r.conf }),
        h("span", { class: "txt", text: expanded ? r.text : r.bet }),
      ]));
    }
  }

  // ---- full-only sections ----
  if (expanded) {
    if (m.possession) {
      blocks.push(h("div", { class: "label", text: "Possession" }));
      blocks.push(h("div", { class: "possrow" }, [
        h("span", { text: `${m.possession.homeAbbr} ${m.possession.home}%` }),
        h("span", { text: `${m.possession.away}% ${m.possession.awayAbbr}` }),
      ]));
      blocks.push(h("div", { class: "possbar" }, [
        Object.assign(h("span", { class: "h" }), { style: `flex:${m.possession.home}` }),
        Object.assign(h("span", { class: "a" }), { style: `flex:${m.possession.away}` }),
      ]));
    }
    if (m.stats && m.stats.length) {
      const tbl = h("table");
      for (const s of m.stats) {
        tbl.appendChild(h("tr", {}, [
          h("td", { class: "hv" + (s.homeLeads ? " lead" : ""), text: s.home }),
          h("td", { class: "lbl", text: s.label }),
          h("td", { class: "av" + (s.awayLeads ? " lead" : ""), text: s.away }),
        ]));
      }
      blocks.push(tbl);
    }
    if (m.odds) {
      const src = m.odds.source === "live" ? "FanDuel · LIVE" : m.odds.source === "pre" ? "FanDuel · pre" : `${m.odds.provider || "book"} · pre`;
      blocks.push(h("div", { class: "label", text: `Odds · ${src}` }));
      const o = m.odds, money = h("div", { class: "odds" });
      money.appendChild(h("div", { class: "row" }, [
        h("span", { text: `${m.home.abbr} ${o.home.ml}${o.home.prob != null ? ` ${o.home.prob}%` : ""}` }),
        h("span", { text: `Draw ${o.draw.ml}${o.draw.prob != null ? ` ${o.draw.prob}%` : ""}` }),
        h("span", { text: `${m.away.abbr} ${o.away.ml}${o.away.prob != null ? ` ${o.away.prob}%` : ""}` }),
      ]));
      if (o.home.best) {
        // best available price across books, with the book name and a ▲ when it beats FanDuel
        const cell = (s, ab) => h("span", {
          text: `${ab} ${s.best} ${bookName(s.bestBook)}${s.beatsFd ? " ▲" : ""}`,
          class: s.beatsFd ? "up" : "",
        });
        money.appendChild(h("div", { class: "label best-lbl", text: "best price across books" }));
        money.appendChild(h("div", { class: "row best" }, [cell(o.home, m.home.abbr), cell(o.draw, "Draw"), cell(o.away, m.away.abbr)]));
      }
      blocks.push(money);
    }
    if (m.keepers && m.keepers.length) {
      blocks.push(h("div", { class: "label", text: "Goalkeepers · saves (model est.)" }));
      for (const k of m.keepers) {
        let est = "";
        if (k.line && !k.line.settled) {
          est = k.line.need <= 0 ? `proj ${k.line.proj.toFixed(1)} · O${k.line.value} ✓`
            : `proj ${k.line.proj.toFixed(1)} · O${k.line.value} ${Math.round(k.line.pOver * 100)}%${k.line.odds != null ? ` (${k.line.odds > 0 ? "+" : ""}${k.line.odds})` : ""}`;
        } else if (k.line && k.line.settled) {
          est = `final ${k.saves} · O${k.line.value} ${k.line.over ? "✓" : "✗"}`;
        }
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `${k.abbr} ${k.name}` }),
          h("span", { class: "est", text: `${k.saves} sv · ${est}` }),
        ]));
      }
    }
    if (m.playerProps && (m.playerProps.scorers.length || m.playerProps.sot.length)) {
      const pp = m.playerProps;
      // FanDuel price first; flag another book with ▲ only when it actually beats FanDuel
      const priceEl = (pv) => {
        if (pv.primary) {
          const span = h("span", { class: "est", text: `FD ${pv.primary}` });
          if (pv.beats && pv.best) span.appendChild(h("span", { class: "up", text: `  ▲ ${pv.best} ${bookName(pv.bestBook)}` }));
          return span;
        }
        return h("span", { class: "est", text: pv.best ? `${pv.best} ${bookName(pv.bestBook)} (no FD)` : "" });
      };
      if (pp.scorers.length) {
        blocks.push(h("div", { class: "label", text: "Anytime scorer · FanDuel" }));
        for (const s of pp.scorers.slice(0, 5)) {
          const pctTxt = s.prob != null ? `${Math.round(s.prob * 100)}% devig` : `${Math.round((s.price.implied || 0) * 100)}%`;
          blocks.push(h("div", { class: "gk" }, [
            h("span", { text: `${s.player} · ${pctTxt}` }),
            priceEl(s.price),
          ]));
        }
      }
      if (pp.sot.length) {
        blocks.push(h("div", { class: "label", text: "Shots on target · FanDuel · de-vigged" }));
        for (const s of pp.sot.slice(0, 5)) {
          blocks.push(h("div", { class: "gk" }, [
            h("span", { text: `${s.player} O${s.line} · ${Math.round(s.fairOver * 100)}%` }),
            priceEl(s.price),
          ]));
        }
      }
    }

    if (m.group) {
      blocks.push(h("div", { class: "label", text: m.group.header }));
      const tbl = h("table", { class: "grp" });
      for (const e of m.group.entries) {
        tbl.appendChild(h("tr", { class: e.highlight ? "hl" : "" }, [
          h("td", { text: `${e.rank}. ${e.name}` }),
          h("td", { class: "num", text: e.record }),
          h("td", { class: "num", text: `${e.gd}` }),
          h("td", { class: "num", text: `${e.pts} pts` }),
        ]));
      }
      blocks.push(tbl);
    }
    if (m.events && m.events.length) {
      blocks.push(h("div", { class: "label", text: "Match events" }));
      for (const e of m.events) {
        blocks.push(h("div", { class: "ev" }, [
          h("span", { class: "min", text: e.min }),
          h("span", { text: `${eventIcon(e.type)} ${e.teamAbbr ? e.teamAbbr + " " : ""}${e.players || e.type}` }),
        ]));
      }
    }
    blocks.push(h("div", { class: "disc", text: "⚠ Model estimates, not financial advice. Odds are −EV on average; stake small." }));
  }

  body.appendChild(frag(blocks));
}

function pickTop(recs, n) {
  const actionable = recs.filter((r) => r.conf === "Strong lean" || r.conf === "Lean");
  return (actionable.length ? actionable : recs).slice(0, n);
}

function eventIcon(type) {
  const t = (type || "").toLowerCase();
  if (t.includes("own")) return "⚽";
  if (t.includes("goal") || t.includes("penalty")) return "⚽";
  if (t.includes("yellow")) return "🟨";
  if (t.includes("red")) return "🟥";
  if (t.includes("substitution")) return "🔁";
  if (t.includes("kickoff")) return "▶";
  if (t.includes("halftime") || t.includes("end")) return "⏸";
  return "•";
}

function renderPicker(matches) {
  titleEl.textContent = "Pick a match";
  const wrap = h("div", { class: "pick" });
  if (!matches.length) { wrap.appendChild(h("div", { class: "center muted", text: "No matches found." })); return wrap; }

  // auto-track option
  wrap.appendChild(h("div", { class: "row", onclick: () => choose(null) }, [
    h("span", { class: "l", text: "↻ Auto (live game)" }),
    h("span", { class: "r", text: "default" }),
  ]));

  let curDay = "";
  for (const mt of matches) {
    const day = new Date(mt.date).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    if (day !== curDay) { curDay = day; wrap.appendChild(h("div", { class: "day", text: day })); }
    const score = mt.state === "pre" ? "vs" : `${mt.homeScore}–${mt.awayScore}`;
    const right = mt.live ? mt.statusText : mt.state === "post" ? "FT" : new Date(mt.date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    wrap.appendChild(h("div", { class: "row", onclick: () => choose(mt.id) }, [
      h("span", { class: "l", text: `${mt.homeAbbr} ${score} ${mt.awayAbbr}` }),
      h("span", { class: `r ${mt.live ? "live" : ""}`, text: right }),
    ]));
  }
  return wrap;
}

async function choose(id) {
  await window.wc.setMatch(id);
  viewMode = "match";
  body.replaceChildren(h("div", { class: "center muted", text: "Loading…" }));
}
