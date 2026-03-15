import { Address, BigInt, Bytes } from '@graphprotocol/graph-ts';
import { ConditionResolution as ConditionResolutionEvent } from '../generated/ConditionalTokens/ConditionalTokens';
import { TokenIndex } from '../generated/schema';
import { COLLATERAL_USDCE, COLLATERAL_WCOL, PRICE_SCALE } from './utils';
import { computePositionId } from './ctf-utils';

function closeTwap(tokenIndex: TokenIndex, resolvedPrice: BigInt, timestamp: BigInt): void {
    tokenIndex.resolvedAt = timestamp;
    tokenIndex.resolvedPrice = resolvedPrice;

    if (tokenIndex.lastUpdatedAt !== null && tokenIndex.lastPrice !== null) {
        const lastUpdatedAt = tokenIndex.lastUpdatedAt as BigInt;
        const timeElapsed = timestamp.minus(lastUpdatedAt);
        const lastPrice = tokenIndex.lastPrice as BigInt;
        tokenIndex.twapIndex = tokenIndex.twapIndex.plus(lastPrice.times(timeElapsed));
        tokenIndex.lastUpdatedAt = timestamp;
    }

    tokenIndex.save();
}

function tryCloseTokens(conditionId: Bytes, collateral: Address, yesPrice: BigInt, noPrice: BigInt, timestamp: BigInt): boolean {
    const yesPositionId = computePositionId(collateral, conditionId, 0).toString();
    const yesToken = TokenIndex.load(yesPositionId);
    if (!yesToken) return false;

    closeTwap(yesToken, yesPrice, timestamp);

    const noPositionId = computePositionId(collateral, conditionId, 1).toString();
    const noToken = TokenIndex.load(noPositionId);
    if (noToken) {
        closeTwap(noToken, noPrice, timestamp);
    }

    return true;
}

export function handleConditionResolution(event: ConditionResolutionEvent): void {
    const conditionId = event.params.conditionId;
    const numerators = event.params.payoutNumerators;
    if (numerators.length < 2) {
        return;
    }

    const sum = numerators[0].plus(numerators[1]);
    if (sum.equals(BigInt.zero())) {
        return;
    }

    const yesPrice = numerators[0].times(PRICE_SCALE).div(sum);
    const noPrice = numerators[1].times(PRICE_SCALE).div(sum);

    // Close TWAP on TokenIndex entities — try both collateral tokens
    if (!tryCloseTokens(conditionId, COLLATERAL_USDCE, yesPrice, noPrice, event.block.timestamp)) {
        tryCloseTokens(conditionId, COLLATERAL_WCOL, yesPrice, noPrice, event.block.timestamp);
    }
}
