// Clean Scalper — a cautious paper bot for the pump.fun Sharpe Sprint.
//
// Idea: only buy fresh launches that look organic (a crowd of at least five distinct
// early buyers, a small creator buy, the creator has not sold, no big single dump yet,
// and the price has not already run away more than +30% from its create price), stake
// a small fixed amount (0.02 SOL), and leave fast: a +15% take-profit, a -8% stop, a
// short trailing stop once in profit, and a hard 300-slot time limit. No pyramids, no
// chasing run-ups, no holding through a creator sell. The goal is a steady stream of
// small, controlled round trips across many coins, because the score is hourly Sharpe,
// not one moonshot.
//
// Why these filters (measured on the kit's dev window, 1,222 coins): the opening spike
// happens in the first few slots and is mostly gone by the time a 2-slot-latency fill
// lands, so entries must be early (age <= 4 slots) and must not chase (run-up cap).
// Coins with >= 5 distinct early buyers reach +10% after entry far more often than
// the average launch. Costs per round trip at 0.02 SOL: curve fees ~1.25% each way
// plus a fixed 105,000-lamport tx fee each way, so a trip needs roughly +3.5% of price
// move to break even — that is why the exits are tight and the entries are filtered
// hard. Exits are measured on PRICE return vs the entry price: value-based exits were
// asymmetric (a -7% value stop is only ~-4% of price once fees and sell impact are
// counted, while +10% of value needs ~+13% of price) and kept stopping positions out
// on ordinary early volatility.
//
// Guardrail pacing: the organic filter is selective (~8 coins per 6 hours), so when
// fills or distinct coins lag a 22-coin / 44-fill pace over the 6-hour window, the bot
// opens minimal 0.01 SOL probe round trips on liquid coins. A probe waits for a small
// favourable move (+6% of price, which covers the round-trip fees), cuts at -6%, or
// times out after 120 slots — selling the instant it lands would lock in the full fee
// drag (~0.0005 SOL) every time. Probes are pure guardrail insurance and only fire
// while the bot is behind pace.
//
// Deterministic by construction: no clock, no Math.random, no I/O; iteration only over
// insertion-ordered maps fed by the batch stream.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Lamports staked per coin (one buy, no adds). */
  stakeLamports: number;
  /** Real SOL reserve window at decision time (lamports). */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot: at most this (lamports). */
  maxDevBuy: number;
  /** Distinct non-creator buyers seen before entry, at least. */
  minBuyers: number;
  /** Distinct non-creator buyers before entry, at most (bundled launches dump). */
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve, at most. */
  maxBigSellBps: number;
  /** Price now over the create price, as bps: at most (do not chase a run-up). */
  maxRunupBps: number;
  /** Skip the coin entirely once the creator sells any amount. */
  skipDevSold: boolean;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Take profit, as bps of cost value. */
  tpBps: number;
  /** Stop loss, as bps of cost value. */
  slBps: number;
  /** Trailing stop arms once value reaches cost * (1 + trailArmBps). */
  trailArmBps: number;
  /** Trailing stop: exit once value falls this far (bps) below its peak. */
  trailBps: number;
  /** Hard exit after this many slots held. */
  maxHold: number;
  /** Exit at once when the creator sells. */
  exitOnDevSell: boolean;
  /** Total SOL bought by others in the opening tape, at least (lamports; 0 = off). */
  minEarlyBoughtLamports: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldown: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
  /** Guardrail pacing: target this many distinct coins by the end of the window. */
  targetCoins: number;
  /** Guardrail pacing: target this many fills by the end of the window. */
  targetFills: number;
  /** Seconds of block time the pace is measured over. */
  paceSecs: number;
  /** Probe buy size (lamports) used only to stay on guardrail pace. */
  probeLamports: number;
  /** Most probe positions open at once. */
  maxProbes: number;
  /** Probe take-profit, as bps of price vs its buy decision price. */
  probeTpBps: number;
  /** Probe stop-loss, as bps of price vs its buy decision price. */
  probeSlBps: number;
  /** Probe hard exit after this many slots held. */
  probeMaxHold: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 4,
  stakeLamports: 20_000_000,
  minRealSol: 500_000_000,
  maxRealSol: 30_000_000_000,
  maxDevBuy: 2_500_000_000,
  minBuyers: 5,
  maxBuyers: 100,
  maxSellRatioBps: 2_000,
  maxBigSellBps: 10_000,
  maxRunupBps: 3_000,
  skipDevSold: true,
  buySlippageBps: 10_000,
  tpBps: 1_500,
  slBps: 800,
  trailArmBps: 500,
  trailBps: 400,
  maxHold: 300,
  exitOnDevSell: true,
  minEarlyBoughtLamports: 0,
  cooldown: 150,
  maxEntries: 1,
  targetCoins: 22,
  targetFills: 44,
  paceSecs: 21_600,
  probeLamports: 10_000_000,
  maxProbes: 1,
  probeTpBps: 600,
  probeSlBps: 600,
  probeMaxHold: 120,
};

const LAMPORTS = 1e9;
const BPS = 10_000;

interface Coin {
  createSlot: number;
  creator: Pubkey;
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  devSold: boolean;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: number;
  lastTradeSlot: number;
}

interface Held {
  opened: number;
  exiting: boolean;
  filled: boolean;
  /** Price (vq/vt) at the buy decision; exits are measured on price return vs this. */
  entryPrice: number;
  /** Best price return (price / entryPrice - 1) seen so far. */
  peakReturn: number;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: decision price and slot of the probe buy. */
  const probes = new Map<Pubkey, { entryPrice: number; opened: number }>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const coinOf = (mint: Pubkey, slot: number): Coin => {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        createSlot: slot,
        creator: '',
        vq0: 0n,
        vt0: 0n,
        devBuy: 0n,
        devSold: false,
        buyers: new Set(),
        bought: 0n,
        soldByOthers: 0n,
        bigSellBps: 0,
        lastTradeSlot: slot,
      };
      coins.set(mint, c);
    }
    return c;
  };

  /** Entry filter on a young coin's opening tape. */
  const entryOk = (c: Coin, now: number, rqSol: number, price: number): boolean => {
    const age = now - c.createSlot;
    if (age < p.minAge || age > p.maxAge) return false;
    if (rqSol < p.minRealSol || rqSol > p.maxRealSol) return false;
    if (c.devBuy > BigInt(p.maxDevBuy)) return false;
    if (p.skipDevSold && c.devSold) return false;
    if (c.buyers.size < p.minBuyers || c.buyers.size > p.maxBuyers) return false;
    if (c.bought > 0n && c.soldByOthers * BigInt(BPS) > c.bought * BigInt(p.maxSellRatioBps)) return false;
    if (c.bigSellBps > p.maxBigSellBps) return false;
    if (c.bought < BigInt(p.minEarlyBoughtLamports)) return false;
    if (c.vq0 > 0n && c.vt0 > 0n) {
      const createPrice = Number(c.vq0) / Number(c.vt0);
      if (createPrice > 0 && (price / createPrice - 1) * BPS > p.maxRunupBps) return false;
    }
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const devSoldNow = new Set<Pubkey>();
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          const c = coinOf(e.mint, e.slot);
          c.createSlot = e.slot;
          c.creator = e.creator;
          c.vq0 = BigInt(e.virtual_quote_reserves);
          c.vt0 = BigInt(e.virtual_token_reserves);
        } else if (e.event === 'TradeEvent') {
          const c = coinOf(e.mint, e.slot);
          const sol = BigInt(e.sol_amount);
          c.lastTradeSlot = e.slot;
          traded.add(e.mint);
          if (e.is_buy) {
            c.bought += sol;
            if (e.user === c.creator) {
              if (e.slot === c.createSlot) c.devBuy += sol;
            } else {
              c.buyers.add(e.user);
            }
          } else {
            if (e.user === c.creator) {
              c.devSold = true;
              devSoldNow.add(e.mint);
            } else {
              c.soldByOthers += sol;
              const rq = Number(e.real_quote_reserves);
              if (rq > 0) {
                const bps = Math.floor((Number(sol) / rq) * BPS);
                if (bps > c.bigSellBps) c.bigSellBps = bps;
              }
            }
          }
        } else {
          // CompleteEvent: positions are force-closed by the harness.
          coins.delete(e.mint);
        }
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = Number(state.txFeeLamports()) / LAMPORTS;
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));

      // Exits first. Measured on PRICE return vs the entry decision price: the old
      // value-based exits were asymmetric (a -7% value stop is only ~-4% of price once
      // fees and sell impact are counted, while +10% of value needs ~+13% of price),
      // so ordinary early volatility kept stopping positions out before they could run.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) held.delete(mint);
          continue;
        }
        h.filled = true;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        if (vt <= 0 || h.entryPrice <= 0) continue;
        const price = vq / vt;
        const ret = price / h.entryPrice - 1;
        if (ret > h.peakReturn) h.peakReturn = ret;
        let exit = h.exiting;
        if (!exit && ret >= p.tpBps / BPS) exit = true;
        if (!exit && ret <= -(p.slBps / BPS)) exit = true;
        if (!exit && h.peakReturn >= p.trailArmBps / BPS && ret <= h.peakReturn - p.trailBps / BPS) exit = true;
        if (!exit && p.exitOnDevSell && devSoldNow.has(mint)) exit = true;
        if (!exit && now - h.opened > p.maxHold) exit = true;
        if (!exit) continue;
        h.exiting = true;
        let sellPending = false;
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
        if (sellPending) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: a probe is guardrail insurance, but selling it the instant
      // it lands locks in the full fee drag (~0.0005 SOL) every time. Instead it waits
      // for a small favourable move (+6% of price covers the round-trip fees), cuts at
      // -6%, or times out after probeMaxHold slots — whichever comes first.
      for (const [mint, pr] of probes) {
        const pos = state.positions.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (pendingByMint.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? Number(mk.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
        const vt = mk ? Number(mk.virtual_token_reserves) : Number(curve.virtual_token_reserves);
        if (vt <= 0 || pr.entryPrice <= 0) continue;
        const ret = vq / vt / pr.entryPrice - 1;
        if (ret < p.probeTpBps / BPS && ret > -(p.probeSlBps / BPS) && now - pr.opened <= p.probeMaxHold) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Entries.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      for (const mint of traded) {
        if (orders.length >= cap) break;
        if (slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
        const c = coins.get(mint);
        if (c === undefined) continue;
        if (c.lastTradeSlot < now - 1) continue; // only coins trading right now
        const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves);
        if (!entryOk(c, now, rqSol, price)) continue;
        const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
        let amount = Math.min(capSol, p.stakeLamports / LAMPORTS);
        if (amount > free - tx) amount = free - tx;
        if (amount < 0.01) continue; // guardrail: round trip must be >= 0.01 SOL
        orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        held.set(mint, { opened: now, exiting: false, filled: false, entryPrice: price, peakReturn: 0 });
        slotsLeft--;
      }

      // Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeLamports * BPS) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) < minRq * 1.5) continue;
            if (free < p.probeLamports / LAMPORTS + 2 * tx) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(p.probeLamports), max_slippage_bps: p.buySlippageBps });
            probes.set(mint, { entryPrice: Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves), opened: now });
            free -= p.probeLamports / LAMPORTS + tx;
          }
        }
      }
      return orders;
    },
  };
}
