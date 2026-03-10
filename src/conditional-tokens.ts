import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import { ConditionResolution as ConditionResolutionEvent } from "../generated/ConditionalTokens/ConditionalTokens";
import { Condition, TokenIndex } from "../generated/schema";

const PRICE_SCALE = BigInt.fromI32(1000000);

function tokenIndexId(conditionId: Bytes, tokenId: BigInt): string {
  return conditionId.toHex().concat(tokenId.toString());
}

function applyResolvedPrice(
  tokenIndex: TokenIndex,
  resolvedPrice: BigInt,
  timestamp: BigInt
): void {
  if (tokenIndex.lastUpdatedAt === null) {
    tokenIndex.twapIndex = BigInt.zero();
    tokenIndex.startedAt = timestamp;
    tokenIndex.lastUpdatedAt = timestamp;
    tokenIndex.lastPrice = resolvedPrice;
    tokenIndex.resolvedAt = timestamp;
    tokenIndex.resolvedPrice = resolvedPrice;
    return;
  }

  const lastUpdatedAt = tokenIndex.lastUpdatedAt as BigInt;
  const timeElapsed = timestamp.minus(lastUpdatedAt);
  if (timeElapsed.gt(BigInt.zero())) {
    let currentTwapIndex = tokenIndex.twapIndex;
    if (currentTwapIndex === null) {
      currentTwapIndex = BigInt.zero();
    }
    tokenIndex.twapIndex = currentTwapIndex.plus(
      tokenIndex.lastPrice.times(timeElapsed)
    );
  }
  tokenIndex.lastPrice = resolvedPrice;
  tokenIndex.lastUpdatedAt = timestamp;
  tokenIndex.resolvedAt = timestamp;
  tokenIndex.resolvedPrice = resolvedPrice;
}

export function handleConditionResolution(
  event: ConditionResolutionEvent
): void {
  const conditionId = event.params.conditionId;
  const numerators = event.params.payoutNumerators;
  if (numerators.length < 2) {
    return;
  }

  const sum = numerators[0].plus(numerators[1]);
  if (sum.equals(BigInt.zero())) {
    return;
  }

  const condition = Condition.load(conditionId);
  if (!condition) {
    return;
  }

  const resolvedToken0Price = numerators[0].times(PRICE_SCALE).div(sum);
  const resolvedToken1Price = numerators[1].times(PRICE_SCALE).div(sum);

  const token0IndexId = tokenIndexId(conditionId, condition.token0Id);
  let token0Index = TokenIndex.load(token0IndexId);
  if (token0Index) {
    applyResolvedPrice(token0Index, resolvedToken0Price, event.block.timestamp);
    token0Index.save();
  }

  const token1IndexId = tokenIndexId(conditionId, condition.token1Id);
  let token1Index = TokenIndex.load(token1IndexId);
  if (token1Index) {
    applyResolvedPrice(token1Index, resolvedToken1Price, event.block.timestamp);
    token1Index.save();
  }
}
