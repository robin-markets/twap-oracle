import { BigInt } from "@graphprotocol/graph-ts";
import { ConditionResolution as ConditionResolutionEvent } from "../generated/ConditionalTokens/ConditionalTokens";
import { TokenIndex } from "../generated/schema";
import { PRICE_SCALE, tokenIndexId } from "./utils";

function applyResolvedPrice(
  tokenIndex: TokenIndex,
  resolvedPrice: BigInt,
  timestamp: BigInt
): void {
  tokenIndex.resolvedAt = timestamp;
  tokenIndex.resolvedPrice = resolvedPrice;

  if (tokenIndex.lastUpdatedAt === null || tokenIndex.lastPrice === null) {
    tokenIndex.save();
    return;
  }

  const lastUpdatedAt = tokenIndex.lastUpdatedAt as BigInt; //already checked null above
  const timeElapsed = timestamp.minus(lastUpdatedAt);
  const lastPrice = tokenIndex.lastPrice as BigInt; //already checked null above
  tokenIndex.twapIndex = tokenIndex.twapIndex.plus(
    lastPrice.times(timeElapsed)
  );
  tokenIndex.lastUpdatedAt = timestamp;
  tokenIndex.save();
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

  const resolvedToken0Price = numerators[0].times(PRICE_SCALE).div(sum);
  const resolvedToken1Price = numerators[1].times(PRICE_SCALE).div(sum);

  const token0IndexId = tokenIndexId(conditionId, 0);
  let token0Index = TokenIndex.load(token0IndexId);
  if (token0Index) {
    applyResolvedPrice(token0Index, resolvedToken0Price, event.block.timestamp);
  }

  const token1IndexId = tokenIndexId(conditionId, 1);
  let token1Index = TokenIndex.load(token1IndexId);
  if (token1Index) {
    applyResolvedPrice(token1Index, resolvedToken1Price, event.block.timestamp);
  }
}
