# Clean Scalper — Pump.fun Sharpe Sprint

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/mitsukikun/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/mitsukikun/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A cautious paper-trading bot for the **Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins**
competition (`agent-fun/replay/v2`, 10 SOL paper capital, 6-hour replay window). The
score is hourly Sharpe ratio, so this bot trades for steady, controlled gains — never
for one moonshot.

## Strategy

**Clean Scalper** buys only fresh launches that look organic, stakes a small fixed
amount, and leaves fast:

- **Entry (age ≤ 4 slots):** at least 5 distinct non-creator buyers in the opening
  tape, creator buy ≤ 2.5 SOL, creator has not sold, no single big dump yet, sells by
  others ≤ 20% of buys, real SOL reserve 0.5–30 SOL, and the price has not already
  run away more than +30% from its create price (no chasing — the opening spike is
  mostly gone by the time a 2-slot-latency fill lands).
- **Stake:** 0.02 SOL per coin, one buy, no adds, no pyramids.
- **Exits (measured on price return vs the entry price):** take-profit +15%,
  stop-loss −8%, trailing stop (−4% from the peak once +5% up), exit at once if the
  creator sells, hard exit after 300 slots held.
- **Guardrail pacing:** the organic filter is selective (~8 coins per 6 hours), so
  when fills or distinct coins lag a 22-coin / 44-fill pace over the window, the bot
  opens minimal 0.01 SOL probe round trips on liquid coins. A probe waits for +6% of
  price (which covers its round-trip fees), cuts at −6%, or times out after 120
  slots. Probes are pure guardrail insurance and only fire while the bot is behind
  pace.
- **Deterministic:** no clock, no `Math.random`, no network, no I/O. All decisions
  are pure functions of the batch stream, so the two grader executions produce
  identical action logs.

## How to run

```sh
node main.ts
```

Requires Node 22 (type-stripping). `main.ts` is the entrypoint; the strategy lives
in `strategy.ts`; `vendor/makefun-bot.ts` is the kit's replay shim, vendored
unchanged.

## Dev-window simulation (local, offline sim port of the kit's replay engine)

Full 24-hour dev window (1,222 coins), final settings:

| Metric | Value |
|---|---|
| Net PnL | **+0.013088 SOL** |
| Hourly Sharpe (proxy) | **+0.089** |
| Fills / distinct mints | 90 / 44 |
| Round trips (≥ 0.01 SOL) | 45 (17 wins) |
| Max drawdown | 0.20% |
| Rejected orders | 0 |
| Failed txs (seeded 2%) | 3 |

Per 6-hour chunk (the final window is 6 hours): 22–24 distinct mints in every
chunk (guardrail: ≥ 20), net PnL −0.0052 / −0.0166 / +0.0256 / −0.0077 SOL,
max drawdown ≤ 0.21%. Sensitivity: without failed txs +0.0110 SOL; at 2× fees
−0.0158 SOL.

For comparison on the same dev window: the kit's momentum baseline −9.39 SOL,
sniper baseline −0.49 SOL, reversion baseline −4.02 SOL. Earlier builds of this
entry were all negative; this rebuild is the first to come out positive on the dev
window — narrowly, and the final window is a different 6 hours, so the result is
not a promise.

## Files

- `main.ts` — entrypoint (`node main.ts`)
- `strategy.ts` — the Clean Scalper strategy
- `vendor/makefun-bot.ts` — kit replay shim (vendored)
- `LICENSE` — MIT

## License

MIT — see `LICENSE`.
