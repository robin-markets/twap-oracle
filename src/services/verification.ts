import type { IPolymarketDataSource } from "../datasources/polymarket.js";
import {
  PRICE_SCALE,
  type PolymarketMarketInfo,
  type TwapData,
} from "../types.js";
import { sendNotification } from "./notification.js";

export interface VerificationConfig {
  twapDivergenceThresholdPct: number;
}

export interface VerificationInput {
  twapData: TwapData;
  startTimestamp: bigint;
  endTimestamp: bigint;
}

/**
 * Verify subgraph-computed TwapData against Polymarket.
 * Mutates twapData in-place to correct mismatches (trusts API over subgraph).
 *
 * For each required market:
 *   1. Resolution check — corrects twapData from API if mismatched, notifies
 *   2. TWAP comparison — soft warning if divergence > threshold
 */
export async function verifyTwapDataBatch(
  items: VerificationInput[],
  polymarket: IPolymarketDataSource,
  config: VerificationConfig,
): Promise<void> {
  const toVerify = items.filter((item) => item.twapData.required);
  if (toVerify.length === 0) return;

  const conditionIds = toVerify.map((item) => item.twapData.conditionId);
  let marketInfoMap: Map<string, PolymarketMarketInfo>;
  try {
    marketInfoMap = await polymarket.getMarketInfoBatch(conditionIds);
  } catch (err) {
    await sendNotification(
      `[WARN] Polymarket verification unavailable: batch fetch failed. ` +
        `Error: ${err instanceof Error ? err.message : String(err)}`
    ).catch(() => {});
    return;
  }

  for (const item of toVerify) {
    const conditionId = item.twapData.conditionId;
    const info = marketInfoMap.get(conditionId);
    if (!info) {
      await sendNotification(
        `[WARN] Market ${conditionId} not found on Polymarket during verification`
      ).catch(() => {});
      continue;
    }

    // ---- Resolution check (correct from API if mismatched) ----
    const subgraphResolved = item.twapData.marketEndedAt > 0n;
    const polyResolved = info.resolved;

    if (subgraphResolved && !polyResolved) {
      await sendNotification(
        `[CRITICAL] Resolution mismatch for ${conditionId}: ` +
          `subgraph shows marketEndedAt=${item.twapData.marketEndedAt} ` +
          `but Polymarket shows not resolved. Clearing resolution data.`
      ).catch(() => {});
      item.twapData.marketEndedAt = 0n;
      item.twapData.marketEndYesPrice = 0n;
    }

    if (!subgraphResolved && polyResolved) {
      if (info.resolvedTimestamp && info.resolvedYesPrice !== undefined) {
        const polyPrice = BigInt(
          Math.round(info.resolvedYesPrice * Number(PRICE_SCALE))
        );
        await sendNotification(
          `[CRITICAL] Resolution mismatch for ${conditionId}: ` +
            `Polymarket shows resolved but subgraph has no resolution data. ` +
            `Using API resolution: endedAt=${info.resolvedTimestamp}, price=${polyPrice}.`
        ).catch(() => {});
        item.twapData.marketEndedAt = BigInt(info.resolvedTimestamp);
        item.twapData.marketEndYesPrice = polyPrice;
      } else {
        await sendNotification(
          `[WARN] Resolution mismatch for ${conditionId}: ` +
            `Polymarket shows resolved but missing timestamp or price. Skipping correction.`
        ).catch(() => {});
      }
    }

    if (
      subgraphResolved &&
      polyResolved &&
      info.resolvedYesPrice !== undefined
    ) {
      const polyPrice = BigInt(
        Math.round(info.resolvedYesPrice * Number(PRICE_SCALE))
      );
      if (polyPrice !== item.twapData.marketEndYesPrice) {
        await sendNotification(
          `[CRITICAL] Resolution price mismatch for ${conditionId}: ` +
            `subgraph=${item.twapData.marketEndYesPrice}, polymarket=${polyPrice}. ` +
            `Using API price.`
        ).catch(() => {});
        item.twapData.marketEndYesPrice = polyPrice;
      }
    }

    // ---- TWAP comparison (soft warning) ----
    try {
      // Clamp endTimestamp to market resolution time if resolved
      let clampedEnd = item.endTimestamp;
      if (info.resolved && info.resolvedTimestamp) {
        const resolvedTs = BigInt(info.resolvedTimestamp);
        if (resolvedTs < clampedEnd) {
          clampedEnd = resolvedTs;
        }
      }

      const twapResult = await polymarket.getTwapData(
        info.yesTokenId,
        Number(item.startTimestamp),
        Number(clampedEnd)
      );

      const subgraphTwap = Number(item.twapData.twapPriceYes);
      const polyTwap = Number(twapResult.twapPriceYes);

      if (subgraphTwap > 0 && polyTwap > 0) {
        const pctDiff =
          (Math.abs(subgraphTwap - polyTwap) /
            Math.max(subgraphTwap, polyTwap)) *
          100;
        if (pctDiff > config.twapDivergenceThresholdPct) {
          await sendNotification(
            `[WARN] TWAP divergence for ${conditionId}: ` +
              `subgraph=${subgraphTwap}, polymarket=${polyTwap}, ` +
              `diff=${pctDiff.toFixed(1)}% (threshold: ${
                config.twapDivergenceThresholdPct
              }%)`
          ).catch(() => {});
        }
      }
    } catch (err) {
      await sendNotification(
        `[WARN] Polymarket TWAP comparison failed for ${conditionId}: ` +
          `${err instanceof Error ? err.message : String(err)}`
      ).catch(() => {});
    }
  }
}
