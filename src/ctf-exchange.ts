import { BigInt, Bytes } from "@graphprotocol/graph-ts";
import {
  CTFExchange,
  OrderFilled,
  TokenRegistered,
} from "../generated/CTFExchange/CTFExchange";
import { Condition, TokenIndex } from "../generated/schema";

const COLLATERAL_ASSET_ID = BigInt.fromI32(0);
const PRICE_SCALE = BigInt.fromI32(1000000);

function tokenIndexId(conditionId: Bytes, tokenId: BigInt): string {
  return conditionId.toHex().concat(tokenId.toString());
}

function updateIndexWithPrice(
  tokenIndex: TokenIndex,
  price6: BigInt,
  timestamp: BigInt
): void {
  if (tokenIndex.lastUpdatedAt === null) {
    tokenIndex.twapIndex = BigInt.zero();
    tokenIndex.startedAt = timestamp;
    tokenIndex.lastUpdatedAt = timestamp;
    tokenIndex.lastPrice = price6;
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
  tokenIndex.lastPrice = price6;
  tokenIndex.lastUpdatedAt = timestamp;
}

export function handleOrderFilled(event: OrderFilled): void {
  const makerAssetId = event.params.makerAssetId;
  const takerAssetId = event.params.takerAssetId;

  let tokenId: BigInt;
  let collateralAmount: BigInt;
  let tokenAmount: BigInt;

  if (makerAssetId.equals(COLLATERAL_ASSET_ID)) {
    tokenId = takerAssetId;
    collateralAmount = event.params.makerAmountFilled;
    tokenAmount = event.params.takerAmountFilled;
  } else if (takerAssetId.equals(COLLATERAL_ASSET_ID)) {
    tokenId = makerAssetId;
    collateralAmount = event.params.takerAmountFilled;
    tokenAmount = event.params.makerAmountFilled;
  } else {
    return;
  }

  if (tokenAmount.equals(BigInt.zero())) {
    return;
  }

  const contract = CTFExchange.bind(event.address);
  const conditionResult = contract.try_getConditionId(tokenId);
  if (conditionResult.reverted) {
    return;
  }

  const conditionId = conditionResult.value;
  let condition = Condition.load(conditionId);
  if (!condition) {
    const complementResult = contract.try_getComplement(tokenId);
    if (complementResult.reverted) {
      return;
    }
    condition = new Condition(conditionId);
    condition.token0Id = tokenId;
    condition.token1Id = complementResult.value;
    condition.save();

    const token0Index = new TokenIndex(tokenIndexId(conditionId, tokenId));
    token0Index.condition = conditionId;
    token0Index.tokenId = tokenId;
    token0Index.lastPrice = BigInt.zero();
    token0Index.save();

    const token1Index = new TokenIndex(
      tokenIndexId(conditionId, complementResult.value)
    );
    token1Index.condition = conditionId;
    token1Index.tokenId = complementResult.value;
    token1Index.lastPrice = BigInt.zero();
    token1Index.save();
  }

  const indexId = tokenIndexId(conditionId, tokenId);
  let tokenIndex = TokenIndex.load(indexId);
  if (!tokenIndex) {
    tokenIndex = new TokenIndex(indexId);
    tokenIndex.condition = conditionId;
    tokenIndex.tokenId = tokenId;
    tokenIndex.lastPrice = BigInt.zero();
  }

  if (tokenIndex.resolvedAt !== null) {
    return;
  }

  const price6 = collateralAmount.times(PRICE_SCALE).div(tokenAmount);
  updateIndexWithPrice(tokenIndex, price6, event.block.timestamp);
  tokenIndex.save();
}

export function handleTokenRegistered(event: TokenRegistered): void {
  const conditionId = event.params.conditionId;
  let condition = Condition.load(conditionId);
  if (!condition) {
    condition = new Condition(conditionId);
    condition.token0Id = event.params.token0;
    condition.token1Id = event.params.token1;
    condition.save();
  }

  const token0IndexId = tokenIndexId(conditionId, event.params.token0);
  let token0Index = TokenIndex.load(token0IndexId);
  if (!token0Index) {
    token0Index = new TokenIndex(token0IndexId);
    token0Index.condition = conditionId;
    token0Index.tokenId = event.params.token0;
    token0Index.lastPrice = BigInt.zero();
    token0Index.save();
  }

  const token1IndexId = tokenIndexId(conditionId, event.params.token1);
  let token1Index = TokenIndex.load(token1IndexId);
  if (!token1Index) {
    token1Index = new TokenIndex(token1IndexId);
    token1Index.condition = conditionId;
    token1Index.tokenId = event.params.token1;
    token1Index.lastPrice = BigInt.zero();
    token1Index.save();
  }
}
