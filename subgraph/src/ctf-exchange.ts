import { BigInt } from '@graphprotocol/graph-ts';
import { OrderFilled } from '../generated/CTFExchange/CTFExchange';
import { OrderFilled as NegRiskOrderFilled } from '../generated/NegRiskCTFExchange/NegRiskCTFExchange';
import { TokenIndex } from '../generated/schema';
import { COLLATERAL_ASSET_ID, PRICE_SCALE } from './utils';

function updateIndexWithPrice(tokenIndex: TokenIndex, price6: BigInt, timestamp: BigInt): void {
    // On first update, we need to store the last price before we can update the index next time.
    if (tokenIndex.lastUpdatedAt === null || tokenIndex.lastPrice === null) {
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

    if (tokenAmount.equals(BigInt.zero())) {
        return;
    }

    const positionId = tokenId.toString();
    let tokenIndex = TokenIndex.load(positionId);
    if (!tokenIndex) {
        tokenIndex = new TokenIndex(positionId);
        tokenIndex.twapIndex = BigInt.zero();
    }

    // Don't update the index if it has been resolved
    if (tokenIndex.resolvedAt !== null) return;

    const price6 = collateralAmount.times(PRICE_SCALE).div(tokenAmount);
    updateIndexWithPrice(tokenIndex, price6, timestamp);
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
