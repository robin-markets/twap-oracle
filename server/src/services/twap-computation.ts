import type { Hex } from "viem";
import { PRICE_SCALE, type SubgraphMarket, type TwapData } from "../types.js";

const DEFAULT_PRICE = PRICE_SCALE / 2n; // 500_000 = 50%

/**
 * Check whether a market will need a fallback price from Polymarket.
 * Mirrors the conditions in computeTwapData that use the fallback value.
 */
export function needsFallbackPrice(
  market: SubgraphMarket,
  endTimestamp: bigint,
): boolean {
  // Robin already resolved — returns required: false, no fallback needed
  if (market.robinResolvedAt !== null) return false;

  const startTimestamp =
    market.robinLastUpdatedAt !== null
      ? BigInt(market.robinLastUpdatedAt)
      : BigInt(market.robinInitializedAt);

  // timeDelta <= 0 → uses fallback
  if (endTimestamp - startTimestamp <= 0n) return true;

  // No trades indexed → uses fallback
  if (market.yesToken.lastPrice === null) return true;

  return false;
}

/**
 * Compute TwapData for a single market from subgraph data.
 *
 * @param market - Subgraph market entity with nested token data
 * @param endTimestamp - Current unix timestamp (seconds)
 * @param fallbackPrice - Optional price from Polymarket API (0-1e6 scale),
 *   used when no exchange trades exist or timeDelta is 0.
 */
export function computeTwapData(
  market: SubgraphMarket,
  endTimestamp: bigint,
  fallbackPrice?: bigint,
): TwapData {
  const conditionId = market.id as Hex;
  const fallback = fallbackPrice ?? DEFAULT_PRICE;

  // If Robin already resolved this market, no TWAP is needed.
  // The contract uses the fixed resolved price going forward.
  if (market.robinResolvedAt !== null) {
    return {
      required: false,
      conditionId,
      startTimestamp: 0n,
      endTimestamp: 0n,
      twapPriceYes: 0n,
      marketEndedAt: 0n,
      marketEndYesPrice: 0n,
    };
  }

  // Determine startTimestamp: last contract update, or init time on first update
  const startTimestamp =
    market.robinLastUpdatedAt !== null
      ? BigInt(market.robinLastUpdatedAt)
      : BigInt(market.robinInitializedAt);

  const timeDelta = endTimestamp - startTimestamp;

  // If timeDelta is zero or negative, use fallback price
  if (timeDelta <= 0n) {
    return buildTwapData(conditionId, startTimestamp, endTimestamp, fallback, market);
  }

  // Compute effective twapIndex for the YES token
  const yesToken = market.yesToken;
  let effectiveTwapIndex = BigInt(yesToken.twapIndex);

  if (yesToken.resolvedAt !== null) {
    // Token resolved: twapIndex is frozen at resolvedAt by closeTwap().
    // No extrapolation beyond resolution.
  } else if (yesToken.lastUpdatedAt !== null && yesToken.lastPrice !== null) {
    // Normal case: extrapolate from last trade to endTimestamp
    const lastUpdatedAt = BigInt(yesToken.lastUpdatedAt);
    const lastPrice = BigInt(yesToken.lastPrice);
    if (endTimestamp > lastUpdatedAt) {
      effectiveTwapIndex += lastPrice * (endTimestamp - lastUpdatedAt);
    }
  }
  // else: no trades at all — effectiveTwapIndex stays at 0 (or whatever twapIndex is)

  // Compute TWAP price from exchange activity since last contract update.
  // twapSnapshotYes is the exchange twapIndex snapshotted at the last
  // TwapUpdated event (or at market init). This avoids drift when TWAP
  // is disabled in the contract for a period.
  const exchangeDelta = effectiveTwapIndex - BigInt(market.twapSnapshotYes);

  let twapPriceYes: bigint;

  if (exchangeDelta <= 0n && yesToken.lastPrice === null) {
    // No trades indexed at all — use fallback
    twapPriceYes = fallback;
  } else {
    twapPriceYes = exchangeDelta / timeDelta;
  }

  // Clamp to [0, PRICE_SCALE]
  if (twapPriceYes < 0n) twapPriceYes = 0n;
  if (twapPriceYes > PRICE_SCALE) twapPriceYes = PRICE_SCALE;

  return buildTwapData(conditionId, startTimestamp, endTimestamp, twapPriceYes, market);
}

/**
 * Build final TwapData, including resolution fields if the subgraph
 * has seen resolution but Robin hasn't been finalized yet.
 */
function buildTwapData(
  conditionId: Hex,
  startTimestamp: bigint,
  endTimestamp: bigint,
  twapPriceYes: bigint,
  market: SubgraphMarket,
): TwapData {
  let marketEndedAt = 0n;
  let marketEndYesPrice = 0n;

  // If the subgraph indexed resolution but Robin hasn't finalized yet,
  // include the resolution data so the contract can finalize.
  if (
    market.yesToken.resolvedAt !== null &&
    market.robinResolvedAt === null
  ) {
    marketEndedAt = BigInt(market.yesToken.resolvedAt);
    marketEndYesPrice = BigInt(market.yesToken.resolvedPrice!);

    // Clamp resolution price
    if (marketEndYesPrice > PRICE_SCALE) marketEndYesPrice = PRICE_SCALE;
    if (marketEndYesPrice < 0n) marketEndYesPrice = 0n;
  }

  return {
    required: true,
    conditionId,
    startTimestamp,
    endTimestamp,
    twapPriceYes,
    marketEndedAt,
    marketEndYesPrice,
  };
}
