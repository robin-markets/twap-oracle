import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import {
  MarketInitialized,
  MarketFinalized,
  TwapUpdated,
} from "../generated/RobinStakingVault/RobinStakingVault";
import { TokenIndex } from "../generated/schema";
import { PRICE_SCALE, tokenIndexId } from "./utils";

function getOrCreateTokenIndex(
  conditionId: Bytes,
  tokenId: BigInt,
  index: i32
): TokenIndex {
  const indexId = tokenIndexId(conditionId, index);
  let tokenIndex = TokenIndex.load(indexId);
  if (!tokenIndex) {
    tokenIndex = new TokenIndex(indexId);
    tokenIndex.conditionId = conditionId;
    tokenIndex.tokenIndex = index;
    tokenIndex.tokenId = tokenId;
    tokenIndex.twapIndex = BigInt.zero();
  }
  return tokenIndex;
}

export function handleTwapUpdated(event: TwapUpdated): void {
  const conditionId = event.params.conditionId;
  const token0Index = TokenIndex.load(tokenIndexId(conditionId, 0));
  if (!token0Index) return;
  token0Index.robinLastUpdatedAt = event.params.timestamp;
  token0Index.robinTwapIndexYes = event.params.twapAccumulatorYes;
  token0Index.save();

  const token1Index = TokenIndex.load(tokenIndexId(conditionId, 1));
  if (!token1Index) return;
  token1Index.robinLastUpdatedAt = event.params.timestamp;
  token1Index.robinTwapIndexYes = event.params.twapAccumulatorYes;
  token1Index.save();
}

export function handleMarketInitialized(event: MarketInitialized): void {
  const conditionId = event.params.conditionId;
  const timestamp = event.block.timestamp;

  const yesTokenId = event.params.yesPositionId;
  const noTokenId = event.params.noPositionId;

  const token0Index = getOrCreateTokenIndex(conditionId, yesTokenId, 0);
  token0Index.robinInitializedAt = timestamp;
  token0Index.twapIndexAtRobinInitializedAt = token0Index.twapIndex;
  token0Index.save();

  const token1Index = getOrCreateTokenIndex(conditionId, noTokenId, 1);
  token1Index.robinInitializedAt = timestamp;
  token1Index.twapIndexAtRobinInitializedAt = token1Index.twapIndex;
  token1Index.save();
}

export function handleMarketFinalized(event: MarketFinalized): void {
  const conditionId = event.params.conditionId;
  const marketEndedAt = event.params.marketEndedAt;
  const marketEndYesPrice = event.params.marketEndYesPrice;
  const marketEndNoPrice = PRICE_SCALE.minus(marketEndYesPrice);

  const token0Index = TokenIndex.load(tokenIndexId(conditionId, 0));
  if (!token0Index) return;
  token0Index.robinResolvedAt = marketEndedAt;
  token0Index.robinResolvedPrice = marketEndYesPrice;
  token0Index.save();

  const token1Index = TokenIndex.load(tokenIndexId(conditionId, 1));
  if (!token1Index) return;
  token1Index.robinResolvedAt = marketEndedAt;
  token1Index.robinResolvedPrice = marketEndNoPrice;
  token1Index.save();
}
