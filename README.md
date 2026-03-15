# Robin TWAP Oracle Server

Off-chain oracle that computes Time-Weighted Average Price (TWAP) data for Polymarket prediction markets and signs it for on-chain consumption by the RobinTwapOracle contract.

## How TWAP Works

RobinStakingVault needs to know the average YES/NO price over time to fairly split yield between the two sides. A TWAP accumulator in the Oracle tracks `sum(price * time)` — the area under the price curve. Dividing by the total time gives the average price.

### Accumulation (subgraph)

The subgraph indexes `OrderFilled` events from the CTF Exchange. Each trade updates a `TokenIndex` entity:

```
twapIndex += lastPrice * (currentTimestamp - lastUpdatedAt)
lastPrice  = newTradePrice
lastUpdatedAt = currentTimestamp
```

`twapIndex` only advances up to the most recent trade. Between trades, price is assumed constant at `lastPrice` — the server extrapolates this gap when computing the final TWAP.

When a market resolves on-chain (`ConditionResolution` event), `closeTwap()` performs a final accumulation from the last trade to resolution time and freezes the index.

### Snapshots

Every time the contract processes a TWAP update, it emits a `TwapUpdated` event. The subgraph handler snapshots the exchange `twapIndex` at that point (extrapolated to the block timestamp). This snapshot serves as the baseline for the next oracle computation — `exchangeDelta = currentIndex - snapshot`.

### Contract consumption

The contract's `_applyTwap` receives a `twapPriceYes` (average price for the period) and accumulates it:

```
twapAccumulatorYes += twapPriceYes * (block.timestamp - lastTwapUpdate)
```

For finalization (`_applyFinalTwap`), the contract splits the period:

- `twapPriceYes * (marketEndedAt - lastTwapUpdate)` — TWAP up to resolution
- `marketEndYesPrice * (block.timestamp - marketEndedAt)` — fixed price after resolution

The server uses the subgraph's last indexed block timestamp as `endTimestamp` for Flow A/B, ensuring the signed data is consistent with the indexed state and that the vault contract would revert if the subgraph is falling too much out of sync. `twapPriceYes` must be the average over the pre-resolution period only when finalizing.

### Price scale

All prices use 6-decimal fixed-point: `PRICE_SCALE = 1_000_000` (1e6 = 100%).

## Architecture

```
POST /twap { conditionIds: string[] }
         │
         ▼
   ┌─────────────┐
   │  Validation │  Normalize & validate conditionIds (bytes32 hex)
   └──────┬──────┘
          │
          ▼
   ┌─────────────┐     success     ┌───────────────┐     fresh      ┌──────────────────┐
   │  Subgraph   │───────────────▶ │  Staleness    │──────────────▶ │  Flow A/B        │
   │  fetch      │                 │  check        │               │  (subgraph data) │
   └──────┬──────┘                 └───────┬───────┘               └──────────────────┘
          │ failure                        │ stale (> grace period)
          ▼                                ▼
   ┌──────────────────┐
   │  Flow C          │
   │  (RPC+Polymarket)│
   └──────────────────┘
          │
          ▼
   ┌─────────────┐
   │  EIP-712    │  Sign batch with trusted signer key
   │  signing    │
   └──────┬──────┘
          │
          ▼
   HTTP 200 { markets, signature, failed: [] }
   or
   HTTP 500 { error, failed: [...] }
```

## Request Flows

### Flow A — Subgraph available, all markets found

The happy path. The subgraph has indexed all requested markets.

1. **Fetch subgraph data** — GraphQL query returns market entities with token indexes, snapshots, and resolution state. The query also fetches `_meta.block.timestamp` to determine how far behind the subgraph is. If the lag exceeds `TWAP_GRACE_PERIOD_SECONDS`, the subgraph is considered stale and the server falls back to Flow C. Otherwise, the subgraph's block timestamp is used as `endTimestamp` in the signed package, ensuring consistency between the indexed data and the time boundary.
2. **Fallback prices** — For markets with no exchange trades, fetch the current YES price from the Polymarket Gamma API as a fallback.
3. **Compute TWAP** (`twap-computation.ts`) — For each market:
    - If Robin already finalized: return `required: false` (no signature needed).
    - Clamp calculation end to resolution time if the subgraph has seen resolution.
    - Extrapolate `twapIndex` from last trade to the clamped end.
    - `twapPriceYes = (effectiveIndex - snapshot) / timeDelta`
    - If the subgraph has resolution data but Robin hasn't finalized: include `marketEndedAt` and `marketEndYesPrice`.
4. **Verify against Polymarket** (`verification.ts`) — Cross-check subgraph results:
    - **Resolution check**: If subgraph and Polymarket disagree on whether a market is resolved, send a notification. If Polymarket shows resolved but subgraph doesn't, fill in resolution data from the API.
    - **TWAP comparison**: Fetch CLOB price history for the same period and compare. If divergence exceeds the configured threshold, send a warning notification. This is a soft check — subgraph data is used regardless.
5. **Sign and return** — EIP-712 sign the batch and respond.

### Flow B — Subgraph available, some markets missing

Same as Flow A for found markets, plus:

1. **Missing markets** fall back to the alternative TWAP computation (same as Flow C, but only for the missing subset).
2. Results are merged in the original request order.
3. If any market fails (from either source), the entire request returns HTTP 500 with the `failed` array.

### Flow C — Subgraph completely unavailable (or too stale)

Fallback path when the subgraph is down, returning errors, or lagging behind by more than `TWAP_GRACE_PERIOD_SECONDS`.

1. **Batch RPC** (`rpc.ts`) — `multicall` to the oracle contract fetches `getMarketState` and `isTwapSignatureRequired` for all markets in a single request.
2. **Categorize markets** (`alternative-twap.ts`) — Markets are split into three groups:
    - **Already finalized** in the contract (`marketEndedAt > 0`): return `required: false`.
    - **TWAP signature required**: needs full CLOB-based TWAP computation.
    - **TWAP not required, not yet finalized**: check Polymarket for resolution status. If resolved, compute a full TWAP package with finalization data (so the contract can finalize the market). If not resolved, return `required: false`.
3. **Batch Polymarket** — Fetch market info (prices, resolution status) from the Gamma API for all markets that need data.
4. **Per-market TWAP** — For each market needing computation:
    - Clamp the calculation end to Polymarket's resolution timestamp if resolved.
    - Fetch CLOB price history (`/prices-history`) and compute a time-weighted average.
    - If the market is resolved on Polymarket but not on-chain, include resolution data.
5. **Concurrency** — CLOB API calls run in chunks of 15 (`CLOB_CONCURRENCY`) to avoid rate limiting.
6. **Per-market errors** — Individual market failures are collected; the request returns HTTP 500 with a `failed` array listing which conditionIds could not be computed.

## Per-Market Error Reporting

If any market fails computation, the API returns HTTP 500 with:

```json
{
    "error": "Some markets could not be computed",
    "failed": [
        {
            "conditionId": "0xabc...",
            "error": "CLOB history call failed"
        }
    ]
}
```

No signed data is returned on failure since it's unusable with missing markets. The caller should remove the failed conditionIds and retry.

On success (all markets computed), the response is HTTP 200 with `failed: []`.

## Data Sources

| Source                   | What it provides                                                         | When used                                       |
| ------------------------ | ------------------------------------------------------------------------ | ----------------------------------------------- |
| **Subgraph**             | Exchange twapIndex, snapshots, resolution data from on-chain events      | Primary source (Flow A/B)                       |
| **RPC (multicall)**      | Contract market state: lastTwapUpdate, accumulators, finalization status | Fallback (Flow B/C)                             |
| **Polymarket Gamma API** | Current spot prices, resolution status, CLOB token IDs                   | Fallback prices, verification, alternative flow |
| **Polymarket CLOB API**  | Historical price samples (`/prices-history`)                             | Alternative TWAP computation (Flow B/C)         |

A request-scoped `CachedPolymarketDataSource` wraps the Gamma API to deduplicate batch fetches across different stages of a single request (fallback lookup, verification, alternative computation).

## EIP-712 Signing

The server signs a `BatchTwapData` struct using the trusted signer's private key:

```
BatchTwapData(TwapData[] markets)
TwapData(bool required, bytes32 conditionId, uint256 startTimestamp,
         uint256 endTimestamp, uint256 twapPriceYes,
         uint256 marketEndedAt, uint256 marketEndYesPrice)
```

The contract verifies this signature against its stored `twapSigner` address before accepting TWAP updates.
