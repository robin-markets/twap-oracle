import { BigInt } from '@graphprotocol/graph-ts';
import { MarketInitialized, MarketFinalized, TwapUpdated } from '../generated/RobinTwapOracle/IRobinTwapOracle';
import { Market, TokenIndex } from '../generated/schema';
import { PRICE_SCALE } from './utils';

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

// Extrapolate (Estimate) a token's twapIndex to `anchor`
//
// Three cases:
//   1. Resolved → twapIndex is frozen, return as-is.
//   2. anchor > lastUpdatedAt (no in-window trade) → extrapolate forward
//      at lastPrice. EXACT, since price was lastPrice across the gap.
//   3. anchor ≤ lastUpdatedAt (one or more trades landed between data
//      fetch and TwapUpdated indexing) → roll back the integral by
//      lastPrice * (lastUpdatedAt − anchor). APPROXIMATE.
//
// Case 3 is approximate: rolls back with lastPrice (post-trade), but the
// price actually held across [anchor, lastUpdatedAt] was the pre-trade
// price, which is overwritten the moment the trade fires. Per-event error
// is (P_held − lastPrice) · gap and changes sign with the price-move
// direction, so it tends to average out across many events rather than
// drift one-sidedly.
function snapshotTwapIndex(token: TokenIndex, anchor: BigInt): BigInt {
    if (token.resolvedAt !== null) return token.twapIndex;
    if (token.lastUpdatedAt === null || token.lastPrice === null) return token.twapIndex;

    const lastUpdatedAt = token.lastUpdatedAt as BigInt;
    const lastPrice = token.lastPrice as BigInt;

    if (anchor.gt(lastUpdatedAt)) {
        // Forward extrapolation: exact.
        const gap = anchor.minus(lastUpdatedAt);
        return token.twapIndex.plus(lastPrice.times(gap));
    }

    // Backward roll-back: approximate (see header comment).
    const gap = lastUpdatedAt.minus(anchor);
    return token.twapIndex.minus(lastPrice.times(gap));
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
    // Contract uses block.timestamp as lastTwapUpdate at init (see
    // RobinTwapOracle.initializeMarket), so the snapshot anchor is timestamp.
    market.twapSnapshotYes = snapshotTwapIndex(yesToken, timestamp);
    market.twapSnapshotNo = snapshotTwapIndex(noToken, timestamp);

    market.save();
}

export function handleTwapUpdated(event: TwapUpdated): void {
    const conditionId = event.params.conditionId;
    const market = Market.load(conditionId.toHex());
    if (!market) return;

    const anchor = event.params.timestamp;

    market.robinLastUpdatedAt = anchor;
    market.robinTwapIndexYes = event.params.twapAccumulatorYes;

    // Snapshot current exchange twapIndex for next oracle computation (extrapolated)
    const yesToken = TokenIndex.load(market.yesToken);
    if (yesToken) {
        market.twapSnapshotYes = snapshotTwapIndex(yesToken, anchor);
    }
    const noToken = TokenIndex.load(market.noToken);
    if (noToken) {
        market.twapSnapshotNo = snapshotTwapIndex(noToken, anchor);
    }

    market.save();
}

export function handleMarketFinalized(event: MarketFinalized): void {
    const conditionId = event.params.conditionId;
    const market = Market.load(conditionId.toHex());
    if (!market) return;

    market.robinResolvedAt = event.params.marketEndedAt;
    market.robinResolvedYesPrice = event.params.marketEndYesPrice;
    market.robinResolvedNoPrice = PRICE_SCALE.minus(event.params.marketEndYesPrice);
    market.save();
}
