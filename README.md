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
node worldcup.mjs list         # show today's matches with scores and status
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
- **Match events** — goals ⚽, yellow 🟨 / red 🟥 cards, substitutions 🔁, with minute and player

## Data source

ESPN's public scoreboard and summary endpoints for `soccer/fifa.world`. Unofficial, unauthenticated, and rate-limit friendly at the default 30s refresh.
