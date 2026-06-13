# worldcup-tracker

Live FIFA World Cup 2026 match tracker for your terminal. Zero dependencies — just Node 18+ (uses ESPN's public API, no key required).

```
  Canada  1 - 0  Bosnia-Herzegovina    ● LIVE  37'
  BMO Field   updated 3:16:26 PM

  CAN ████████████████ ██████████████ BIH   possession

      54.5            Possession %        45.5
         0               Shots               3
         1               Corners             0
        ...

  Match events
   11'  🟨 CAN Alistair Johnston
   34'  ⚽ GOAL CAN Jonathan David
```

## Usage

```sh
node worldcup.mjs              # auto-track the live game (or list today's matches)
node worldcup.mjs list         # upcoming schedule (today + next 2 days) with odds
node worldcup.mjs groups       # all 12 group standings tables
node worldcup.mjs canada       # track a match by team name, abbreviation, or event id
node worldcup.mjs usa --once   # single snapshot, no refresh loop
node worldcup.mjs usa -i 15    # refresh every 15 seconds (default 30, min 10)
```

While tracking, the screen refreshes in place with the live score, match clock, possession bar, full stat comparison (shots, corners, fouls, cards, passes, tackles, and more), and a timeline of goals, cards, and substitutions. Tracking stops automatically at full time.

## What it shows

- **Score and clock** — live minute, halftime, full time
- **Possession bar** — visual split between the two teams
- **Stats table** — the leading team's number is bolded per stat
- **Goalkeepers** — each keeper's saves, goals conceded, and shots faced (includes subbed-in keepers)
- **Pre-match odds** — moneyline for each outcome with vig-stripped implied win probabilities, plus spread and over/under. Note: ESPN's free API only carries the opening line, not live in-play odds.
- **Group standings** — the live group table (rank, played, W-D-L, goal difference, points) with both teams in the current match highlighted
- **Match events** — goals ⚽, yellow 🟨 / red 🟥 cards, substitutions 🔁, with minute and player
- **Goal alert** — a terminal bell and flashing banner the moment the score changes while live-tracking
- **Halftime read** — at the break, compares the run of play (xG-proxy, shots, possession, corners) against the score and the live market price, and surfaces betting *considerations* with reasoning and a confidence tag. Heuristic, not a tip service — clearly labeled as such.

## Live odds (optional)

By default the odds section shows ESPN's pre-match opening line. To get **live in-play odds with FanDuel and cross-book line shopping**, add a free [The Odds API](https://the-odds-api.com/) key one of two ways:

```sh
# either an env var
export ODDS_API_KEY=your_key_here

# or a gitignored config file next to the script
echo '{ "oddsApiKey": "your_key_here" }' > odds.config.json
```

With a key set, live matches show FanDuel's moneyline (with vig-stripped implied probabilities) plus the best available price across all US books for each outcome — a `▲` marks where a book beats FanDuel. Odds are cached and refetched at most once every 2 minutes to stay within the free tier's 500-request quota.

Your key is never committed: `odds.config.json` and `.env` are in `.gitignore`.

## Data source

ESPN's public scoreboard and summary endpoints for `soccer/fifa.world` (scores, stats, standings, events) — unofficial, unauthenticated, rate-limit friendly at the default 30s refresh. Live odds come from The Odds API when a key is provided.
