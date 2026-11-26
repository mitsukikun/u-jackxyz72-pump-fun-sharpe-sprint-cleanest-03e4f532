// Clean Scalper — paper bot for the Pump.fun Sharpe Sprint (agent-fun/replay/v2).
//
// Buys only fresh, organic-looking launches with a small fixed stake and exits fast
// (small take-profit, tight stop, short trailing stop, hard time limit). See strategy.ts
// for the full reasoning. Runs as `node main.ts` on Node 22 (type-stripping).

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
