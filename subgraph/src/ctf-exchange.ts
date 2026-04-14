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

function applyTrade(tokenId: BigInt, collateralAmount: BigInt, tokenAmount: BigInt, timestamp: BigInt, isNegRisk: boolean, isV2: boolean): void {
    if (tokenAmount.equals(BigInt.zero())) {
        return;
    }

    const positionId = tokenId.toString();
    let tokenIndex = TokenIndex.load(positionId);
    if (!tokenIndex) {
        tokenIndex = new TokenIndex(positionId);
        tokenIndex.twapIndex = BigInt.zero();
        tokenIndex.isNegRisk = isNegRisk;
        tokenIndex.isV2 = isV2;
    }

    // Don't update the index if it has been resolved
    if (tokenIndex.resolvedAt !== null) return;

    const price6 = collateralAmount.times(PRICE_SCALE).div(tokenAmount);
    updateIndexWithPrice(tokenIndex, price6, timestamp);
}

function processOrderFilled(
    timestamp: BigInt,
    makerAssetId: BigInt,
    takerAssetId: BigInt,
    makerAmountFilled: BigInt,
    takerAmountFilled: BigInt,
    isNegRisk: boolean,
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

    applyTrade(tokenId, collateralAmount, tokenAmount, timestamp, isNegRisk, false);
}

function processOrderFilledV2(
    timestamp: BigInt,
    side: i32,
    tokenId: BigInt,
    makerAmountFilled: BigInt,
    takerAmountFilled: BigInt,
    isNegRisk: boolean,
): void {
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

    applyTrade(tokenId, collateralAmount, tokenAmount, timestamp, isNegRisk, true);
}

export function handleOrderFilled(event: OrderFilled): void {
    processOrderFilled(
        event.block.timestamp,
        event.params.makerAssetId,
        event.params.takerAssetId,
        event.params.makerAmountFilled,
        event.params.takerAmountFilled,
        false,
    );
}

export function handleNegRiskOrderFilled(event: NegRiskOrderFilled): void {
    processOrderFilled(
        event.block.timestamp,
        event.params.makerAssetId,
        event.params.takerAssetId,
        event.params.makerAmountFilled,
        event.params.takerAmountFilled,
        true,
    );
}

export function handleOrderFilledV2(event: OrderFilledV2): void {
    processOrderFilledV2(
        event.block.timestamp,
        event.params.side,
        event.params.tokenId,
        event.params.makerAmountFilled,
        event.params.takerAmountFilled,
        false,
    );
}

export function handleNegRiskOrderFilledV2(event: NegRiskOrderFilledV2): void {
    processOrderFilledV2(
        event.block.timestamp,
        event.params.side,
        event.params.tokenId,
        event.params.makerAmountFilled,
        event.params.takerAmountFilled,
        true,
    );
}
