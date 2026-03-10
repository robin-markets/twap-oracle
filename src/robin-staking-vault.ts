import { BigInt } from "@graphprotocol/graph-ts";
import {
  MarketInitialized,
  MarketFinalized,
  TwapUpdated,
} from "../generated/RobinStakingVault/RobinStakingVault";
import { Market, TokenIndex } from "../generated/schema";
import { PRICE_SCALE } from "./utils";

function getOrCreateTokenIndex(positionId: BigInt): TokenIndex {
  const id = positionId.toString();
  let tokenIndex = TokenIndex.load(id);
  if (!tokenIndex) {
    tokenIndex = new TokenIndex(id);
    tokenIndex.twapIndex = BigInt.zero();
    tokenIndex.save();
  }
  return tokenIndex;
}

export function handleMarketInitialized(event: MarketInitialized): void {
  const conditionId = event.params.conditionId;
  const timestamp = event.block.timestamp;
  const yesPositionId = event.params.yesPositionId;
  const noPositionId = event.params.noPositionId;

  // Ensure TokenIndex entities exist
  const yesToken = getOrCreateTokenIndex(yesPositionId);
  const noToken = getOrCreateTokenIndex(noPositionId);

  const marketId = conditionId.toHex();
  const market = new Market(marketId);
  market.yesToken = yesToken.id;
  market.noToken = noToken.id;
  market.robinInitializedAt = timestamp;
  market.twapIndexAtInitYes = yesToken.twapIndex;
  market.twapIndexAtInitNo = noToken.twapIndex;

  market.save();
}

export function handleTwapUpdated(event: TwapUpdated): void {
  const conditionId = event.params.conditionId;
  const market = Market.load(conditionId.toHex());
  if (!market) return;

  market.robinLastUpdatedAt = event.params.timestamp;
  market.robinTwapIndexYes = event.params.twapAccumulatorYes;
  market.save();
}

export function handleMarketFinalized(event: MarketFinalized): void {
  const conditionId = event.params.conditionId;
  const market = Market.load(conditionId.toHex());
  if (!market) return;

  market.robinResolvedAt = event.params.marketEndedAt;
  market.robinResolvedYesPrice = event.params.marketEndYesPrice;
  market.robinResolvedNoPrice = PRICE_SCALE.minus(
    event.params.marketEndYesPrice
  );
  market.save();
}
