import type { Hex } from "viem";
import type { RpcDataSource } from "../datasources/rpc.js";
import type { RpcMarketState } from "../datasources/rpc.js";
import type { PolymarketDataSource } from "../datasources/polymarket.js";
import {
  PRICE_SCALE,
  type PolymarketMarketInfo,
  type TwapData,
} from "../types.js";

const DEFAULT_PRICE = PRICE_SCALE / 2n;

export interface AlternativeTwapResult {
  twapData: TwapData;
  usedDefaultPrice: boolean;
  usedPolymarketSpot: boolean;
}

/**
 * Compute TwapData for a single market from pre-loaded data.
 * Needs polymarket only for the per-market getTwapData (CLOB price history) call.
 *
 * @param marketInfo - undefined when Polymarket was unreachable (uses DEFAULT_PRICE)
 */
async function computeAlternativeTwapData(
  conditionId: string,
  endTimestamp: bigint,
  state: RpcMarketState,
  marketInfo: PolymarketMarketInfo | undefined,
  polymarket: PolymarketDataSource,
): Promise<AlternativeTwapResult> {
  const hex = conditionId as Hex;

  const startTimestamp =
    state.lastTwapUpdate > 0n
      ? state.lastTwapUpdate
      : state.marketInitTimestamp;

  // Polymarket unreachable — use DEFAULT_PRICE
  //TODO don't use DEFAULT_PRICE here
  if (marketInfo === undefined) {
    return {
      twapData: {
        required: true,
        conditionId: hex,
        startTimestamp,
        endTimestamp,
        twapPriceYes: DEFAULT_PRICE,
        marketEndedAt: state.marketEndedAt,
        marketEndYesPrice: state.marketEndYesPrice,
      },
      usedDefaultPrice: true,
      usedPolymarketSpot: false,
    };
  }

  // Clamp endTimestamp to market resolution time if resolved on Polymarket
  let clampedEnd = endTimestamp;
  if (marketInfo.resolved && marketInfo.resolvedTimestamp) {
    const resolvedTs = BigInt(marketInfo.resolvedTimestamp);
    if (resolvedTs < clampedEnd) {
      clampedEnd = resolvedTs;
    }
  }

  // Compute TWAP price
  let twapPriceYes: bigint;
  let usedPolymarketSpot = false;

  const timeDelta = clampedEnd - startTimestamp;
  if (timeDelta <= 0n) {
    twapPriceYes = BigInt(
      Math.round(marketInfo.yesPrice * Number(PRICE_SCALE)),
    );
    usedPolymarketSpot = true;
  } else {
    try {
      const twapResult = await polymarket.getTwapData(
        marketInfo.yesTokenId,
        Number(startTimestamp),
        Number(clampedEnd),
      );
      twapPriceYes = twapResult.twapPriceYes;
    } catch {
      // CLOB price history failed — use spot price
      twapPriceYes = BigInt(
        Math.round(marketInfo.yesPrice * Number(PRICE_SCALE)),
      );
      usedPolymarketSpot = true;
    }
  }

  // Clamp
  if (twapPriceYes < 0n) twapPriceYes = 0n;
  if (twapPriceYes > PRICE_SCALE) twapPriceYes = PRICE_SCALE;

  // Resolution data
  let marketEndedAt = state.marketEndedAt;
  let marketEndYesPrice = state.marketEndYesPrice;

  if (marketEndedAt === 0n && marketInfo.resolved) {
    //TODO we probably should not add marketEndedAt if resolvedYesPrice is not available
    if (marketInfo.resolvedTimestamp) {
      marketEndedAt = BigInt(marketInfo.resolvedTimestamp);
    }
    if (marketInfo.resolvedYesPrice !== undefined) {
      marketEndYesPrice = BigInt(
        Math.round(marketInfo.resolvedYesPrice * Number(PRICE_SCALE)),
      );
      if (marketEndYesPrice > PRICE_SCALE) marketEndYesPrice = PRICE_SCALE;
      if (marketEndYesPrice < 0n) marketEndYesPrice = 0n;
    }
  }

  return {
    twapData: {
      required: true,
      conditionId: hex,
      startTimestamp,
      endTimestamp,
      twapPriceYes,
      marketEndedAt,
      marketEndYesPrice,
    },
    usedDefaultPrice: false,
    usedPolymarketSpot,
  };
}

/**
 * Batch-compute alternative TwapData for multiple markets.
 *
 * 1. Batch RPC: getMarketStateBatch (multicall) for state + isTwapSignatureRequired
 * 2. Early return markets that don't need TWAP signature
 * 3. Batch Polymarket: getMarketInfoBatch for remaining markets
 * 4. Per-market: compute TWAP from CLOB price history (no batch API for this)
 */
export async function computeAlternativeTwapDataBatch(
  conditionIds: string[],
  endTimestamp: bigint,
  rpc: RpcDataSource,
  polymarket: PolymarketDataSource,
): Promise<Map<string, AlternativeTwapResult>> {
  // 1. Batch RPC
  const rpcBatch = await rpc.getMarketStateBatch(
    conditionIds.map((id) => id as Hex),
  );

  // 2. Early return for markets that don't need TWAP signature
  const results = new Map<string, AlternativeTwapResult>();
  const needsPolymarket: string[] = [];

  for (const id of conditionIds) {
    const rpcData = rpcBatch.get(id as Hex)!;
    if (!rpcData.twapSignatureRequired) {
      results.set(id, {
        twapData: {
          required: false,
          conditionId: id as Hex,
          startTimestamp: 0n,
          endTimestamp: 0n,
          twapPriceYes: 0n,
          marketEndedAt: 0n,
          marketEndYesPrice: 0n,
        },
        usedDefaultPrice: false,
        usedPolymarketSpot: false,
      });
    } else {
      needsPolymarket.push(id);
    }
  }

  if (needsPolymarket.length === 0) return results;

  // 3. Batch Polymarket
  let polymarketInfoMap = new Map<string, PolymarketMarketInfo>();
  try {
    polymarketInfoMap = await polymarket.getMarketInfoBatch(needsPolymarket);
  } catch {
    // All will use DEFAULT_PRICE — caller handles notification
  }

  // 4. Compute for each remaining market (getTwapData calls run concurrently)
  const entries = await Promise.all(
    needsPolymarket.map(async (id) => {
      const rpcData = rpcBatch.get(id as Hex)!;
      const marketInfo = polymarketInfoMap.get(id); // undefined if not found/unreachable
      const result = await computeAlternativeTwapData(
        id,
        endTimestamp,
        rpcData.state,
        marketInfo,
        polymarket,
      );
      return [id, result] as const;
    }),
  );

  for (const [id, result] of entries) {
    results.set(id, result);
  }

  return results;
}
