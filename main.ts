// Dual-EMA momentum bot for the make.fun bars-replay/v1 harness
// (competition u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1).
//
// Strategy — trend following with whipsaw protection, long only, no leverage:
//   - Per symbol, EMA(7) vs EMA(21) on hourly closes. Each EMA is seeded with
//     the mean of its first span of closes, then moves 2 / (span + 1) of the
//     way to each new close (float64, deterministic: same bars, same orders).
//   - Enter: the fast EMA sits above the slow EMA for 2 consecutive closes
//     (a single-bar cross is not enough — hourly crypto whipsaws too much),
//     the market is not dead (12-bar mean true range >= 5 bps of price),
//     and the symbol is not already held. Fills at the next bar's open.
//   - Exit the whole position when any of these holds at a close:
//       * the fast EMA sits below the slow EMA for 2 consecutive closes
//         (confirmed trend reversal), or
//       * the position is worth 8% under its cost (stop-loss), or
//       * the position is worth 50% over its cost (take-profit).
//     An exit signal that the market refuses is re-sent on the next bar
//     while its reason still holds.
//   - Sizing: equity split evenly over the universe (7 symbols), each buy
//     capped at the harness max weight (25% of equity) and at the cash the
//     reply has not spent yet; below the minimum notional it buys nothing.
//     Sells go first in a reply; their proceeds never fund the same reply's
//     buys. At most caps.max_orders_per_bar orders per reply.
//   - Bars with zero volume (v == '0') signal nothing; bars with no volume
//     recorded (v null) are not held back. No orders while warming up.
//   - Slippage is capped at 100 bps past the close the order was decided on,
//     so a fill into a liquidity gap is refused (and retried) rather than
//     filled for almost nothing.
//
// Why this shape: on the dev window (a broad downtrend, buy-and-hold about
// -$858) this bot stays mostly in USDC, rides the brief up-moves, and loses
// only the small cost of false entries; on a rising window it rides the
// trend instead of sitting out. No network, no outside data, no clock, no
// randomness: the two graded runs must match byte for byte.

import { BPS, runBars, type Bar, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const FAST_BARS = 7;
const SLOW_BARS = 21;
/** Confirm a cross with this many consecutive closes on the new side. */
const CONFIRM_BARS = 2;
/** Dead-market filter: 12-bar mean (high - low) / close, in bps. */
const ATR_BARS = 12;
const MIN_ATR_BPS = 5;
/** Stop-loss: exit when the position is worth 92% of its cost. */
const STOP_NUM = 92n;
const STOP_DEN = 100n;
/** Take-profit: exit when the position is worth 150% of its cost. */
const TP_NUM = 150n;
const TP_DEN = 100n;
/** Max slippage past the decision close, in bps. Tightened from 100 to 80
    after the first local grade: the dev window showed one fill refused at
    100 bps that would have been worse, so a stricter cap keeps fills closer
    to the price the signal was decided on. */
const MAX_SLIPPAGE_BPS = 80;

/** One EMA: the closes seen until it starts, then its value. */
interface Ema {
  span: number;
  warm: number[];
  value: number | null;
}

interface Series {
  fast: Ema;
  slow: Ema;
  /** (fast - slow) / close in bps, one entry per bar, newest last. */
  gaps: number[];
  /** Mean (high - low) / close over the last ATR_BARS bars, in bps. */
  ranges: number[];
}

const series = new Map<string, Series>();

function step(e: Ema, close: number): void {
  if (e.value !== null) {
    e.value += (2 / (e.span + 1)) * (close - e.value);
    return;
  }
  e.warm.push(close);
  if (e.warm.length === e.span) e.value = e.warm.reduce((a, x) => a + x, 0) / e.span;
}

function push(bar: Bar): Series {
  let s = series.get(bar.symbol);
  if (s === undefined) {
    s = {
      fast: { span: FAST_BARS, warm: [], value: null },
      slow: { span: SLOW_BARS, warm: [], value: null },
      gaps: [],
      ranges: [],
    };
    series.set(bar.symbol, s);
  }
  const c = Number(bar.c);
  step(s.fast, c);
  step(s.slow, c);
  if (s.fast.value !== null && s.slow.value !== null && c > 0) {
    s.gaps.push(((s.fast.value - s.slow.value) / c) * 10000);
  }
  const h = Number(bar.h);
  const l = Number(bar.l);
  if (c > 0 && h >= l) {
    s.ranges.push(((h - l) / c) * 10000);
    if (s.ranges.length > ATR_BARS) s.ranges.shift();
  }
  return s;
}

/** True when the last `n` recorded gaps are all strictly positive (up) or all strictly negative (down). */
function confirmed(gaps: number[], n: number, up: boolean): boolean {
  if (gaps.length < n) return false;
  for (let i = gaps.length - n; i < gaps.length; i++) {
    if (up ? gaps[i]! <= 0 : gaps[i]! >= 0) return false;
  }
  return true;
}

function atrBps(s: Series): number {
  if (s.ranges.length === 0) return 0;
  return s.ranges.reduce((a, x) => a + x, 0) / s.ranges.length;
}

/** Whether a held position exits on this close: confirmed reversal, stop-loss, or take-profit. */
function exits(state: BarsState, symbol: string, held: { qty: bigint; cost: bigint }, s: Series): boolean {
  if (confirmed(s.gaps, CONFIRM_BARS, false)) return true;
  const value = state.value(symbol, held.qty);
  return value * STOP_DEN <= held.cost * STOP_NUM || value * TP_DEN >= held.cost * TP_NUM;
}

await runBars({
  onBatch(state, batch) {
    const fresh = new Set<string>();
    for (const bar of batch.bars) {
      if (bar.v === '0') continue;
      push(bar);
      fresh.add(bar.symbol);
    }
    if (state.warmingUp) return [];
    const { caps, fees } = state.hello;
    const sells: SellInput[] = [];
    const entries: string[] = [];
    for (const { symbol } of state.hello.symbols) {
      if (!fresh.has(symbol)) continue;
      const s = series.get(symbol)!;
      const held = state.positions.get(symbol);
      if (held !== undefined) {
        if (exits(state, symbol, held, s)) {
          sells.push({ side: 'sell', symbol, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS });
        }
      } else if (confirmed(s.gaps, CONFIRM_BARS, true) && atrBps(s) >= MIN_ATR_BPS) {
        entries.push(symbol);
      }
    }

    const orders: (SellInput | BuyInput)[] = sells.slice(0, caps.max_orders_per_bar);
    const slots = Math.min(state.hello.symbols.length, caps.max_open_positions);
    const stake = state.equity / BigInt(slots);
    const byWeight = (BigInt(caps.max_weight_bps) * state.equity) / BPS;
    let room = slots - state.positions.size;
    let cash = state.cash;
    for (const symbol of entries) {
      if (room <= 0 || orders.length >= caps.max_orders_per_bar) break;
      let slice = stake < byWeight ? stake : byWeight;
      if (cash < slice) slice = cash;
      if (slice === 0n || slice < BigInt(fees.min_notional_quote_units)) break;
      orders.push({ side: 'buy', symbol, notional_quote_units: slice, max_slippage_bps: MAX_SLIPPAGE_BPS });
      cash -= slice;
      room--;
    }
    return orders;
  },
});
