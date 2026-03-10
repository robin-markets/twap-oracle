import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";
import { CTFExchange, OrderFilled } from "../generated/CTFExchange/CTFExchange";
import {
  NegRiskCTFExchange,
  OrderFilled as NegRiskOrderFilled,
} from "../generated/NegRiskCTFExchange/NegRiskCTFExchange";
import { TokenIndex, TokenLookup } from "../generated/schema";
import {
  COLLATERAL_ASSET_ID,
  COLLATERAL_USDCE,
  COLLATERAL_WCOL,
  PRICE_SCALE,
  tokenIndexId,
} from "./utils";
import { computePositionId } from "./ctf-utils";

function updateIndexWithPrice(
  tokenIndex: TokenIndex,
  price6: BigInt,
  timestamp: BigInt
): void {
  // On first update, we need to store the last price before we can update the index next time.
  if (tokenIndex.lastUpdatedAt === null || tokenIndex.lastPrice === null) {
    tokenIndex.startedAt = timestamp;
    tokenIndex.lastUpdatedAt = timestamp;
    tokenIndex.lastPrice = price6;
    tokenIndex.save();
    return;
  }

  const lastUpdatedAt = tokenIndex.lastUpdatedAt as BigInt; //already checked null above
  const timeElapsed = timestamp.minus(lastUpdatedAt);
  const lastPrice = tokenIndex.lastPrice as BigInt; //already checked null above
  tokenIndex.twapIndex = tokenIndex.twapIndex.plus(
    lastPrice.times(timeElapsed)
  );
  tokenIndex.lastPrice = price6;
  tokenIndex.lastUpdatedAt = timestamp;
  tokenIndex.save();
}

function ensureTokenIndexes(
  conditionId: Bytes,
  isNegRisk: boolean
): TokenIndex[] {
  const yesIndexId = tokenIndexId(conditionId, 0);
  let tokenIndexYes = TokenIndex.load(yesIndexId);
  const noIndexId = tokenIndexId(conditionId, 1);
  let tokenIndexNo = TokenIndex.load(noIndexId);

  const collateral = isNegRisk ? COLLATERAL_WCOL : COLLATERAL_USDCE;
  if (!tokenIndexYes) {
    const yesTokenId = computePositionId(collateral, conditionId, 0);
    tokenIndexYes = new TokenIndex(yesIndexId);
    tokenIndexYes.conditionId = conditionId;
    tokenIndexYes.tokenIndex = 0;
    tokenIndexYes.tokenId = yesTokenId;
    tokenIndexYes.twapIndex = BigInt.zero();
    tokenIndexYes.save();
  }
  if (!tokenIndexNo) {
    const noTokenId = computePositionId(collateral, conditionId, 1);
    tokenIndexNo = new TokenIndex(noIndexId);
    tokenIndexNo.conditionId = conditionId;
    tokenIndexNo.tokenIndex = 1;
    tokenIndexNo.tokenId = noTokenId;
    tokenIndexNo.twapIndex = BigInt.zero();
    tokenIndexNo.save();
  }
  return [tokenIndexYes, tokenIndexNo];
}

function getConditionId(
  contractAddress: Address,
  tokenId: BigInt,
  isNegRisk: boolean
): Bytes | null {
  const lookupId = tokenId.toString();
  const existingLookup = TokenLookup.load(lookupId);
  if (existingLookup) {
    return existingLookup.conditionId;
  }

  const contract = CTFExchange.bind(contractAddress); //Should work for NegRisk and non-NegRisk
  const negRiskContract = NegRiskCTFExchange.bind(contractAddress);
  const conditionResult = isNegRisk
    ? negRiskContract.try_getConditionId(tokenId)
    : contract.try_getConditionId(tokenId);
  let conditionId: Bytes | null = null;
  if (!conditionResult.reverted) {
    conditionId = conditionResult.value;
    const lookup = new TokenLookup(lookupId);
    lookup.conditionId = conditionId;
    lookup.save();
  }
  return conditionId;
}

function processOrderFilled(
  eventAddress: Address,
  timestamp: BigInt,
  makerAssetId: BigInt,
  takerAssetId: BigInt,
  makerAmountFilled: BigInt,
  takerAmountFilled: BigInt,
  isNegRisk: boolean
): void {
  let tokenId: BigInt;
  let collateralAmount: BigInt;
  let tokenAmount: BigInt;

  if (makerAssetId.equals(COLLATERAL_ASSET_ID)) {
    tokenId = takerAssetId;
    collateralAmount = makerAmountFilled;
    tokenAmount = takerAmountFilled;
  } else if (takerAssetId.equals(COLLATERAL_ASSET_ID)) {
    tokenId = makerAssetId;
    collateralAmount = takerAmountFilled;
    tokenAmount = makerAmountFilled;
  } else {
    return;
  }

  if (tokenAmount.equals(BigInt.zero())) {
    return;
  }

  const conditionId = getConditionId(eventAddress, tokenId, isNegRisk);
  if (conditionId === null) {
    return;
  }

  const indexes = ensureTokenIndexes(conditionId, isNegRisk);
  const yesIndex = indexes[0];
  const noIndex = indexes[1];

  let tokenIndex: TokenIndex | null = null;
  if (tokenId.equals(yesIndex.tokenId)) {
    tokenIndex = yesIndex;
  } else if (tokenId.equals(noIndex.tokenId)) {
    tokenIndex = noIndex;
  } else {
    return;
  }

  //Don't update the index if it has been resolved
  if (tokenIndex.resolvedAt !== null) return;

  const price6 = collateralAmount.times(PRICE_SCALE).div(tokenAmount);
  updateIndexWithPrice(tokenIndex, price6, timestamp);
}

export function handleOrderFilled(event: OrderFilled): void {
  processOrderFilled(
    event.address,
    event.block.timestamp,
    event.params.makerAssetId,
    event.params.takerAssetId,
    event.params.makerAmountFilled,
    event.params.takerAmountFilled,
    false
  );
}

export function handleNegRiskOrderFilled(event: NegRiskOrderFilled): void {
  processOrderFilled(
    event.address,
    event.block.timestamp,
    event.params.makerAssetId,
    event.params.takerAssetId,
    event.params.makerAmountFilled,
    event.params.takerAmountFilled,
    true
  );
}
