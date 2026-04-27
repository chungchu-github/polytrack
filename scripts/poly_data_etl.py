#!/usr/bin/env python3
"""
poly_data_etl.py — Historical wallet seeder for Polytrack

Downloads poly_data's markets.csv from GitHub, then streams through the
orderFilled archive (XZ-compressed CSV) to find historically strong wallets.
Outputs data/historical_seeds.json with top wallets ranked by composite score
using the same algorithm as Polytrack's scoring.js.

Usage:
    # Step 1 — download the archive (5.8 GB, one-time):
    curl -L -o /tmp/orderFilled_complete.csv.xz \\
        https://polydata-archive.s3.us-east-1.amazonaws.com/orderFilled_complete.csv.xz

    # Step 2 — run the ETL:
    python3 scripts/poly_data_etl.py --data /tmp/orderFilled_complete.csv.xz

    # Step 3 — (optional) delete the raw archive after:
    rm /tmp/orderFilled_complete.csv.xz

Options:
    --data PATH         Path to orderFilled_complete.csv.xz  [required]
    --markets PATH      Path to markets.csv (auto-downloaded if omitted)
    --out PATH          Output JSON path  [default: data/historical_seeds.json]
    --top N             Number of wallets to keep  [default: 300]
    --min-trades N      Minimum total trades  [default: 50]
    --min-closed N      Minimum closed market positions  [default: 20]
    --min-pnl N         Minimum total realized PnL in USDC  [default: 500]
    --min-score N       Minimum composite score 0-100  [default: 60]
    --min-winrate N     Minimum win rate 0-100  [default: 55]
    --keep-raw          Don't delete downloaded markets.csv after run
    --dry-run           Process but don't write output file
"""

import argparse
import csv
import json
import lzma
import math
import os
import pickle
import sys
from collections import defaultdict
from datetime import datetime, timezone

try:
    import requests
    from tqdm import tqdm
except ImportError:
    print("Missing deps. Run: pip3 install tqdm requests")
    sys.exit(1)

# ── Known Polymarket platform/bot wallets to exclude ──────────────────────────
PLATFORM_WALLETS = {
    "0xc5d563a36ae78145c45a50134d48a1215220f80a",
    "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e",
}

GAMMA_API     = "https://gamma-api.polymarket.com/markets"
MARKETS_HEADERS = [
    "createdAt", "id", "question", "answer1", "answer2", "neg_risk",
    "market_slug", "token1", "token2", "condition_id", "volume", "ticker", "closedTime",
]

# ── Markets CSV builder (paginates Polymarket gamma-api) ──────────────────────
#
# poly_data's markets.csv is generated locally — NOT committed to the repo.
# We need TWO passes because gamma-api returns closed and non-closed markets in
# disjoint result sets:
#   - closed=false  → ~50K active markets (default behavior, no filter)
#   - closed=true   → ~700K already-settled markets (oldest IDs ~12, the bulk
#                     of historical trade volume lives here)
# The orderFilled archive references all of them, so we need both buckets to
# avoid the 82% "unknown market" miss rate seen with active-only coverage.

def _write_market_row(writer, m):
    import json as _json
    try:
        outs = m.get("outcomes", "[]")
        outs = _json.loads(outs) if isinstance(outs, str) else outs
        toks = m.get("clobTokenIds", "[]")
        toks = _json.loads(toks) if isinstance(toks, str) else toks
        a1 = outs[0] if len(outs) > 0 else ""
        a2 = outs[1] if len(outs) > 1 else ""
        t1 = toks[0] if len(toks) > 0 else ""
        t2 = toks[1] if len(toks) > 1 else ""
        neg = m.get("negRiskAugmented") or m.get("negRiskOther") or False
        ticker = ""
        evs = m.get("events") or []
        if evs:
            ticker = evs[0].get("ticker", "")
        writer.writerow([
            m.get("createdAt", ""), m.get("id", ""),
            m.get("question", "") or m.get("title", ""),
            a1, a2, neg, m.get("slug", ""), t1, t2,
            m.get("conditionId", ""), m.get("volume", ""),
            ticker, m.get("closedTime", ""),
        ])
        return True
    except (ValueError, KeyError):
        return False


def _fetch_pass(writer, file_handle, seen_ids, closed_filter, batch_size, label,
                max_offset=1_000_000):
    """
    Paginate gamma-api with two quirks accounted for:
      - Short pages happen mid-stream (offset=1000 → 2 markets, offset=2000 → 500).
        We must NOT break on len(markets) < batch_size; only break on empty list
        or on validation-error response.
      - At offset > ~800K the API returns {"type":"validation error",...}
        instead of a list. Detect non-list responses and stop cleanly.
    """
    import time as _time
    offset = 0
    written = 0
    empty_streak = 0
    bar = tqdm(desc=label, unit=" markets")
    consecutive_errors = 0

    while offset < max_offset:
        try:
            # IMPORTANT: do NOT pass `order=createdAt&ascending=true` here.
            # gamma-api with that ordering hits "cannot get the information"
            # at much shallower offsets than without it. Default order works
            # to ~250K offsets; the closed bucket is still ID-deduped so order
            # doesn't matter for correctness.
            params = {
                "limit": batch_size, "offset": offset,
                "closed": "true" if closed_filter else "false",
            }
            resp = requests.get(GAMMA_API, params=params, timeout=30)

            # gamma-api uses HTTP 500 for two distinct things:
            #   - genuine transient errors (no JSON body, or empty body) → retry
            #   - structural API holes ({"error": "cannot get..."}) → skip
            # Also: market titles can contain raw control chars, which strict
            # JSON parsing rejects. Use strict=False so those rows survive.
            import json as _json
            payload = None
            try:
                payload = _json.loads(resp.text, strict=False)
            except Exception:
                payload = None

            if resp.status_code != 200 and payload is None:
                # Truly transient — backoff + retry
                consecutive_errors += 1
                if consecutive_errors > 10:
                    print(f"\nToo many errors in {label} at offset {offset} — giving up.")
                    break
                _time.sleep(min(2 ** consecutive_errors, 30))
                continue
            consecutive_errors = 0

            # gamma-api returns two distinct error envelopes:
            #   1. "offset exceeds maximum allowed..." → real upper bound (~800K),
            #      stop pagination.
            #   2. "cannot get the information" → API "holes" mid-stream
            #      (e.g. 1500..1900 in the closed pass) where the next valid
            #      window is later. SKIP and continue past these.
            if not isinstance(payload, list):
                err = (payload.get("error", "") if isinstance(payload, dict) else "")
                if "exceeds maximum" in err.lower():
                    print(f"\n{label}: reached gamma-api upper bound at offset {offset}")
                    break
                # Mid-stream hole — advance and keep going.
                offset += batch_size
                continue

            markets = payload
            if len(markets) == 0:
                empty_streak += 1
                # One empty page could be a hiccup; two in a row means done.
                if empty_streak >= 2:
                    break
                offset += batch_size
                continue
            empty_streak = 0

            for m in markets:
                if not isinstance(m, dict):
                    continue
                mid = m.get("id")
                if not mid or mid in seen_ids:
                    continue
                if _write_market_row(writer, m):
                    seen_ids.add(mid)
                    written += 1

            # Always advance by the requested page size — short pages are
            # an upstream filter quirk, not end-of-stream. Advancing by
            # len(markets) would re-request overlapping windows endlessly.
            offset += batch_size
            bar.update(len(markets))
            file_handle.flush()

        except requests.exceptions.RequestException as e:
            consecutive_errors += 1
            if consecutive_errors > 10:
                print(f"\nNetwork error in {label}, giving up: {e}")
                break
            _time.sleep(min(2 ** consecutive_errors, 30))

    bar.close()
    return written


def build_markets(dest_path, batch_size=500):
    """
    Always rebuilds markets.csv from scratch — two passes (closed=false + closed=true)
    deduped by market id. Takes ~12-15 minutes for ~750K markets.
    """
    import csv as _csv
    print(f"Building markets.csv (two passes) → {dest_path}")
    seen_ids = set()
    with open(dest_path, "w", newline="", encoding="utf-8") as f:
        w = _csv.writer(f)
        w.writerow(MARKETS_HEADERS)
        n1 = _fetch_pass(w, f, seen_ids, closed_filter=False, batch_size=batch_size,
                         label="active  ")
        n2 = _fetch_pass(w, f, seen_ids, closed_filter=True,  batch_size=batch_size,
                         label="closed  ")
    print(f"  → wrote {n1:,} active + {n2:,} closed = {n1 + n2:,} unique markets")


# ── Markets lookup: token_id → {condition_id, outcome, question} ──────────────

def load_markets(markets_path):
    """Returns dict: token_id (str) → {condition_id, outcome_label, question}"""
    lookup = {}
    with open(markets_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            cid = row.get("condition_id", "").strip()
            q   = row.get("question", "").strip()
            t1  = row.get("token1", "").strip()
            t2  = row.get("token2", "").strip()
            a1  = row.get("answer1", "").strip() or "YES"
            a2  = row.get("answer2", "").strip() or "NO"
            if cid and t1:
                lookup[t1] = {"condition_id": cid, "outcome": a1, "question": q}
            if cid and t2:
                lookup[t2] = {"condition_id": cid, "outcome": a2, "question": q}
    print(f"  Loaded {len(lookup):,} token→market mappings")
    return lookup


# ── Checkpoint persistence ────────────────────────────────────────────────────
#
# Streaming the 86M-row archive takes 1-3 hours. Anything that crashes after
# the stream (scoring bug, OOM during ranking) would otherwise force a re-run
# from scratch. We pickle the accumulated wallet dict immediately after stream
# so re-runs can use --score-only to skip straight to scoring.

def save_checkpoint(wallets, path):
    plain = {addr: dict(markets) for addr, markets in wallets.items()}
    with open(path, "wb") as f:
        pickle.dump(plain, f, protocol=pickle.HIGHEST_PROTOCOL)
    print(f"  Checkpoint: {len(plain):,} wallets → {path} "
          f"({os.path.getsize(path) / 1e6:.1f} MB)")


def load_checkpoint(path):
    print(f"Loading checkpoint {path}…")
    with open(path, "rb") as f:
        wallets = pickle.load(f)
    print(f"  → {len(wallets):,} wallets restored")
    return wallets


# ── Streaming accumulator ─────────────────────────────────────────────────────
#
# Per wallet, per conditionId we track aggregate stats — NOT raw trade lists.
# This keeps memory bounded even across 86M rows.
#
# market_stats shape:
#   total_bought_usdc, total_sold_usdc   — dollar amounts
#   total_bought_qty,  total_sold_qty    — token quantities (for avg price)
#   buy_count, sell_count                — number of individual fills
#   last_ts                              — most recent trade timestamp

def make_market_stats():
    return {
        "total_bought_usdc": 0.0,
        "total_sold_usdc":   0.0,
        "total_bought_qty":  0.0,
        "total_sold_qty":    0.0,
        "buy_count":  0,
        "sell_count": 0,
        "last_ts":    0,
    }


def stream_accumulate(xz_path, markets_lookup, min_usdc=0.50):
    """
    Single-pass stream through orderFilled_complete.csv.xz.
    Returns dict: wallet_addr → {condition_id → market_stats}
    """
    wallets = defaultdict(lambda: defaultdict(make_market_stats))
    total_rows = 0
    skipped_no_market = 0
    skipped_dust = 0
    skipped_platform = 0

    xz_size = os.path.getsize(xz_path)
    print(f"\nStreaming {xz_path} ({xz_size / 1e9:.1f} GB compressed)…")
    print("(This will take a while — decompress + process 86M rows)")

    with open(xz_path, "rb") as raw_file:
        with tqdm(total=xz_size, unit="B", unit_scale=True, desc="Reading") as bar:
            # Wrap the raw file so tqdm tracks compressed bytes read
            class ProgressWrapper:
                def __init__(self, f, bar):
                    self.f = f
                    self.bar = bar
                def read(self, n=-1):
                    data = self.f.read(n)
                    self.bar.update(len(data))
                    return data
                def readinto(self, b):
                    n = self.f.readinto(b)
                    self.bar.update(n)
                    return n
                def readable(self): return True
                def seekable(self): return False

            wrapped = ProgressWrapper(raw_file, bar)
            with lzma.open(wrapped, "rt", encoding="utf-8") as f:
                reader = csv.DictReader(f)
                for row in reader:
                    total_rows += 1
                    if total_rows % 5_000_000 == 0:
                        wallet_count = len(wallets)
                        print(f"  {total_rows/1e6:.0f}M rows | {wallet_count:,} wallets accumulated")

                    maker = row.get("maker", "").strip().lower()
                    if not maker or maker in PLATFORM_WALLETS:
                        skipped_platform += 1
                        continue

                    maker_asset = row.get("makerAssetId", "").strip()
                    taker_asset = row.get("takerAssetId", "").strip()

                    try:
                        maker_amount = int(row.get("makerAmountFilled", 0)) / 1e6
                        taker_amount = int(row.get("takerAmountFilled", 0)) / 1e6
                        ts = int(row.get("timestamp", 0))
                    except (ValueError, TypeError):
                        continue

                    # Determine direction from maker's perspective
                    # maker_asset == "0" → maker gives USDC, receives token → BUY
                    # taker_asset == "0" → maker gives token, receives USDC → SELL
                    if maker_asset == "0":
                        side = "BUY"
                        token_id = taker_asset
                        usdc_amount  = maker_amount
                        token_amount = taker_amount
                    elif taker_asset == "0":
                        side = "SELL"
                        token_id = maker_asset
                        usdc_amount  = taker_amount
                        token_amount = maker_amount
                    else:
                        continue  # token-for-token swap, skip

                    if usdc_amount < min_usdc:
                        skipped_dust += 1
                        continue

                    market = markets_lookup.get(token_id)
                    if not market:
                        skipped_no_market += 1
                        continue

                    cid = market["condition_id"]
                    m = wallets[maker][cid]

                    if side == "BUY":
                        m["total_bought_usdc"] += usdc_amount
                        m["total_bought_qty"]  += token_amount
                        m["buy_count"]         += 1
                    else:
                        m["total_sold_usdc"] += usdc_amount
                        m["total_sold_qty"]  += token_amount
                        m["sell_count"]      += 1

                    if ts > m["last_ts"]:
                        m["last_ts"] = ts

    print(f"\nStream complete: {total_rows:,} rows processed")
    print(f"  Skipped (platform): {skipped_platform:,}")
    print(f"  Skipped (dust <${min_usdc}): {skipped_dust:,}")
    print(f"  Skipped (unknown market): {skipped_no_market:,}")
    print(f"  Unique wallets found: {len(wallets):,}")
    return wallets


# ── Scoring — Python port of src/scoring.js ───────────────────────────────────

def compute_market_pnls(market_data):
    """Convert accumulated market stats into marketPnLs list (mirrors computeMarketPnL)."""
    results = []
    for cid, m in market_data.items():
        total_bought = m["total_bought_usdc"]
        total_sold   = m["total_sold_usdc"]
        buy_qty      = m["total_bought_qty"]
        cost_basis   = total_bought
        realized_pnl = total_sold - total_bought
        is_closed    = m["sell_count"] > 0
        avg_buy_price = total_bought / buy_qty if buy_qty > 0 else 0
        roi = (realized_pnl / cost_basis * 100) if cost_basis > 0 else 0
        results.append({
            "conditionId":  cid,
            "totalBought":  total_bought,
            "totalSold":    total_sold,
            "costBasis":    cost_basis,
            "realizedPnL":  realized_pnl,
            "roi":          roi,
            "avgBuyPrice":  avg_buy_price,
            "buyCount":     m["buy_count"],
            "sellCount":    m["sell_count"],
            "isClosed":     is_closed,
            "lastTradeTs":  m["last_ts"],
        })
    return results


def calc_win_rate(market_pnls):
    closed = [m for m in market_pnls if m["isClosed"]]
    if not closed:
        return 0.0
    wins = sum(1 for m in closed if m["realizedPnL"] > 0)
    return (wins / len(closed)) * 100


def calc_sharpe(market_pnls):
    closed = [m for m in market_pnls if m["isClosed"] and m["costBasis"] > 0]
    if len(closed) < 3:
        return 0.0
    returns = [m["roi"] / 100 for m in closed]
    mean = sum(returns) / len(returns)
    variance = sum((r - mean) ** 2 for r in returns) / len(returns)
    std_dev = math.sqrt(variance)
    if std_dev == 0:
        return 3.0 if mean > 0 else 0.0
    return mean / std_dev


def calc_max_drawdown(market_pnls):
    sorted_m = sorted(
        [m for m in market_pnls if m["isClosed"]],
        key=lambda m: m["lastTradeTs"]
    )
    if not sorted_m:
        return 0.0
    cum_pnl = 0.0
    peak = 0.0
    max_dd = 0.0
    for m in sorted_m:
        cum_pnl += m["realizedPnL"]
        if cum_pnl > peak:
            peak = cum_pnl
        dd = ((peak - cum_pnl) / peak * 100) if peak > 0 else 0.0
        if dd > max_dd:
            max_dd = dd
    return round(max_dd * 10) / 10


def calc_timing_score(market_pnls):
    with_buys = [m for m in market_pnls if m["avgBuyPrice"] > 0 and m["buyCount"] > 0]
    if not with_buys:
        return 50.0
    weighted_sum = 0.0
    total_weight = 0.0
    for m in with_buys:
        weight = m["costBasis"] or 1.0
        weighted_sum += (1 - min(m["avgBuyPrice"], 1)) * 100 * weight
        total_weight  += weight
    return round(weighted_sum / total_weight) if total_weight > 0 else 50.0


def calc_consistency(market_pnls):
    closed = [m for m in market_pnls if m["isClosed"]]
    if not closed:
        return 0.0
    market_count = min(len(closed), 30)
    breadth = min((math.log2(market_count + 1) / math.log2(31)) * 100, 100)
    profitable_ratio = sum(1 for m in closed if m["realizedPnL"] > 0) / len(closed)
    returns = [m["realizedPnL"] / m["costBasis"] if m["costBasis"] > 0 else 0 for m in closed]
    mean = sum(returns) / len(returns)
    variance = sum((r - mean) ** 2 for r in returns) / len(returns)
    cv = math.sqrt(variance) / abs(mean) if mean != 0 else 10.0
    stability = max(0, 100 - cv * 20)
    return round(breadth * 0.3 + profitable_ratio * 100 * 0.4 + stability * 0.3)


def sharpe_to_percentile(sharpe):
    breakpoints = [
        (-1,  0), (0, 25), (0.5, 50), (1.0, 70),
        (1.5, 85), (2.0, 93), (3.0, 100),
    ]
    if sharpe <= breakpoints[0][0]:
        return breakpoints[0][1]
    if sharpe >= breakpoints[-1][0]:
        return breakpoints[-1][1]
    for i in range(1, len(breakpoints)):
        x0, y0 = breakpoints[i - 1]
        x1, y1 = breakpoints[i]
        if sharpe <= x1:
            t = (sharpe - x0) / (x1 - x0)
            return round(y0 + t * (y1 - y0))
    return 50


def normalize(value, lo, hi):
    if hi == lo:
        return 50
    return max(0, min(100, (value - lo) / (hi - lo) * 100))


def score_wallet(market_data):
    market_pnls = compute_market_pnls(market_data)
    closed = [m for m in market_pnls if m["isClosed"]]
    total_pnl    = sum(m["realizedPnL"] for m in market_pnls)
    total_volume = sum(m["totalBought"]  for m in market_pnls)
    total_roi    = (total_pnl / total_volume * 100) if total_volume > 0 else 0.0

    win_rate    = calc_win_rate(market_pnls)
    sharpe      = calc_sharpe(market_pnls)
    max_dd      = calc_max_drawdown(market_pnls)
    timing      = calc_timing_score(market_pnls)
    consistency = calc_consistency(market_pnls)

    sharpe_norm = sharpe_to_percentile(sharpe)
    pnl_norm    = normalize(total_roi, -50, 100)

    raw_score = (
        win_rate     * 0.25 +
        sharpe_norm  * 0.25 +
        pnl_norm     * 0.25 +
        timing       * 0.15 +
        consistency  * 0.10
    )
    score = max(0, min(100, round(raw_score)))

    closed_count = len(closed)
    if (score > 70 and closed_count >= 20 and total_pnl > 500
            and total_volume > 0 and (total_pnl / total_volume) > 0.02):
        tier = "ELITE"
    elif score > 45 and closed_count >= 10:
        tier = "PRO"
    else:
        tier = "BASIC"

    total_trades = sum(m["buyCount"] + m["sellCount"] for m in market_pnls)

    return {
        "score":           score,
        "tier":            tier,
        "winRate":         round(win_rate * 10) / 10,
        "sharpe":          round(sharpe * 100) / 100,
        "maxDrawdown":     max_dd,
        "timing":          timing,
        "consistency":     consistency,
        "totalPnL":        round(total_pnl * 100) / 100,
        "totalVolume":     round(total_volume * 100) / 100,
        "totalROI":        round(total_roi * 10) / 10,
        "closedPositions": closed_count,
        "openPositions":   len(market_pnls) - closed_count,
        "totalTrades":     total_trades,
    }


# ── Filter and rank ───────────────────────────────────────────────────────────

def filter_and_rank(wallets, opts):
    print(f"\nScoring {len(wallets):,} wallets…")
    results = []
    for addr, market_data in wallets.items():
        total_trades = sum(
            m["buy_count"] + m["sell_count"] for m in market_data.values()
        )
        if total_trades < opts.min_trades:
            continue
        # Cap on total trades — real discretionary traders rarely exceed
        # a few thousand fills. Wallets with 10K+ are almost always
        # market-maker bots whose "100% win rate" comes from spread capture
        # on both sides of an order book, not predictive skill. Following
        # them would just dilute polytrack's signal.
        if total_trades > opts.max_trades:
            continue

        s = score_wallet(market_data)

        # Hard gates before appending
        if s["closedPositions"] < opts.min_closed:
            continue
        if s["totalPnL"] < opts.min_pnl:
            continue
        if s["score"] < opts.min_score:
            continue
        if s["winRate"] < opts.min_winrate:
            continue

        results.append({"address": addr, **s})

    results.sort(key=lambda r: r["score"], reverse=True)
    results = results[:opts.top]
    print(f"  → {len(results)} wallets passed filters (top {opts.top} kept)")
    return results


# ── CLI ───────────────────────────────────────────────────────────────────────

def parse_args():
    p = argparse.ArgumentParser(
        description="poly_data ETL → Polytrack historical wallet seeds"
    )
    p.add_argument("--data",        default=None, help="Path to orderFilled_complete.csv.xz (omit when --score-only)")
    p.add_argument("--score-only",  default=None, dest="score_only",
                   help="Skip streaming; load wallet checkpoint from this path and re-score")
    p.add_argument("--no-checkpoint", action="store_true", dest="no_checkpoint",
                   help="Don't save the post-stream wallet checkpoint")
    p.add_argument("--markets",     default=None,  help="Path to markets.csv (auto-downloaded if omitted)")
    p.add_argument("--out",         default=None,  help="Output JSON path")
    p.add_argument("--top",         type=int, default=300)
    p.add_argument("--min-trades",  type=int, default=50,    dest="min_trades")
    p.add_argument("--max-trades",  type=int, default=5000,  dest="max_trades",
                   help="Drop wallets with >N trades (filters out market makers / bots)")
    p.add_argument("--min-closed",  type=int, default=20,  dest="min_closed")
    p.add_argument("--min-pnl",     type=float, default=500, dest="min_pnl")
    p.add_argument("--min-score",   type=int, default=60, dest="min_score")
    p.add_argument("--min-winrate", type=float, default=55, dest="min_winrate")
    p.add_argument("--refresh-markets", action="store_true", dest="refresh_markets",
                   help="Rebuild/extend markets.csv from Polymarket gamma-api")
    p.add_argument("--dry-run",     action="store_true", dest="dry_run")
    return p.parse_args()


def main():
    opts = parse_args()

    # Resolve output path
    script_dir = os.path.dirname(os.path.abspath(__file__))
    repo_root  = os.path.dirname(script_dir)
    data_dir   = os.path.join(repo_root, "data")
    os.makedirs(data_dir, exist_ok=True)
    out_path = opts.out or os.path.join(data_dir, "historical_seeds.json")
    checkpoint_path = os.path.join(data_dir, "wallets_checkpoint.pkl")

    # ── Mode A: re-score from existing checkpoint (skip streaming) ────────────
    if opts.score_only:
        wallets = load_checkpoint(opts.score_only)
        seeds = filter_and_rank(wallets, opts)
        _write_and_preview(seeds, opts, out_path)
        return

    if not opts.data:
        print("ERROR: --data required (or use --score-only PATH to re-score a checkpoint)")
        sys.exit(1)
    if not os.path.exists(opts.data):
        print(f"ERROR: data file not found: {opts.data}")
        print()
        print("Download it first (5.8 GB):")
        print("  curl -L -o /tmp/orderFilled_complete.csv.xz \\")
        print("    https://polydata-archive.s3.us-east-1.amazonaws.com/orderFilled_complete.csv.xz")
        sys.exit(1)

    # Markets CSV — cached at data/markets.csv so reruns skip the rebuild.
    # poly_data's markets.csv isn't checked in to the repo; it's built by
    # paginating Polymarket's gamma-api. The build is resumable, so passing
    # --refresh-markets just appends any newly created markets.
    markets_path = opts.markets or os.path.join(data_dir, "markets.csv")
    if (not os.path.exists(markets_path)) or opts.refresh_markets:
        try:
            build_markets(markets_path)
        except KeyboardInterrupt:
            print("\nInterrupted while building markets.csv — partial file kept for resume.")
            sys.exit(1)
        except Exception as e:
            print(f"ERROR building markets.csv: {e}")
            sys.exit(1)
    else:
        print(f"Using cached markets.csv at {markets_path}")
        print("  (pass --refresh-markets to fetch newly created markets)")

    try:
        print("\nLoading markets lookup…")
        markets_lookup = load_markets(markets_path)

        wallets = stream_accumulate(opts.data, markets_lookup)

        # Persist BEFORE scoring — protects against scoring/ranking crashes so
        # we never have to re-stream. Tiny overhead (~50-200 MB on disk).
        if not opts.no_checkpoint:
            try:
                save_checkpoint(wallets, checkpoint_path)
                print(f"  (Re-score later with: --score-only {checkpoint_path})")
            except Exception as e:
                print(f"  WARN: checkpoint save failed: {e} — continuing")

        seeds = filter_and_rank(wallets, opts)
        _write_and_preview(seeds, opts, out_path)

    except KeyboardInterrupt:
        print("\nInterrupted.")
        sys.exit(1)


def _write_and_preview(seeds, opts, out_path):
    print(f"\n{'Rank':<5} {'Score':<6} {'Tier':<6} {'WinRate':<9} "
          f"{'Sharpe':<8} {'TotalPnL':>10} {'Trades':>7} {'Address'}")
    print("─" * 95)
    for i, w in enumerate(seeds[:20], 1):
        print(
            f"{i:<5} {w['score']:<6} {w['tier']:<6} {w['winRate']:.1f}%{'':<4} "
            f"{w['sharpe']:<8.2f} ${w['totalPnL']:>9,.0f} "
            f"{w['totalTrades']:>7,}  {w['address']}"
        )
    if len(seeds) > 20:
        print(f"  … and {len(seeds) - 20} more")

    if opts.dry_run:
        print("\n(--dry-run) No output written.")
        return

    payload = {
        "generated_at":   datetime.now(timezone.utc).isoformat(),
        "source":         "poly_data_etl",
        "filters": {
            "min_trades":  opts.min_trades,
            "max_trades":  opts.max_trades,
            "min_closed":  opts.min_closed,
            "min_pnl":     opts.min_pnl,
            "min_score":   opts.min_score,
            "min_winrate": opts.min_winrate,
            "top":         opts.top,
        },
        "wallets": seeds,
    }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    print(f"\n✓ Wrote {len(seeds)} wallets → {out_path}")
    print(f"\nNext step:")
    print(f"  node scripts/bootstrap_wallets.js --token YOUR_JWT")


if __name__ == "__main__":
    main()
