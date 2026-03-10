import type { PolymarketDataSource } from "../datasources/polymarket.js";
import {
  PRICE_SCALE,
  ResolutionMismatchError,
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
 *
 * For each required market:
 *   1. Resolution check (HARD FAIL on any disagreement)
 *   2. TWAP comparison (soft warning if divergence > threshold)
 *
 * Blocks the response because resolution mismatches fail the request.
 */
export async function verifyTwapDataBatch(
  items: VerificationInput[],
  polymarket: PolymarketDataSource,
  config: VerificationConfig
): Promise<void> {
  const toVerify = items.filter((item) => item.twapData.required);
  if (toVerify.length === 0) return;

  // Batch-fetch market info for all markets
  const conditionIds = toVerify.map((item) => item.twapData.conditionId);
  let marketInfoMap;
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

    // ---- Resolution check (HARD FAIL) ----
    const subgraphResolved = item.twapData.marketEndedAt > 0n;
    const polyResolved = info.resolved;

    //TODO don't make these fail, just use the Polymarket API price
    if (subgraphResolved && !polyResolved) {
      const details =
        `Subgraph shows marketEndedAt=${item.twapData.marketEndedAt} ` +
        `but Polymarket shows market not resolved`;
      await sendNotification(
        `[CRITICAL] Resolution mismatch: ${conditionId} - ${details}`
      ).catch(() => {});
      throw new ResolutionMismatchError(conditionId, details);
    }

    if (!subgraphResolved && polyResolved) {
      const details =
        `Polymarket shows market as resolved ` +
        `but subgraph has no resolution data yet`;
      await sendNotification(
        `[CRITICAL] Resolution mismatch: ${conditionId} - ${details}`
      ).catch(() => {});
      throw new ResolutionMismatchError(conditionId, details);
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
        const details =
          `Resolution price mismatch: subgraph=${item.twapData.marketEndYesPrice}, ` +
          `polymarket=${polyPrice}`;
        await sendNotification(
          `[CRITICAL] Resolution mismatch: ${conditionId} - ${details}`
        ).catch(() => {});
        throw new ResolutionMismatchError(conditionId, details);
      }
    }

    // ---- TWAP comparison (soft warning) ----
    try {
      const twapResult = await polymarket.getTwapData(
        info.yesTokenId,
        Number(item.startTimestamp),
        Number(item.endTimestamp)
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
