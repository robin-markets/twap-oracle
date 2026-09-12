import { BigInt } from '@graphprotocol/graph-ts';
import { OrderFilled } from '../generated/CTFExchange/CTFExchange';
import { OrderFilled as NegRiskOrderFilled } from '../generated/NegRiskCTFExchange/NegRiskCTFExchange';
import { OrderFilled as OrderFilledV2 } from '../generated/CTFExchangeV2/CTFExchangeV2';
import { OrderFilled as NegRiskOrderFilledV2 } from '../generated/NegRiskCTFExchangeV2/CTFExchangeV2';
import { TokenIndex } from '../generated/schema';
import { COLLATERAL_ASSET_ID, PRICE_SCALE } from './utils';

// Side enum from the V2 exchange: 0 = BUY, 1 = SELL
const SIDE_BUY: i32 = 0;

function updateIndexWithPrice(tokenIndex: TokenIndex, price6: BigInt, timestamp: BigInt): void {
    if (tokenIndex.lastUpdatedAt === null || tokenIndex.lastPrice === null) {
        // First fill since tracking began. The token was only registered at Robin's
        // MarketInitialized, so no pre-init price is known for the gap between
        // `backfillFrom` and this fill. Price that gap at this fill's price
        // (an approximation of the last pre-init price that actually held).
        // `backfillFrom` is advanced by TwapUpdated snapshots taken before any
        // fill, so the backfill never reaches behind a snapshot already served.
        const gap = timestamp.minus(tokenIndex.backfillFrom);
        if (gap.gt(BigInt.zero())) {
            tokenIndex.twapIndex = tokenIndex.twapIndex.plus(price6.times(gap));
        }
        tokenIndex.startedAt = timestamp;
        tokenIndex.lastUpdatedAt = timestamp;
        tokenIndex.lastPrice = price6;
        tokenIndex.save();
        return;
    }

    const lastUpdatedAt = tokenIndex.lastUpdatedAt as BigInt;
    const timeElapsed = timestamp.minus(lastUpdatedAt);
    const lastPrice = tokenIndex.lastPrice as BigInt;
    tokenIndex.twapIndex = tokenIndex.twapIndex.plus(lastPrice.times(timeElapsed));
    tokenIndex.lastPrice = price6;
    tokenIndex.lastUpdatedAt = timestamp;
    tokenIndex.save();
}

function applyTrade(tokenId: BigInt, collateralAmount: BigInt, tokenAmount: BigInt, timestamp: BigInt, isV2: boolean): void {
    if (tokenAmount.equals(BigInt.zero())) {
        return;
    }

    // Only tokens registered by a Robin MarketInitialized event are tracked.
    // Fills for any other Polymarket token are ignored, which keeps the entity
    // count proportional to Robin markets rather than to all of Polymarket.
    const tokenIndex = TokenIndex.load(tokenId.toString());
    if (!tokenIndex) return;

    // Don't update the index if it has been resolved
    if (tokenIndex.resolvedAt !== null) return;

    if (isV2 && !tokenIndex.isV2) {
        tokenIndex.isV2 = true;
    }

    const price6 = collateralAmount.times(PRICE_SCALE).div(tokenAmount);
    updateIndexWithPrice(tokenIndex, price6, timestamp);
}

function processOrderFilled(
    timestamp: BigInt,
    makerAssetId: BigInt,
    takerAssetId: BigInt,
    makerAmountFilled: BigInt,
    takerAmountFilled: BigInt,
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

    applyTrade(tokenId, collateralAmount, tokenAmount, timestamp, false);
}

function processOrderFilledV2(timestamp: BigInt, side: i32, tokenId: BigInt, makerAmountFilled: BigInt, takerAmountFilled: BigInt): void {
    // V2 only emits OrderFilled for trades against collateral (outcome token <-> collateral).
    // BUY:  maker paid collateral, taker delivered the token -> collateral = makerAmountFilled, token = takerAmountFilled
    // SELL: maker paid the token, taker paid collateral     -> collateral = takerAmountFilled, token = makerAmountFilled
    let collateralAmount: BigInt;
    let tokenAmount: BigInt;
    if (side == SIDE_BUY) {
        collateralAmount = makerAmountFilled;
        tokenAmount = takerAmountFilled;
    } else {
        collateralAmount = takerAmountFilled;
        tokenAmount = makerAmountFilled;
    }

    applyTrade(tokenId, collateralAmount, tokenAmount, timestamp, true);
}

export function handleOrderFilled(event: OrderFilled): void {
    processOrderFilled(
        event.block.timestamp,
        event.params.makerAssetId,
        event.params.takerAssetId,
        event.params.makerAmountFilled,
        event.params.takerAmountFilled,
    );
}

export function handleNegRiskOrderFilled(event: NegRiskOrderFilled): void {
    processOrderFilled(
        event.block.timestamp,
        event.params.makerAssetId,
        event.params.takerAssetId,
        event.params.makerAmountFilled,
        event.params.takerAmountFilled,
    );
}

export function handleOrderFilledV2(event: OrderFilledV2): void {
    processOrderFilledV2(
        event.block.timestamp,
        event.params.side,
        event.params.tokenId,
        event.params.makerAmountFilled,
        event.params.takerAmountFilled,
    );
}

export function handleNegRiskOrderFilledV2(event: NegRiskOrderFilledV2): void {
    processOrderFilledV2(
        event.block.timestamp,
        event.params.side,
        event.params.tokenId,
        event.params.makerAmountFilled,
        event.params.takerAmountFilled,
    );
}
