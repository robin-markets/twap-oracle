import { BigInt, Bytes } from '@graphprotocol/graph-ts';
import { MarketInitialized, MarketFinalized, TwapUpdated } from '../generated/RobinTwapOracle/IRobinTwapOracle';
import { ConditionalTokens } from '../generated/RobinTwapOracle/ConditionalTokens';
import { Market, TokenIndex } from '../generated/schema';
import { CONDITIONAL_TOKENS, PRICE_SCALE } from './utils';

// Register a token for tracking. Tokens only exist for markets initialized on
// Robin; fills for anything else are ignored by the exchange handlers.
function getOrCreateTokenIndex(positionId: BigInt, timestamp: BigInt, isNegRisk: boolean): TokenIndex {
    const id = positionId.toString();
    let tokenIndex = TokenIndex.load(id);
    if (!tokenIndex) {
        tokenIndex = new TokenIndex(id);
        tokenIndex.twapIndex = BigInt.zero();
        tokenIndex.backfillFrom = timestamp;
        tokenIndex.isNegRisk = isNegRisk;
        tokenIndex.isV2 = false;
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
//
// A token with no fill yet has no price; its integral is whatever it is
// (zero) and the caller advances `backfillFrom` instead, so the eventual
// backfill by the first fill does not reach behind this snapshot.
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

// While a token has seen no fill since tracking began, every snapshot moves
// the start of the unpriced gap forward. The server prices such a window
// from its Polymarket fallback, so the first fill must not backfill it again.
function advanceBackfill(token: TokenIndex, anchor: BigInt): void {
    if (token.lastPrice !== null || token.resolvedAt !== null) return;
    if (anchor.le(token.backfillFrom)) return;
    token.backfillFrom = anchor;
    token.save();
}

// Markets can be initialized on Robin after they resolved on Polymarket
// (e.g. retroactively added). The ConditionResolution event was emitted
// before the token was tracked, so read the payout vector from the
// ConditionalTokens contract at the init block instead. The resolution
// timestamp is not stored on-chain; the init timestamp is used, which the
// server treats as "resolved before init" and clamps accordingly.
function applyPreInitResolution(conditionId: Bytes, yesToken: TokenIndex, noToken: TokenIndex, timestamp: BigInt): void {
    const ctf = ConditionalTokens.bind(CONDITIONAL_TOKENS);

    const denominator = ctf.try_payoutDenominator(conditionId);
    if (denominator.reverted || denominator.value.equals(BigInt.zero())) return;

    const yesNumerator = ctf.try_payoutNumerators(conditionId, BigInt.zero());
    const noNumerator = ctf.try_payoutNumerators(conditionId, BigInt.fromI32(1));
    if (yesNumerator.reverted || noNumerator.reverted) return;

    const sum = yesNumerator.value.plus(noNumerator.value);
    if (sum.equals(BigInt.zero())) return;

    yesToken.resolvedAt = timestamp;
    yesToken.resolvedPrice = yesNumerator.value.times(PRICE_SCALE).div(sum);
    yesToken.save();

    noToken.resolvedAt = timestamp;
    noToken.resolvedPrice = noNumerator.value.times(PRICE_SCALE).div(sum);
    noToken.save();
}

export function handleMarketInitialized(event: MarketInitialized): void {
    const conditionId = event.params.conditionId;
    const timestamp = event.block.timestamp;
    const yesPositionId = event.params.yesPositionId;
    const noPositionId = event.params.noPositionId;
    const isNegRisk = event.params.negRisk;

    // Register the tokens; from here on their fills are tracked.
    const yesToken = getOrCreateTokenIndex(yesPositionId, timestamp, isNegRisk);
    const noToken = getOrCreateTokenIndex(noPositionId, timestamp, isNegRisk);

    if (yesToken.resolvedAt === null && noToken.resolvedAt === null) {
        applyPreInitResolution(conditionId, yesToken, noToken, timestamp);
    }

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
        advanceBackfill(yesToken, anchor);
    }
    const noToken = TokenIndex.load(market.noToken);
    if (noToken) {
        market.twapSnapshotNo = snapshotTwapIndex(noToken, anchor);
        advanceBackfill(noToken, anchor);
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
