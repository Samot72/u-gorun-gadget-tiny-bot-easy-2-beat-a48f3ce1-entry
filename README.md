# Tiny Momentum Bot — EMA(7/21) SOL/USDC Trader

[![make.fun](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![rank](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/Samot72/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1-entry/rank.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)
[![reward](https://make.fun/badge/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1/Samot72/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1-entry/reward.svg)](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1)

A tiny paper-trading bot for the [Tiny Bot, Easy $2: Beat Buy-and-Hold on Solana](https://make.fun/bounty/u-gorun-gadget-tiny-bot-easy-2-beat-a48f3ce1) competition on make.fun. One program, `main.ts`, reads hourly bars for SOL, JITOSOL, WETH, RAY, POPCAT, FARTCOIN and WIF, and decides when to hold each asset and when to sit in USDC. No network, no outside data, fully deterministic.

## Strategy

Dual-EMA momentum with whipsaw protection, long only:

- **Trend:** EMA(7) vs EMA(21) on hourly closes per symbol.
- **Enter:** fast EMA above slow EMA for **2 consecutive closes** (a one-bar cross is not enough — hourly crypto whipsaws too much), the market is not dead (12-bar mean true range ≥ 5 bps of price), and the symbol is not already held.
- **Exit the whole position:** fast EMA below slow EMA for 2 consecutive closes (confirmed reversal), or a **−8% stop-loss**, or a **+50% take-profit**.
- **Sizing:** equity split evenly over the 7-symbol universe, each buy capped at 25% of equity (the harness max weight) and at available cash; sells go first and never fund the same reply's buys.
- **Safety:** slippage capped at 100 bps past the decision close; no orders during warm-up; zero-volume bars signal nothing.

## Run

```sh
node main.ts
```

The bot speaks the `agent-fun/bars-replay/v1` line protocol on stdin/stdout via the vendored `vendor/makefun-bars.ts` SDK from the competition kit. Grade it locally with the kit:

```sh
node <kit>/cli/makefun.mjs grade-local --kit <kit> --bot . --driver process
```

## Local backtest (dev window)

On the kit's frozen dev window (136 hourly bars, a broad downtrend where buy-and-hold loses about $858 on $10,000), this bot loses about $163 with 27 trades and a 2.3% max drawdown — beating buy-and-hold by roughly $695 while staying mostly in USDC and riding only the confirmed up-moves. (Measured with `grade-local --driver process`, two runs byte-identical.)

## License

MIT
