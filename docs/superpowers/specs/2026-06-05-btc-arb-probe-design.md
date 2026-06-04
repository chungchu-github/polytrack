# BTC short-term prediction market — mispricing probe (design)

- **Date:** 2026-06-05
- **Status:** approved (brainstorm) → writing-plans
- **Author:** operator + Claude
- **Scope:** Phase 1 (read-only snapshot probe). Phase 2 (sampler) is conditional on Phase 1 results and only sketched here.

## Context & goal

`antidegen` (fade-the-DEGEN) has no proven edge and can't be validated quickly —
its signals are ~79% long-horizon (WC/politics futures) that won't settle for
months. We're exploring a pivot to **short-term BTC prediction markets**, whose
appeal is **fast settlement = fast feedback**.

The operator's goal (explicitly chosen) is **validation, not building**: find out
whether an *exploitable* mispricing/edge actually exists in these markets before
investing any effort or money. This doc specifies a **read-only measurement
probe** to answer that question cheaply.

The one edge a *slow* (≈70s REST-polling) bot can plausibly hold is
**relative-value / consistency** mispricing across the *family* of related BTC
contracts — not latency arb (owned by pro market-makers) and not directional
prediction. The probe measures whether such mispricing exists, depth- and
fee-adjusted so we don't fool ourselves with untradeable touch-price gaps.

## Non-goals

- **No trading, no orders, no money.** Read-only. Never touches the bot's trade path.
- **Not a strategy implementation.** This is measurement only. A trading strategy is a
  separate future decision, gated on the probe's findings.
- **No new infrastructure** (no WS feeds, no fast execution). Reuses existing REST fetchers.
- **Phase 2 (persistence sampler) is out of scope** until Phase 1 shows promising gaps.

## Phase 1 — snapshot probe (`scripts/probe-btc-arb.mjs`)

Read-only Node ESM script, run manually on the VPS a handful of times over a day.
Pulls current BTC markets + orderbooks from gamma/CLOB and reports mispricing,
depth- and fee-adjusted.

### Market discovery

- Fetch active markets from gamma; keep those whose title matches `/bitcoin|btc/i`.
- Reuse existing `fetchMarkets` / `fetchMarketsByConditionIds` and `fetchOrderBook`
  from `src/polymarket-api.js`. No new fetch infra.

### Family grouping (for the consistency checks)

- Parse each market title into `{ kind, targetUsd, dateMs }` via regex, where `kind ∈
  {threshold, bucket, direction, unknown}`:
  - **threshold**: "Will Bitcoin reach $150,000 by Dec 31?" / "BTC above $100k on Jul 31?"
  - **bucket**: multi-outcome neg-risk "what price will BTC hit in <month>" group.
  - **direction**: "Bitcoin Up or Down — <time>" (no threshold family; binary-only).
- Group `threshold` markets into families by **same target → calendar set** and
  **same date → threshold set**.
- **Unparseable titles are reported as `unparsed`, never silently dropped.** The
  binary/bucket riskless checks (A/B) run on *all* markets and need no parsing;
  only the consistency checks (C/D) use the parsed families, so parse failures
  degrade gracefully (we still get A/B everywhere).

### The four checks

All gaps are **depth- and fee-adjusted** (see next section) before they count.

| # | Name | Definition | Class |
|---|------|------------|-------|
| A | Binary riskless | single market `YES_ask + NO_ask < $1 − fee` → buy both, lock $1 | **strict riskless** |
| B | Bucket riskless | neg-risk group: `Σ(all outcome asks) < $1 − fee` → buy all, lock $1 | **strict riskless** |
| C | Calendar consistency | same target: `P(by T_early) > P(by T_late)` (must be ≤) | **consistency signal** |
| D | Threshold consistency | same date: `P(> $low) < P(> $high)` (must be ≥) | **consistency signal** |

**Honesty note baked into the output:** A/B are strict riskless locks. **C/D are
relative-value *signals*** — whether a violation is a clean riskless lock depends
on contract semantics ("touch-by-date" vs "at-date" resolution). The probe
reports the violation magnitude and **flags C/D for manual semantic confirmation**;
it does not claim them as guaranteed arbitrage.

### Depth & fee realism (the anti-mirage)

- For every candidate gap, **walk the orderbook asks** and compute the **executable
  USD** for which the gap stays positive — not the touch price.
- Report **executable profit (USD)** at realistic size (cap the walk at e.g. $100).
- **Fee** is a parameter, **default 0** (Polymarket's current trading-fee schedule is
  unverified at spec time; flagged as to-confirm, adjustable via `--fee=`).
- A candidate only counts as a "gap" when **depth-adjusted profit > 0 at meaningful size**.

### Output & the Phase-1 → Phase-2 gate

- A table per detected gap: `type (A/B/C/D)`, markets involved, raw gap,
  executable USD, executable profit, verdict — plus a summary (counts + total
  executable riskless profit now; counts + magnitude of C/D violations) and an
  `unparsed` count.
- **Decision gate (thresholds adjustable):**
  - **Promising → graduate to Phase 2** if: any A/B gap with depth-adjusted profit
    **≥ $20**, OR any C/D violation **≥ 3¢** with real depth.
  - **No snapshot edge → stop** if checks are empty or sub-fee/sub-depth.

## Architecture & isolation

- **Standalone script.** Reuses `src/polymarket-api.js` fetchers only. Imports nothing
  from the trade path (`trading.js` execute/sign, server scan loop). No config writes,
  no DB writes (Phase 1).
- Mirrors the `replay-order.mjs` pattern: pure helpers + a thin I/O `main()`; never
  mutates anything.

## Components (testable units)

Pure functions (unit-tested), plus thin I/O wrappers:

- `parseBtcMarket(market) → { kind, targetUsd, dateMs }` — regex title parse. *pure*
- `groupFamilies(parsed[]) → { calendar: [...], threshold: [...] }` — family builder. *pure*
- `executableDepth(asks, limitPrice, capUsd) → usdFillable` — orderbook walk. *pure*
- `checkBinaryArb(yesBook, noBook, fee) → { gap, executableUsd, profitUsd }` *pure*
- `checkBucketArb(books[], fee) → { gap, executableUsd, profitUsd }` *pure*
- `checkCalendarMonotonicity(calendarFamily) → violations[]` *pure*
- `checkThresholdMonotonicity(thresholdFamily) → violations[]` *pure*
- `discoverBtcMarkets()` — fetch + filter. *I/O*
- `main()` — orchestrate, render table, print verdict + gate. *I/O*

## Error handling

- gamma/CLOB fetch failure on a market → skip that market, continue (no crash).
- Missing/empty orderbook → excluded from depth checks, counted in a `no_book` tally.
- Unparseable title → `unparsed` tally; still included in A/B checks.
- Malformed numbers (NaN prices) → treated as missing, never as 0.

## Testing strategy

- **TDD the pure helpers** with synthetic markets/orderbooks: title parsing (incl.
  the messy real formats + `unknown` fallback), monotonicity detection (incl. the
  boundary where equal = no violation), `executableDepth` (multi-level walk, partial
  fill at the level where the gap closes), fee-adjusted profit.
- **Live I/O verified by running on the VPS** (gamma/CLOB reachable there), same as
  `replay-order.mjs` — local run can't reach the APIs / has no relevant data.

## Phase 2 — persistence sampler (CONDITIONAL, sketch only)

Only if Phase 1 shows promising gaps. Run the snapshot on a cron every N minutes
for 3–7 days, logging each gap to a new table (e.g. `btc_arb_observations`), then
summarize **frequency, size distribution, and persistence** (how long a gap
survives before it's arbed). This answers "is it recurring and durable enough to
capture," which a single snapshot can't. Full design deferred until Phase 1 data exists.

## Success criteria

- **Phase 1 succeeds as a *measurement*** if it cleanly reports, for current BTC
  markets, the depth/fee-adjusted A/B/C/D gaps (or their absence) without crashing.
- **The strategy direction is validated** only if Phase 1 (then Phase 2) shows
  mispricing that is **large enough, frequent enough, and deep enough** to clear the
  gate above. Otherwise the honest outcome is "no capturable edge — don't build,"
  which is itself a successful (cheap) result.
