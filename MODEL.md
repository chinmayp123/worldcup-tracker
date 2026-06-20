# Prediction model

How every number in the tracker is produced. This is a transparent statistical model
(Poisson + weighted heuristics), **not** machine learning or a Dixon–Coles fit. Keep this
doc in sync when the model logic in `lib.mjs` changes.

> ⚠ Everything here is a **model estimate**, not betting advice. Odds are −EV on average.

## Data sources

| Source | Used for | Notes |
|--------|----------|-------|
| **ESPN** (`site.api.espn.com`, no key) | live score/clock, box-score stats (shots, possession, corners, cards), keeper stats, standings, key events, inline pre-match odds | always available |
| **FotMob** (`fotmob.mjs`, scraped from page `__NEXT_DATA__`) | real shot-level **xG**, xGOT, big chances, shots/SoT, momentum, **top players**, **team form**, **Round 1 team rates** | unofficial; best-effort, falls back silently |
| **Action Network** (`actionnetwork.mjs`, public API) | **FanDuel odds** (book 69), public betting **tickets %/money %** on ML/spread/total | unofficial; free |
| The Odds API (`odds.config.json`) | multi-book odds + scorer/SoT props | **quota-blocked** currently; FanDuel now comes from Action Network instead |

## Core: expected goals → scoreline → win %

Everything flows from estimating each team's **expected goals λ**, then modelling goals as
two independent **Poisson** distributions (`scorePrediction()` in `lib.mjs`).

`FT = 95` min · neutral prior `AVG_TEAM = 1.35` goals/team.

### Pregame (state `pre`) — "market + R1 form"
1. **Market base**: from the over/under total line `T` (default 2.7) and de-vigged win
   probabilities, split the total by the favourite's edge:
   - supremacy `sup = 2.2 × (P(home) − P(away))`
   - `λ_home = (T + sup)/2`, `λ_away = (T − sup)/2`
2. **Blend in Round 1 xG form** (FotMob), 55% market / 45% form (one game is noisy):
   - `λ = 0.55 × λ_market + 0.45 × xgPrior`
   - `xgPrior_home = mean(home xG-for, away xG-against)` (and mirror for away)

### Live (state `in`) — "run of play"
- Trust the observed rate more as the match wears on: weight `w = min(1, elapsed/70)`.
- `λ_remaining = w × (cumulativeXG / elapsed × minutesLeft) + (1−w) × (AVG_TEAM × minutesLeft/90)`
- `cumulativeXG` = **real FotMob xG** when available, else the shot proxy
  `xg = shotsOnTarget×0.33 + otherShots×0.04`.

### From λ to outputs
- **Win/draw/away %**: sum Poisson(λ_home) × Poisson(λ_away) over scorelines 0–10 each
  (`outcomeProbs()`), bucketed into home-win / draw / away-win.
- **Predicted scoreline**: `round(λ_home) – round(λ_away)`.
- **Over 2.5**: `1 − PoissonCDF(2, λ_home + λ_away)`.
- **BTTS**: `(1 − e^−λ_home)(1 − e^−λ_away)`.

## Pregame projections (`pregameProjections()`)

From each team's **Round 1 rates** (FotMob `fotmobTeamRates`: for/against xG, corners, shots,
shots-on-target from their most recent finished match). Only one game is played, so every
rate is **regularized halfway toward a tournament prior**: `shrink(v, prior) = (v + prior)/2`.

Priors: corners 5, shots 12, SoT 4, xG 1.3 (per team).

- **Shots / SoT (per side)** = `mean(own attacking rate, opponent conceding rate)` after shrink.
- **Corners**: `home = mean(home corners-for, away corners-against)`, total → O/U 9.5 via Poisson.
- **Keeper saves**: `saves = max(0, expected SoT faced − expected goals conceded)`, O/U 2.5 via Poisson.

These have **no real market** anywhere free, so they are model-only and noisy until more
rounds accrue.

## Recommended bets (`bettingModel()`)

A **dominance index** = weighted share of who's controlling play:

| Signal | Weight |
|--------|--------|
| xG (real FotMob, else proxy) | 40% |
| shots on target | 25% |
| total shots | 15% |
| possession | 10% |
| corners | 10% |

Leans are flagged where dominance diverges from the scoreline / market price (e.g. a team
controlling ≥60% but not yet ahead). Plus:
- **Model-vs-market gap**: when model win% − de-vigged market% ≥ 8 percentage points.
- **Fade public**: Action Network — when the most-bet side's tickets% exceeds its money% by
  ≥ 8 points (public heavy, sharper money lighter), lean the side money favours.

## Odds display priority
1. The Odds API live multi-book (if key + quota) → 2. **FanDuel via Action Network** (book 69,
de-vigged) → 3. ESPN inline pre-match line. The picker's predicted scorelines fall back to
ESPN's inline odds when The Odds API is unavailable.

## Key files
- `lib.mjs` — model + view layer: `scorePrediction`, `bettingModel`, `pregameProjections`,
  `outcomeProbs`, `cornersModel`, `keeperSaveLine`, `buildMatchView`, `getWidgetState`.
- `fotmob.mjs` — xG / momentum / form / `fotmobTeamRates`.
- `actionnetwork.mjs` — FanDuel odds + public-betting splits.
- `widget/renderer.js` — renders the cards from the plain view object.

## Honest limitations
- Poisson assumes goals are independent and ignores red cards, game state, fatigue, fixtures.
- The **market does most of the pregame work**; the model's edge is the xG/form tilt + public signal.
- Round 1 = one game of data → corners/saves/form are rough early.
- Scraped sources (FotMob, Action Network) can break if those sites restructure.
