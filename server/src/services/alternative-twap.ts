import type { Hex } from "viem";
import type { RpcDataSource } from "../datasources/rpc.js";
import type { PolymarketDataSource } from "../datasources/polymarket.js";
import { PRICE_SCALE, type TwapData } from "../types.js";

const DEFAULT_PRICE = PRICE_SCALE / 2n;

export interface AlternativeTwapResult {
  twapData: TwapData;
  usedDefaultPrice: boolean;
  usedPolymarketSpot: boolean;
}

/**
 * Compute TwapData for a single market using RPC + Polymarket
 * when the subgraph is unavailable.
 */
async function computeAlternativeTwapData(
  conditionId: string,
  endTimestamp: bigint,
  rpc: RpcDataSource,
  polymarket: PolymarketDataSource
): Promise<AlternativeTwapResult> {
  const hex = conditionId as Hex;

  // Step 1: Get on-chain Robin contract state
  const state = await rpc.getMarketState(hex);

  // Already finalized in Robin — no TWAP needed
  //TODO this does not mean the market is finalized. I only means the market twap requirement is turned off.
  //Instead call RPC method isTwapSignatureRequired
  //Also this twapRequired thing overall is not checked in the subgraph flow? Might be fine though because there is no harm in signing correct data if it is not used in the end
  if (!state.twapRequired) {
    return {
      twapData: {
        required: false,
        conditionId: hex,
        startTimestamp: 0n,
        endTimestamp: 0n,
        twapPriceYes: 0n,
        marketEndedAt: 0n,
        marketEndYesPrice: 0n,
      },
      usedDefaultPrice: false,
      usedPolymarketSpot: false,
    };
  }

  // Step 2: Determine startTimestamp from RPC
  const startTimestamp =
    state.lastTwapUpdate > 0n
      ? state.lastTwapUpdate
      : state.marketInitTimestamp;

  // Step 3: Try to get Polymarket data
  //TODO try to get rid of this. Maybe send the yesTOkenId alongside the conditionId?
  //TODO If we can't get rid of it, load it as batch in parent function.
  let marketInfo;
  try {
    marketInfo = await polymarket.getMarketInfo(conditionId);
  } catch {
    // Polymarket entirely unreachable — use DEFAULT_PRICE
    //TODO don't use DEFAULT_PRICE here
    //TODO if we keep it, notify
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

  // Step 4: Compute TWAP price
  let twapPriceYes: bigint;
  let usedPolymarketSpot = false;

  //TODO doesn't endTimestamp need to clamped to finalization timestamp?
  //TODO check this in the other locations as well
  const timeDelta = endTimestamp - startTimestamp;
  if (timeDelta <= 0n) {
    // No time range — use spot price
    twapPriceYes = BigInt(
      Math.round(marketInfo.yesPrice * Number(PRICE_SCALE))
    );
    usedPolymarketSpot = true;
  } else {
    try {
      const twapResult = await polymarket.getTwapData(
        marketInfo.yesTokenId,
        Number(startTimestamp),
        Number(endTimestamp)
      );
      twapPriceYes = twapResult.twapPriceYes;
    } catch {
      // CLOB price history failed — use spot price
      //TODO notify?
      twapPriceYes = BigInt(
        Math.round(marketInfo.yesPrice * Number(PRICE_SCALE))
      );
      usedPolymarketSpot = true;
    }
  }

  // Clamp
  if (twapPriceYes < 0n) twapPriceYes = 0n;
  if (twapPriceYes > PRICE_SCALE) twapPriceYes = PRICE_SCALE;

  // Step 5: Resolution data
  let marketEndedAt = state.marketEndedAt;
  let marketEndYesPrice = state.marketEndYesPrice;

  // If contract doesn't know about resolution yet but Polymarket does,
  // include Polymarket resolution data so the contract can finalize.
  if (marketEndedAt === 0n && marketInfo.resolved) {
    //TODO we probably should not add marketEndedAt if resolvedYesPrice is not available
    //TODO also we need to check if the market already is resolved on chain which skips the twap requirement
    if (marketInfo.resolvedTimestamp) {
      marketEndedAt = BigInt(marketInfo.resolvedTimestamp);
    }
    if (marketInfo.resolvedYesPrice !== undefined) {
      marketEndYesPrice = BigInt(
        Math.round(marketInfo.resolvedYesPrice * Number(PRICE_SCALE))
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
 * Individual market failures throw (caller should handle).
 */
export async function computeAlternativeTwapDataBatch(
  conditionIds: string[],
  endTimestamp: bigint,
  rpc: RpcDataSource,
  polymarket: PolymarketDataSource
): Promise<Map<string, AlternativeTwapResult>> {
  const results = new Map<string, AlternativeTwapResult>();
  //TODO is Promise.all here the right choice if it really is up to 50 markets?
  const entries = await Promise.all(
    conditionIds.map(async (id) => {
      const result = await computeAlternativeTwapData(
        id,
        endTimestamp,
        rpc,
        polymarket
      );
      return [id, result] as const;
    })
  );
  for (const [id, result] of entries) {
    results.set(id, result);
  }
  return results;
}
