# Data sources — research notes (for better picks)

Goal: get the data points that make picks genuinely useful — real **lineups**, **xG**,
**player props** (scorer, shots on target, saves), and **corners/cards** — beyond what the
current free stack provides.

## What we use today
- **ESPN public API** (free, no key) — scores, team box-score stats (incl. **corners per
  side**), keeper stats, standings, play-by-play events. *No player xG, no shot-level data.*
- **FotMob** (free, no key — `fotmob.mjs`) — **real shot-level xG** (team + per-player) for
  every WC match, read from the site's Next.js `__NEXT_DATA__` SSR payload. Feeds true xG
  into the score-prediction + betting models, replacing the old shot proxy. Unofficial, so
  it's best-effort: any failure falls back to the proxy silently. See note below.
- **The Odds API** (key in `odds.config.json`) — moneyline + totals across US books, and
  **anytime-scorer / shots-on-target player props** per event. *No saves or corners markets
  for soccer.* Free tier = 500 requests/month.

## The honest gaps
- **No betting market exists** for goalkeeper **saves** or **corners** in any feed we can
  reach cheaply — so those stay **model estimates** (which we now show per side).
- ~~No player-level xG / shot rates for World Cup squads on free tiers~~ **Solved** via
  FotMob's `__NEXT_DATA__` (see above) — real shot xG, team + per-player, free. (Understat/
  FBref still cover club leagues only; FBref's advanced stats shut down Jan 2026.)

## Alternatives evaluated

| Source | Gives us | Cost | Verdict |
|--------|----------|------|---------|
| **API-Football** (api-sports.io) | All WC2026 matches: **lineups**, player stats (shots, etc.), fixture stats (**corners**), **predictions** endpoint, pre+live **odds** | Free 100 req/day · Pro $19/mo (7,500/day) | **Best free upgrade.** Lineups confirm starters/penalty-takers — huge for props. No xG. |
| **Sportmonks** | **Real xG**, expected lineups, player stats, pressure index | Free plan (limited) · paid for full/WC | **Best data quality.** Get this if we want a real xG-driven model; likely paid for WC. |
| **SofaScore** (unofficial) | xG, shotmaps, ratings, lineups | "free" via scraping | Rich but **brittle + ToS risk** (like FotMob). Avoid for a real tool. |
| **FotMob** (unofficial) | **xG, shotmaps** | free | **In use** (`fotmob.mjs`). The `/api/*` endpoints are gated by a rotating signed `x-mas` header, but the public pages embed the same data in `__NEXT_DATA__` (SSR JSON, no header) — which we read. Brittle if the page restructures; best-effort with proxy fallback. |
| **Props aggregators** — OddsPapi, SportsGameOdds, OddsJam, OpticOdds | Real **player props + corners + cards** across 100–370 books | OddsPapi/SportsGameOdds have **free tiers**; OddsJam/OpticOdds $99–499/mo+ | Only realistic way to get real saves/corners/props *odds*. Worth testing free tiers for WC soccer coverage. |
| **BetsAPI** (bet365) | bet365 corners/cards/props markets | ~£20–30/mo | Good specifically for corners/cards betting lines. |

## Recommended next steps (in priority order)
1. **Add API-Football (free key).** Biggest pick-quality jump for $0: real **lineups**
   (so scorer/SoT props target actual starters + penalty taker) + player stats + a
   predictions endpoint. Needs a free signup → user must create the key.
2. **Test a props aggregator free tier** (OddsPapi or SportsGameOdds) to see if they carry
   WC **corners/cards/saves** lines we can de-vig. If yes, wire in real markets.
3. ~~Consider Sportmonks (paid) for a true xG model~~ — **no longer needed**: FotMob now
   feeds real shot xG for free (`fotmob.mjs`). Sportmonks only worth it for *expected*
   lineups / pressure index, which FotMob doesn't give us.

The model code is already isolated in `lib.mjs`, so adding a richer source means feeding
better numbers into the same prediction/devig pipeline — not a rewrite.

## Sources
- API-Football WC guide: https://www.api-football.com/news/post/fifa-world-cup-2026-guide-to-using-data-with-api-sports
- Sportmonks xG/pricing: https://www.sportmonks.com/football-api/plans-pricing/
- SofaScore data (unofficial scrapers): https://apify.com/azzouzana/sofascore-scraper-pro/api
- Odds API pricing comparison 2026: https://oddspapi.io/blog/best-odds-apis-2026-comparison/
- OpticOdds sports betting API: https://opticodds.com/sports-betting-api
- Goalkeeper saves modeling (xS): https://www.soccermetrics.net/goalkeeping-analytics/expected-saves-an-inverse-of-expected-goals
- Corners (compound Poisson): https://arxiv.org/abs/2112.13001
- Dixon–Coles team-strength model: https://dashee87.github.io/football/python/predicting-football-results-with-statistical-modelling-dixon-coles-and-time-weighting/
- Devig / finding prop edge: https://betpredictionsite.com/blog/prop-betting-iq-price-player-props/
