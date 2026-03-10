import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import {
  MarketInitialized,
  TwapUpdated,
} from "../generated/RobinStakingVault/RobinStakingVault";
import { Condition, TokenIndex } from "../generated/schema";

function tokenIndexId(conditionId: Bytes, tokenId: BigInt): string {
  return conditionId.toHex().concat(tokenId.toString());
}

function getOrCreateTokenIndex(
  conditionId: Bytes,
  tokenId: BigInt,
  timestamp: BigInt
): TokenIndex {
  const indexId = tokenIndexId(conditionId, tokenId);
  let tokenIndex = TokenIndex.load(indexId);
  if (!tokenIndex) {
    tokenIndex = new TokenIndex(indexId);
    tokenIndex.condition = conditionId;
    tokenIndex.tokenId = tokenId;
    tokenIndex.twapIndex = BigInt.zero();
    tokenIndex.startedAt = timestamp;
    tokenIndex.lastUpdatedAt = timestamp;
    tokenIndex.lastPrice = BigInt.zero();
  }
  return tokenIndex;
}

export function handleTwapUpdated(event: TwapUpdated): void {
  const conditionId = event.params.conditionId;
  const condition = Condition.load(conditionId);
  if (!condition) {
    return;
  }

  const token0Index = getOrCreateTokenIndex(
    conditionId,
    condition.token0Id,
    event.block.timestamp
  );
  token0Index.robinLastUpdatedAt = event.params.timestamp;
  token0Index.robinTwapIndexYes = event.params.twapAccumulatorYes;
  token0Index.save();

  const token1Index = getOrCreateTokenIndex(
    conditionId,
    condition.token1Id,
    event.block.timestamp
  );
  token1Index.robinLastUpdatedAt = event.params.timestamp;
  token1Index.robinTwapIndexYes = event.params.twapAccumulatorYes;
  token1Index.save();
}

export function handleMarketInitialized(event: MarketInitialized): void {
  const conditionId = event.params.conditionId;
  let condition = Condition.load(conditionId);
  if (!condition) {
    condition = new Condition(conditionId);
    condition.token0Id = event.params.yesPositionId;
    condition.token1Id = event.params.noPositionId;
    condition.save();
  }

  const timestamp = event.block.timestamp;

  const yesTokenId = event.params.yesPositionId;
  const noTokenId = event.params.noPositionId;

  const token0Index = getOrCreateTokenIndex(
    conditionId,
    condition.token0Id,
    timestamp
  );
  token0Index.robinInitializedAt = timestamp;
  token0Index.twapIndexAtRobinInitializedAt = token0Index.twapIndex;
  if (condition.token0Id.equals(yesTokenId)) {
    token0Index.robinIsYes = true;
  } else if (condition.token0Id.equals(noTokenId)) {
    token0Index.robinIsYes = false;
  }
  token0Index.save();

  const token1Index = getOrCreateTokenIndex(
    conditionId,
    condition.token1Id,
    timestamp
  );
  token1Index.robinInitializedAt = timestamp;
  token1Index.twapIndexAtRobinInitializedAt = token1Index.twapIndex;
  if (condition.token1Id.equals(yesTokenId)) {
    token1Index.robinIsYes = true;
  } else if (condition.token1Id.equals(noTokenId)) {
    token1Index.robinIsYes = false;
  }
  token1Index.save();
}
