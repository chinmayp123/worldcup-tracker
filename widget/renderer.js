// renderer — draws the widget from the plain JSON the main process sends. No data fetching
// here; main owns that. Built with createElement + textContent (CSP blocks inline, and we
// avoid innerHTML with API strings).
const app = document.getElementById("app");
const body = document.getElementById("body");
const titleEl = document.getElementById("title");

let expanded = false;
let pinned = true;
let viewMode = "match"; // "match" | "pick" | "parlay" | "record"
let last = null;        // last data payload
let parlays = null;     // last fetched daily-parlays payload (lazy, on opening the view)
let record = null;      // last fetched bet record + history (lazy, on opening the view)

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
// "home" | "draw" | "away" → display label for the current match
const sideLabel = (side, m) => side === "draw" ? "Draw" : side === "home" ? m.home.abbr : m.away.abbr;

// FIFA 3-letter code → ISO 3166 code for crisp SVG flags from flagcdn.com (sharp at any size,
// unlike ESPN's low-res raster country logos). Unmapped teams fall back to the ESPN logo.
const FIFA_ISO = {
  USA: "us", CAN: "ca", MEX: "mx", BRA: "br", ARG: "ar", URU: "uy", COL: "co", ECU: "ec", PAR: "py", PER: "pe", CHI: "cl", VEN: "ve", BOL: "bo",
  ENG: "gb-eng", SCO: "gb-sct", WAL: "gb-wls", NIR: "gb-nir", IRL: "ie",
  FRA: "fr", GER: "de", ESP: "es", POR: "pt", NED: "nl", BEL: "be", ITA: "it", CRO: "hr", SUI: "ch", SWE: "se", DEN: "dk", POL: "pl", AUT: "at", SRB: "rs", CZE: "cz", TUR: "tr", UKR: "ua", NOR: "no", GRE: "gr", ROU: "ro", HUN: "hu", BIH: "ba", SVK: "sk", SVN: "si", ALB: "al",
  MAR: "ma", SEN: "sn", TUN: "tn", ALG: "dz", EGY: "eg", NGA: "ng", CMR: "cm", GHA: "gh", CIV: "ci", RSA: "za", MLI: "ml", CPV: "cv", COD: "cd", ANG: "ao",
  JPN: "jp", KOR: "kr", AUS: "au", IRN: "ir", KSA: "sa", QAT: "qa", IRQ: "iq", UAE: "ae", UZB: "uz", JOR: "jo", CHN: "cn", NZL: "nz",
  CRC: "cr", PAN: "pa", HON: "hn", JAM: "jm", HAI: "ht", CUW: "cw", TRI: "tt",
};
const flagUrl = (abbr, fallback) => {
  const code = FIFA_ISO[(abbr || "").toUpperCase()];
  return code ? `https://flagcdn.com/${code}.svg` : (fallback || null);
};
// a country flag <img>; crisp SVG when the code is known, else the ESPN logo. null if neither.
function flagImg(abbr, logo) {
  const src = flagUrl(abbr, logo);
  if (!src) return null;
  const img = h("img", { class: "flag" });
  img.src = src;
  img.alt = "";
  return img;
}
// rough perceptual closeness of two #rrggbb colours (so two similar kits don't clash)
function colorClose(a, b) {
  const rgb = (c) => { const n = parseInt((c || "").replace("#", ""), 16); return [n >> 16 & 255, n >> 8 & 255, n & 255]; };
  const [r1, g1, b1] = rgb(a), [r2, g2, b2] = rgb(b);
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2) < 75;
}

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
document.getElementById("btn-parlays").addEventListener("click", async () => {
  if (viewMode === "parlay") { viewMode = "match"; render(); return; }
  viewMode = "parlay";
  render(); // shows a "building…" placeholder while we fetch
  const data = await window.wc.getParlays();
  parlays = data;
  if (viewMode === "parlay") render(); // only redraw if the user is still on this view
});
document.getElementById("btn-record").addEventListener("click", async () => {
  if (viewMode === "record") { viewMode = "match"; render(); return; }
  viewMode = "record";
  render(); // shows a "loading…" placeholder while we fetch
  const data = await window.wc.getRecord();
  record = data;
  if (viewMode === "record") render();
});
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
  if (viewMode === "parlay") { body.replaceChildren(); body.appendChild(renderParlays(parlays)); return; }
  if (viewMode === "record") { body.replaceChildren(); body.appendChild(renderRecord(record)); return; }
  if (!last) return;
  body.replaceChildren();

  if (viewMode === "pick") { body.appendChild(renderPicker(last.matches || [])); return; }

  if (last.error) {
    titleEl.textContent = "World Cup 2026";
    body.appendChild(h("div", { class: "center muted", text: `Couldn’t load: ${last.error}` }));
    return;
  }
  if (!last.match) {
    titleEl.textContent = "World Cup 2026";
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

  // each team's real kit colour (ESPN), with a contrast guard so two similar kits don't
  // both render the same — fall back to the away alternate, then the default pink
  const homeColor = m.home.color || "#7aa2ff";
  let awayColor = m.away.color || "#ff8fb3";
  if (colorClose(homeColor, awayColor)) awayColor = (m.away.altColor && !colorClose(homeColor, m.away.altColor)) ? m.away.altColor : "#ff8fb3";
  app.style.setProperty("--home", homeColor);
  app.style.setProperty("--away", awayColor);

  // status + score (with country flags)
  blocks.push(h("div", { class: `live ${liveClass(m)}`, text: (m.state === "in" ? "● " : "") + m.statusText }));
  blocks.push(h("div", { class: "score-row" }, [
    h("div", { class: "side home" }, [
      flagImg(m.home.abbr, m.home.logo),
      h("span", { class: "team h", text: expanded ? m.home.name : m.home.abbr }),
    ].filter(Boolean)),
    h("span", { class: "score", text: m.state === "pre" ? "vs" : `${m.home.score} – ${m.away.score}` }),
    h("div", { class: "side away" }, [
      h("span", { class: "team a", text: expanded ? m.away.name : m.away.abbr }),
      flagImg(m.away.abbr, m.away.logo),
    ].filter(Boolean)),
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
    if (expanded && p.pOver25 != null) {
      blocks.push(h("div", { class: "winlegend" }, [
        h("span", { text: `Over 2.5: ${Math.round(p.pOver25 * 100)}%` }),
        h("span", { text: `BTTS: ${Math.round(p.pBTTS * 100)}%` }),
      ]));
    }
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
    // model-vs-market divergence (live) — surfaced as a gap, not a promise of value
    const v = m.valueEdges && m.valueEdges[0];
    if (v && v.edge >= 0.08) {
      const stake = v.kelly > 0.002 ? ` · stake ${(v.kelly * 100).toFixed(1)}% bankroll (½-Kelly)` : "";
      blocks.push(h("div", { class: "rec" }, [
        h("span", { class: "tag Lean", text: "Model gap" }),
        h("span", { class: "txt", text: `${v.label}: model ${Math.round(v.model * 100)}% vs market ${Math.round(v.mkt * 100)}% (+${Math.round(v.edge * 100)}%)${stake}${expanded ? " — divergence, not a guarantee" : ""}` }),
      ]));
    }
    // public-vs-sharp fade (Action Network): public piling on one side, money lighter there
    const fade = m.publicBetting && m.publicBetting.fade;
    if (fade) {
      const pubAb = sideLabel(fade.publicSide, m), shAb = sideLabel(fade.sharpSide, m);
      const pub = m.publicBetting.outcomes[fade.publicSide];
      blocks.push(h("div", { class: "rec" }, [
        h("span", { class: "tag Sharp", text: "Fade public" }),
        h("span", { class: "txt", text: `${pubAb} ${pub.tickets}% tickets / ${pub.money}% money — sharper money leans ${shAb}${expanded ? " (contrarian signal, not a lock)" : ""}` }),
      ]));
    }
  }

  // ---- full-only sections ----
  if (expanded) {
    if (m.momentum && m.momentum.length >= 5) {
      blocks.push(h("div", { class: "label", text: "Momentum · FotMob (pressure)" }));
      const max = Math.max(1, ...m.momentum.map((d) => Math.abs(d.v)));
      const spark = h("div", { class: "spark" });
      for (const d of m.momentum) {
        const bar = h("span", { class: "sb " + (d.v >= 0 ? "h" : "a") });
        bar.style.height = `${Math.max(3, Math.round((Math.abs(d.v) / max) * 100))}%`;
        spark.appendChild(bar);
      }
      blocks.push(spark);
      blocks.push(h("div", { class: "winlegend" }, [h("span", { text: `◀ ${m.home.abbr}` }), h("span", { text: `${m.away.abbr} ▶` })]));
    }
    if (m.pregameProj) {
      const pg = m.pregameProj, c = pg.corners;
      blocks.push(h("div", { class: "label", text: `Pregame projections · ${pg.basis} (model est.)` }));
      if (pg.shots) {
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `${m.home.abbr} shots ${pg.shots.home.shots.toFixed(1)} (${pg.shots.home.sot.toFixed(1)} on target)` }),
          h("span", { class: "est", text: `${pg.shots.away.shots.toFixed(1)} (${pg.shots.away.sot.toFixed(1)} on target) ${m.away.abbr}` }),
        ]));
      }
      blocks.push(h("div", { class: "gk" }, [
        h("span", { text: `Corners total ${c.total.toFixed(1)}` }),
        h("span", { class: "est", text: `O${c.line} ${Math.round(c.pOver * 100)}%${c.odds != null ? ` (${c.odds > 0 ? "+" : ""}${c.odds})` : ""}` }),
      ]));
      blocks.push(h("div", { class: "gk" }, [
        h("span", { text: `${m.home.abbr} ${c.home.toFixed(1)} · ${m.away.abbr} ${c.away.toFixed(1)}` }),
        h("span", { class: "est", text: "corners per side" }),
      ]));
      const sv = (abbr, s) => blocks.push(h("div", { class: "gk" }, [
        h("span", { text: `${abbr} keeper saves` }),
        h("span", { class: "est", text: `proj ${s.proj.toFixed(1)} · O${s.line} ${Math.round(s.pOver * 100)}%${s.odds != null ? ` (${s.odds > 0 ? "+" : ""}${s.odds})` : ""}` }),
      ]));
      sv(m.home.abbr, pg.saves.home);
      sv(m.away.abbr, pg.saves.away);
    }
    if (m.sotProjections && ((m.sotProjections.home || []).length || (m.sotProjections.away || []).length)) {
      blocks.push(h("div", { class: "label", text: "Projected shots on target · per player (model est.)" }));
      blocks.push(h("div", { class: "hint", text: "From each player's recent shotmaps. Display-only — no bettable de-vigged line." }));
      const rows = (arr, abbr) => (arr || []).forEach((p) => blocks.push(h("div", { class: "gk" }, [
        h("span", { text: `${abbr} ${p.name}` }),
        h("span", { class: "est", text: `proj ${p.projSOT.toFixed(1)} SOT · ${p.xgPg.toFixed(2)} xG/g (${p.games}g)` }),
      ])));
      rows(m.sotProjections.home, m.home.abbr);
      rows(m.sotProjections.away, m.away.abbr);
    }
    if (m.conditions) {
      const cd = m.conditions;
      blocks.push(h("div", { class: "label", text: "Conditions · venue & rest (WC2026)" }));
      if (cd.venue) {
        const altTxt = cd.venue.alt >= 1000 ? `${cd.venue.alt}m altitude` : `${cd.venue.alt}m`;
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: cd.venue.name || "Venue" }),
          h("span", { class: "est", text: `${altTxt} · ${cd.venue.heatLabel}` }),
        ]));
      }
      if (cd.home.restDays != null || cd.away.restDays != null) {
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `${m.home.abbr} rest` }),
          h("span", { class: "est", text: cd.home.restDays != null ? `${cd.home.restDays} days` : "—" }),
        ]));
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `${m.away.abbr} rest` }),
          h("span", { class: "est", text: cd.away.restDays != null ? `${cd.away.restDays} days` : "—" }),
        ]));
      }
    }
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
    if (m.xg) {
      const xg = m.xg;
      blocks.push(h("div", { class: "label", text: "Expected goals (xG) · FotMob" }));
      blocks.push(h("div", { class: "hint", text: "xG = chance quality (a 0.30 shot ≈ 30% to score). Higher = better chances." }));
      blocks.push(h("div", { class: "gk" }, [
        h("span", { text: `${m.home.abbr} ${xg.home.xg.toFixed(2)} xG` }),
        h("span", { class: "est", text: `${xg.away.xg.toFixed(2)} xG ${m.away.abbr}` }),
      ]));
      blocks.push(h("div", { class: "gk" }, [
        h("span", { text: `Shots ${xg.home.shots} (${xg.home.sot} on target)` }),
        h("span", { class: "est", text: `${xg.away.shots} (${xg.away.sot} on target)` }),
      ]));
      if (xg.xgot) blocks.push(h("div", { class: "gk" }, [
        h("span", { text: `xG on target (xGOT) ${xg.xgot.home.toFixed(2)}`, title: "expected goals from shots on target — measures placement/finishing" }),
        h("span", { class: "est", text: `${xg.xgot.away.toFixed(2)}` }),
      ]));
      if (xg.bigChances) blocks.push(h("div", { class: "gk" }, [
        h("span", { text: `Big chances ${xg.bigChances.home}${xg.bigChancesMissed ? ` (${xg.bigChancesMissed.home} missed)` : ""}`, title: "clear-cut scoring opportunities" }),
        h("span", { class: "est", text: `${xg.bigChances.away}${xg.bigChancesMissed ? ` (${xg.bigChancesMissed.away} missed)` : ""}` }),
      ]));
      for (const p of xg.players) {
        if (p.xg < 0.05) continue;
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `${p.side === "home" ? m.home.abbr : m.away.abbr} ${p.name}${p.goals ? " ⚽" + p.goals : ""}` }),
          h("span", { class: "est", text: `${p.xg.toFixed(2)} xG · ${p.sot} on target` }),
        ]));
      }
    }
    if (m.topPlayers || m.form) {
      blocks.push(h("div", { class: "label", text: "Top performers · rating & form" }));
      const tpRows = (arr, abbr) => (arr || []).forEach((p) => blocks.push(h("div", { class: "gk" }, [
        h("span", { text: `${abbr} ${p.name}` }),
        h("span", { class: "est", text: p.rating.toFixed(1) }),
      ])));
      if (m.topPlayers) { tpRows(m.topPlayers.home, m.home.abbr); tpRows(m.topPlayers.away, m.away.abbr); }
      if (m.form) {
        const formRow = (abbr, arr) => blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `${abbr} form` }),
          h("span", { class: "formrow" }, (arr || []).map((r) => h("span", { class: `formdot ${r}`, text: r }))),
        ]));
        formRow(m.home.abbr, m.form.home);
        formRow(m.away.abbr, m.form.away);
      }
    }
    if (m.odds) {
      const src = m.odds.source === "live" ? "FanDuel · LIVE" : m.odds.source === "pre" ? "FanDuel · pre" : m.odds.source === "fanduel-an" ? "FanDuel" : `${m.odds.provider || "book"} · pre`;
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
    if (m.publicBetting && m.publicBetting.outcomes) {
      const pb = m.publicBetting;
      blocks.push(h("div", { class: "label", text: "Public betting · Action Network (tickets / money)" }));
      for (const side of ["home", "draw", "away"]) {
        const c = pb.outcomes[side];
        if (!c || c.tickets == null || (c.tickets === 0 && c.money === 0)) continue;
        const tags = [];
        if (side === pb.publicSide) tags.push("public");
        if (pb.fade && side === pb.fade.sharpSide) tags.push("sharp lean");
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `${sideLabel(side, m)}${c.odds != null ? ` ${c.odds > 0 ? "+" : ""}${c.odds}` : ""}${tags.length ? `  (${tags.join(", ")})` : ""}` }),
          h("span", { class: "est", text: `${c.tickets}% tickets · ${c.money}% money` }),
        ]));
      }
      const hasData = (o) => o && o.tickets != null && !(o.tickets === 0 && o.money === 0);
      if (pb.spread && hasData(pb.spread.home)) {
        const sp = pb.spread.home;
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `Spread ${m.home.abbr} ${sp.line > 0 ? "+" : ""}${sp.line}` }),
          h("span", { class: "est", text: `${sp.tickets}% tickets · ${sp.money}% money` }),
        ]));
      }
      if (pb.total && hasData(pb.total.over)) {
        const tv = pb.total.over;
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `Total Over ${pb.total.line}` }),
          h("span", { class: "est", text: `${tv.tickets}% tickets · ${tv.money}% money` }),
        ]));
      }
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
    if (m.corners) {
      const cor = m.corners;
      blocks.push(h("div", { class: "label", text: "Corners · per side + total O/U (model est.)" }));
      if (cor.settled) {
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `${m.home.abbr} ${cor.home} · ${m.away.abbr} ${cor.away}` }),
          h("span", { class: "est", text: `final ${cor.total} · O${cor.line} ${cor.over ? "✓" : "✗"}` }),
        ]));
      } else {
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `${m.home.abbr} ${cor.home} → proj ${cor.projH.toFixed(1)}` }),
          h("span", { text: `${cor.projA.toFixed(1)} ← ${cor.away} ${m.away.abbr}`, class: "est" }),
        ]));
        const ou = cor.need <= 0
          ? `O${cor.line} ✓ hit`
          : `O${cor.line} ${Math.round(cor.pOver * 100)}%${cor.odds != null ? ` (${cor.odds > 0 ? "+" : ""}${cor.odds})` : ""}`;
        blocks.push(h("div", { class: "gk" }, [
          h("span", { text: `total proj ${cor.totalProj.toFixed(1)}` }),
          h("span", { class: "est", text: ou }),
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
      blocks.push(h("div", { class: "label full", text: m.group.header }));
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
        const og = /own goal/i.test(e.type || "");
        blocks.push(h("div", { class: "ev" }, [
          h("span", { class: "min", text: e.min }),
          h("span", { text: `${eventIcon(e.type)} ${e.teamAbbr ? e.teamAbbr + " " : ""}${e.players || e.type}${og ? " (OG)" : ""}` }),
        ]));
      }
    }
    blocks.push(h("div", { class: "disc", text: "⚠ Model estimates, not financial advice. Odds are −EV on average; stake small." }));
  }

  if (expanded) flushCards(blocks);
  else body.appendChild(frag(blocks));
}

// expanded layout: group the flat blocks into labeled cards, flow them across two columns,
// and keep the header (pre-first-label), full-width sections, and disclaimer outside the grid.
function flushCards(blocks) {
  const header = [], sections = [], full = [], footer = [];
  let cur = null;
  for (const b of blocks) {
    const cls = b.classList;
    if (cls && cls.contains("disc")) { footer.push(b); continue; }
    if (cls && cls.contains("label") && !cls.contains("best-lbl")) {
      cur = { full: cls.contains("full"), nodes: [b] };
      (cls.contains("full") ? full : sections).push(cur);
    } else if (cur) cur.nodes.push(b);
    else header.push(b); // before the first label = score header
  }
  const mkCard = (s) => { const sec = h("section", { class: "card" }); s.nodes.forEach((n) => sec.appendChild(n)); return sec; };
  // place each card in the currently-shorter column (by row count) so the columns stay
  // balanced and short cards like Match Events fill the gap under a tall neighbour
  const cols = [h("div", { class: "col" }), h("div", { class: "col" })];
  const weight = [0, 0];
  for (const s of sections) {
    const i = weight[0] <= weight[1] ? 0 : 1;
    cols[i].appendChild(mkCard(s));
    weight[i] += s.nodes.length;
  }
  body.appendChild(frag(header));
  body.appendChild(h("div", { class: "grid2" }, [cols[0], cols[1]]));
  full.forEach((s) => body.appendChild(mkCard(s)));
  footer.forEach((f) => body.appendChild(f));
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

  wrap.appendChild(h("div", { class: "muted pick-hint", text: "middle = predicted final (model)" }));

  // auto-track option
  wrap.appendChild(h("div", { class: "row", onclick: () => choose(null) }, [
    h("span", { class: "l", text: "↻ Auto (live game)" }),
    h("span", { class: "pred-mini", text: "" }),
    h("span", { class: "r", text: "default" }),
  ]));

  let curDay = "";
  for (const mt of matches) {
    const day = new Date(mt.date).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    if (day !== curDay) { curDay = day; wrap.appendChild(h("div", { class: "day", text: day })); }
    const score = mt.state === "pre" ? "vs" : `${mt.homeScore}–${mt.awayScore}`;
    const right = mt.live ? mt.statusText : mt.state === "post" ? "FT" : new Date(mt.date).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    const predTxt = mt.pred ? `${mt.pred.ph}–${mt.pred.pa}` : "";
    const predTitle = mt.pred ? `predicted: ${mt.homeAbbr} ${Math.round(mt.pred.wH * 100)}% / Draw ${Math.round(mt.pred.wD * 100)}% / ${mt.awayAbbr} ${Math.round(mt.pred.wA * 100)}%` : "";
    const teamEl = (abbr, color) => { const s = h("span", { class: "pk-team", text: abbr }); if (color) s.style.color = color; return s; };
    const left = h("span", { class: "l" }, [
      flagImg(mt.homeAbbr, mt.homeLogo),
      teamEl(mt.homeAbbr, mt.homeColor),
      h("span", { class: "pk-score", text: score }),
      teamEl(mt.awayAbbr, mt.awayColor),
      flagImg(mt.awayAbbr, mt.awayLogo),
    ].filter(Boolean));
    wrap.appendChild(h("div", { class: "row", onclick: () => choose(mt.id) }, [
      left,
      h("span", { class: "pred-mini", text: predTxt, title: predTitle }),
      h("span", { class: `r ${mt.live ? "live" : ""}`, text: right }),
    ]));
  }
  return wrap;
}

// --- daily parlays view ---
const fmtAm = (ml) => (ml == null ? "-" : ml > 0 ? `+${ml}` : `${ml}`);
const pctR = (p) => `${Math.round(p * 100)}%`;

// "NED v SWE" → [flag, NED, v, SWE, flag]; falls back to plain text if it can't be split
function gameTitle(game) {
  const parts = (game || "").split(" v ");
  if (parts.length !== 2) return [h("span", { class: "p-title-txt", text: game || "" })];
  const [hAb, aAb] = parts.map((s) => s.trim());
  return [
    flagImg(hAb), h("span", { class: "pk-team", text: hAb }),
    h("span", { class: "p-v", text: "v" }),
    h("span", { class: "pk-team", text: aAb }), flagImg(aAb),
  ].filter(Boolean);
}

function parlayCard(p, titleNodes, all) {
  const card = h("div", { class: "parlay" + (all ? " all" : "") });
  card.appendChild(h("div", { class: "p-head" }, [
    h("span", { class: "p-title" }, titleNodes),
    h("span", { class: "p-odds", text: fmtAm(p.americanOdds) }),
  ]));
  card.appendChild(h("div", { class: "p-payout", text: `$${p.stake} → $${p.payout.toFixed(2)}` }));
  for (const l of p.legs) {
    card.appendChild(h("div", { class: "p-leg" }, [
      h("span", { class: "p-leg-txt", text: `${l.game} · ${l.market}: ${l.pick}` }),
      h("span", { class: "p-leg-meta", text: `${fmtAm(l.ml)} · model ${pctR(l.modelProb)} · edge ${l.edge >= 0 ? "+" : ""}${Math.round(l.edge * 100)}%` }),
    ]));
    if (l.why) card.appendChild(h("div", { class: "p-why", text: l.why }));
  }
  const evGood = p.ev >= 0;
  const k = p.kelly > 0.002 ? `Kelly ${(p.kelly * 100).toFixed(1)}%` : "Kelly: skip";
  card.appendChild(h("div", { class: "p-foot" }, [
    h("span", { text: `model ${pctR(p.modelProb)}` }),
    h("span", { class: evGood ? "up" : "neg", text: `EV ${evGood ? "+" : ""}$${p.ev.toFixed(2)}` }),
    h("span", { text: k }),
  ]));
  return card;
}

function renderParlays(data) {
  titleEl.textContent = "Daily parlays";
  const wrap = h("div", { class: "parlays" });
  if (!data) { wrap.appendChild(h("div", { class: "center muted", text: "Building parlays…" })); return wrap; }
  if (data.error) { wrap.appendChild(h("div", { class: "center muted", text: `Couldn’t build: ${data.error}` })); return wrap; }
  if (!(data.perGame && data.perGame.length) && !data.cross) {
    wrap.appendChild(h("div", { class: "center muted", text: "No upcoming games with FanDuel odds yet." }));
    return wrap;
  }

  wrap.appendChild(h("div", { class: "muted p-sub", text: `${data.date} · $${data.stake} each` }));

  // all-games parlay (one leg per game) — its own section, up top, highlighted
  if (data.cross) {
    wrap.appendChild(h("div", { class: "label", text: "All games · best value, one leg each" }));
    wrap.appendChild(parlayCard(data.cross, [h("span", { class: "p-title-txt", text: "All games · value" })], true));
  }

  // longshot parlay (longest-priced +edge leg per game) — max payout, lower hit rate
  if (data.longshot) {
    wrap.appendChild(h("div", { class: "label", text: "Longshot · max payout, lower hit rate" }));
    wrap.appendChild(parlayCard(data.longshot, [h("span", { class: "p-title-txt", text: "Longshot" })], true));
  }

  // same-game parlays, one per upcoming match
  const sgp = (data.perGame || []).filter((g) => g.parlay);
  if (sgp.length) {
    wrap.appendChild(h("div", { class: "label", text: "Same-game parlays" }));
    for (const g of sgp) wrap.appendChild(parlayCard(g.parlay, gameTitle(g.game), false));
  }

  wrap.appendChild(h("div", { class: "disc", text: "⚠ Model estimates, not financial advice. Parlays compound the book’s margin — most are −EV. Stake small." }));
  return wrap;
}

// --- record + history view ---
function historyCard(p) {
  const result = p.settled ? p.result : "pending"; // "win" | "loss" | "pending"
  const badge = h("span", { class: `rec-badge ${result}`, text: result === "win" ? "WON" : result === "loss" ? "LOST" : "PENDING" });
  const title = p.type === "cross" ? "All games" : p.game;
  const card = h("div", { class: "parlay hist" }, [
    h("div", { class: "p-head" }, [
      h("span", { class: "p-title" }, [h("span", { class: "p-title-txt", text: title }), badge]),
      h("span", { class: "p-odds", text: fmtAm(p.americanOdds) }),
    ]),
  ]);
  for (const l of p.legs) {
    const r = l.result; // "hit" | "miss" | null
    const mark = r === "hit" ? "✓" : r === "miss" ? "✗" : "·";
    card.appendChild(h("div", { class: "p-leg" }, [
      h("span", { class: `leg-mark ${r || "pend"}`, text: mark }),
      h("span", { class: "p-leg-txt", text: `${l.game} · ${l.market}: ${l.pick}` }),
      h("span", { class: "p-leg-meta", text: l.finalScore || fmtAm(l.ml) }),
    ]));
  }
  card.appendChild(h("div", { class: "p-foot" }, [
    h("span", { text: `$${p.stake} → $${p.payout.toFixed(2)}` }),
    h("span", {
      class: result === "win" ? "up" : result === "loss" ? "neg" : "",
      text: result === "win" ? `+$${(p.payout - p.stake).toFixed(2)}` : result === "loss" ? `−$${p.stake.toFixed(2)}` : "pending",
    }),
  ]));
  return card;
}

function renderRecord(data) {
  titleEl.textContent = "Record";
  const wrap = h("div", { class: "record" });
  if (!data) { wrap.appendChild(h("div", { class: "center muted", text: "Loading record…" })); return wrap; }
  if (data.error) { wrap.appendChild(h("div", { class: "center muted", text: `Couldn’t load: ${data.error}` })); return wrap; }
  const s = data.stats || {};
  const pct = (p) => (p == null ? "—" : `${Math.round(p * 100)}%`);
  const money = (v) => (v == null ? "—" : `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`);

  // headline stats grid
  const stat = (label, val, cls) => h("div", { class: "rec-stat" }, [
    h("div", { class: "rec-val " + (cls || ""), text: val }),
    h("div", { class: "rec-lbl", text: label }),
  ]);
  wrap.appendChild(h("div", { class: "label", text: "All-time" }));
  wrap.appendChild(h("div", { class: "rec-grid" }, [
    stat("Leg hit rate", s.legs ? `${pct(s.legHitRate)}` : "—"),
    stat("Legs settled", String(s.legs || 0)),
    stat("Brier", s.brier == null ? "—" : s.brier.toFixed(3)),
    stat("Parlays won", `${s.parlayWins || 0}/${s.parlays || 0}`),
    stat("Profit", money(s.profit), (s.profit ?? 0) >= 0 ? "up" : "neg"),
    stat("ROI", pct(s.roi), (s.roi ?? 0) >= 0 ? "up" : "neg"),
  ]));
  if (!s.legs) wrap.appendChild(h("div", { class: "hint", text: "Stats fill in as games finish and settle each morning. Brier = calibration (lower is better)." }));

  // rolling recent window — the trend, undistorted by old lucky/unlucky days
  const rc = data.recent;
  if (rc && rc.legs) {
    const range = rc.from && rc.to && rc.from !== rc.to ? ` (${rc.from} → ${rc.to})` : rc.to ? ` (${rc.to})` : "";
    wrap.appendChild(h("div", { class: "label", text: `Recent · last ${rc.windowDays} day${rc.windowDays > 1 ? "s" : ""}${range}` }));
    wrap.appendChild(h("div", { class: "rec-grid" }, [
      stat("Hit rate", `${pct(rc.legHitRate)} (${rc.legs})`),
      stat("Brier", rc.brier == null ? "—" : rc.brier.toFixed(3)),
      stat("Profit", money(rc.profit), (rc.profit ?? 0) >= 0 ? "up" : "neg"),
    ]));
  }

  // calibration
  if (s.calibration && s.calibration.length) {
    wrap.appendChild(h("div", { class: "label", text: "Calibration · model % vs actual" }));
    for (const b of s.calibration) wrap.appendChild(h("div", { class: "gk" }, [
      h("span", { text: b.bucket }),
      h("span", { class: "est", text: `pred ${pct(b.predicted)} → hit ${pct(b.actual)} (n=${b.n})` }),
    ]));
  }

  // shots/corner projection accuracy (model est. vs actual final stats)
  const pa = data.projAccuracy;
  if (pa && (pa.corners || pa.shots)) {
    wrap.appendChild(h("div", { class: "label", text: "Projection accuracy · model vs actual" }));
    const accRow = (name, a) => { if (a) wrap.appendChild(h("div", { class: "gk" }, [
      h("span", { text: `${name} (n=${a.n})` }),
      h("span", { class: "est", text: `avg proj ${a.projAvg.toFixed(1)} → actual ${a.actualAvg.toFixed(1)} · off by ${a.mae.toFixed(1)}` }),
    ])); };
    accRow("Corners total", pa.corners);
    accRow("Total shots", pa.shots);
  }

  // history of recommended parlays, newest day first
  wrap.appendChild(h("div", { class: "label", text: "History · recommended parlays" }));
  if (!data.days || !data.days.length) { wrap.appendChild(h("div", { class: "muted", text: "No parlays logged yet." })); }
  for (const day of data.days || []) {
    wrap.appendChild(h("div", { class: "rec-day", text: day.date }));
    for (const p of day.parlays) wrap.appendChild(historyCard(p));
  }
  wrap.appendChild(h("div", { class: "disc", text: "⚠ Player-prop legs can't auto-settle from the score; those parlays stay pending." }));
  return wrap;
}

async function choose(id) {
  await window.wc.setMatch(id);
  viewMode = "match";
  body.replaceChildren(h("div", { class: "center muted", text: "Loading…" }));
}
