import type { Hex } from "viem";
import type { RpcDataSource } from "../datasources/rpc.js";
import type { RpcMarketState } from "../datasources/rpc.js";
import type { IPolymarketDataSource } from "../datasources/polymarket.js";
import {
  PRICE_SCALE,
  TwapError,
  type PolymarketMarketInfo,
  type TwapData,
} from "../types.js";

const CLOB_CONCURRENCY = 15;

export interface AlternativeTwapBatchResult {
  results: Map<string, TwapData>;
  failed: Map<string, string>; // conditionId → error message
}

/**
 * Compute TwapData for a single market from pre-loaded data.
 * Needs polymarket only for the per-market getTwapData (CLOB price history) call.
 *
 * @param marketInfo - undefined when Polymarket was unreachable
 */
async function computeAlternativeTwapData(
  conditionId: string,
  endTimestamp: bigint,
  state: RpcMarketState,
  marketInfo: PolymarketMarketInfo | undefined,
  polymarket: IPolymarketDataSource,
): Promise<TwapData> {
  const hex = conditionId as Hex;

  const startTimestamp =
    state.lastTwapUpdate > 0n
      ? state.lastTwapUpdate
      : state.marketInitTimestamp;

  if (marketInfo === undefined) {
    throw new Error(
      `Cannot compute TWAP for market ${conditionId}: Polymarket data unavailable and subgraph is down`,
    );
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

  const timeDelta = clampedEnd - startTimestamp;
  if (timeDelta <= 0n) {
    if (marketInfo.yesPrice === undefined) {
      throw new TwapError(
        `Cannot compute TWAP for market ${conditionId}: no time range and no valid spot price`,
        500,
      );
    }
    twapPriceYes = BigInt(
      Math.round(marketInfo.yesPrice * Number(PRICE_SCALE)),
    );
  } else {
    try {
      const twapResult = await polymarket.getTwapData(
        marketInfo.yesTokenId,
        Number(startTimestamp),
        Number(clampedEnd),
      );
      twapPriceYes = twapResult.twapPriceYes;
    } catch {
      throw new TwapError(
        `Cannot compute TWAP for market ${conditionId}: CLOB history call failed.`,
        500,
      );
    }
  }

  // Clamp
  if (twapPriceYes < 0n) twapPriceYes = 0n;
  if (twapPriceYes > PRICE_SCALE) twapPriceYes = PRICE_SCALE;

  // Resolution data
  let marketEndedAt = state.marketEndedAt;
  let marketEndYesPrice = state.marketEndYesPrice;

  if (marketEndedAt === 0n && marketInfo.resolved) {
    if (
      marketInfo.resolvedTimestamp === undefined ||
      marketInfo.resolvedYesPrice === undefined
    ) {
      throw new Error(
        `Market ${conditionId} is resolved on Polymarket but missing ` +
          `${marketInfo.resolvedTimestamp === undefined ? "timestamp" : "price"} data`,
      );
    }
    marketEndedAt = BigInt(marketInfo.resolvedTimestamp);
    marketEndYesPrice = BigInt(
      Math.round(marketInfo.resolvedYesPrice * Number(PRICE_SCALE)),
    );
    if (marketEndYesPrice > PRICE_SCALE) marketEndYesPrice = PRICE_SCALE;
    if (marketEndYesPrice < 0n) marketEndYesPrice = 0n;
  }

  return {
    required: true,
    conditionId: hex,
    startTimestamp,
    endTimestamp,
    twapPriceYes,
    marketEndedAt,
    marketEndYesPrice,
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
  polymarket: IPolymarketDataSource,
): Promise<AlternativeTwapBatchResult> {
  // 1. Batch RPC
  const rpcBatch = await rpc.getMarketStateBatch(
    conditionIds.map((id) => id as Hex),
  );

  // 2. Early return for markets that don't need TWAP signature
  const results = new Map<string, TwapData>();
  const failed = new Map<string, string>();
  const needsPolymarket: string[] = [];

  for (const id of conditionIds) {
    const rpcData = rpcBatch.get(id as Hex)!;
    if (!rpcData.twapSignatureRequired) {
      results.set(id, {
        required: false,
        conditionId: id as Hex,
        startTimestamp: 0n,
        endTimestamp: 0n,
        twapPriceYes: 0n,
        marketEndedAt: 0n,
        marketEndYesPrice: 0n,
      });
    } else {
      needsPolymarket.push(id);
    }
  }

  if (needsPolymarket.length === 0) return { results, failed };

  // 3. Batch Polymarket
  const polymarketInfoMap =
    await polymarket.getMarketInfoBatch(needsPolymarket);

  // 4. Compute for each remaining market (getTwapData calls run in chunks)
  for (let i = 0; i < needsPolymarket.length; i += CLOB_CONCURRENCY) {
    const chunk = needsPolymarket.slice(i, i + CLOB_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map(async (id) => {
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

    for (let j = 0; j < settled.length; j++) {
      const entry = settled[j];
      if (entry.status === "fulfilled") {
        const [id, result] = entry.value;
        results.set(id, result);
      } else {
        const id = chunk[j];
        failed.set(
          id,
          entry.reason instanceof Error
            ? entry.reason.message
            : String(entry.reason),
        );
      }
    }
  }

  return { results, failed };
}
