import { PRICE_SCALE, type PolymarketMarketInfo } from "../types.js";

const GAMMA_API_BASE = "https://gamma-api.polymarket.com";
const CLOB_API_BASE = "https://clob.polymarket.com";

const MAX_PRICE_HISTORY_POINTS = 100;

interface GammaMarketResponse {
  conditionId: string;
  outcomes: string; // JSON string like '["Yes", "No"]'
  outcomePrices: string; // JSON string like '["0.55","0.45"]'
  clobTokenIds: string; // JSON string like '["123...", "456..."]'
  active: boolean;
  closed: boolean;
  closedTime: string | null; // e.g. "2021-10-05 03:54:25+00"
}

interface PriceHistoryPoint {
  t: number;
  p: number;
}

interface PriceHistoryResponse {
  history: PriceHistoryPoint[];
}

/**
 * Polymarket API data source.
 *
 * - getMarketInfo: current price + resolution status from gamma-api.
 *   Used as fallback price for edge cases and to verify subgraph resolution data.
 *
 * - getTwapData: historical TWAP computed from CLOB price-history samples.
 *   Primary failover when the subgraph is down or returning stale data.
 */
export class PolymarketDataSource {
  /**
   * Fetch market info from gamma-api.
   * GET https://gamma-api.polymarket.com/markets?condition_ids=<id>
   */
  async getMarketInfo(conditionId: string): Promise<PolymarketMarketInfo> {
    const results = await this.getMarketInfoBatch([conditionId]);
    const info = results.get(conditionId);
    if (!info) {
      throw new Error(`Market not found on Polymarket: ${conditionId}`);
    }
    return info;
  }

  /**
   * Fetch market info for multiple condition IDs in a single request.
   * Returns a map from conditionId to market info (missing markets are omitted).
   */
  async getMarketInfoBatch(
    conditionIds: string[],
  ): Promise<Map<string, PolymarketMarketInfo>> {
    if (conditionIds.length === 0) return new Map();

    const url = `${GAMMA_API_BASE}/markets?condition_ids=${conditionIds.join(
      ",",
    )}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Gamma API error: ${response.status}`);
    }

    const markets = (await response.json()) as GammaMarketResponse[];
    const result = new Map<string, PolymarketMarketInfo>();

    for (const market of markets) {
      const outcomes = JSON.parse(market.outcomes) as string[];
      const prices = JSON.parse(market.outcomePrices) as string[];
      const tokenIds = JSON.parse(market.clobTokenIds) as string[];

      const yesIdx = outcomes.findIndex((o) => o.toLowerCase() === "yes");
      if (yesIdx === -1) continue;

      const noIdx = yesIdx === 0 ? 1 : 0;
      const rawYes = parseFloat(prices[yesIdx]);
      const rawNo = parseFloat(prices[noIdx]);

      // Validate prices: must parse and YES + NO ≈ 1 (within 15%)
      let yesPrice: number | undefined;
      let noPrice: number | undefined;
      if (!isNaN(rawYes) && !isNaN(rawNo)) {
        const sum = rawYes + rawNo;
        if (sum >= 0.85 && sum <= 1.15) {
          yesPrice = rawYes;
          noPrice = rawNo;
        }
      }

      const resolved = market.closed === true;
      let resolvedYesPrice: number | undefined;
      let resolvedTimestamp: number | undefined;
      if (resolved) {
        resolvedYesPrice = yesPrice;
        if (market.closedTime) {
          resolvedTimestamp = Math.floor(
            new Date(market.closedTime).getTime() / 1000,
          );
        }
      }

      result.set(market.conditionId, {
        yesPrice,
        noPrice,
        resolved,
        resolvedYesPrice,
        resolvedTimestamp,
        yesTokenId: tokenIds[yesIdx],
      });
    }

    return result;
  }

  /**
   * Compute TWAP from CLOB price history samples.
   * GET https://clob.polymarket.com/prices-history?market=<tokenId>&startTs=<start>&endTs=<end>&fidelity=1
   *
   * Returns the time-weighted average YES price (0 to 1e6 scale).
   *
   * @param yesTokenId - CLOB token ID for the YES outcome (from getMarketInfo)
   * @param startTime - Unix timestamp (seconds) for the start of the period
   * @param endTime - Unix timestamp (seconds) for the end of the period
   */
  async getTwapData(
    yesTokenId: string,
    startTime: number,
    endTime: number,
  ): Promise<{ twapPriceYes: bigint }> {
    const durationMinutes = (endTime - startTime) / 60;
    const fidelity = Math.max(
      1,
      Math.ceil(durationMinutes / MAX_PRICE_HISTORY_POINTS),
    );

    const params = new URLSearchParams({
      market: yesTokenId,
      startTs: startTime.toString(),
      endTs: endTime.toString(),
      fidelity: fidelity.toString(),
    });

    const url = `${CLOB_API_BASE}/prices-history?${params}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`CLOB price-history error: ${response.status}`);
    }

    const data = (await response.json()) as PriceHistoryResponse;
    if (!data.history || data.history.length === 0) {
      throw new Error("No price history data returned");
    }

    // Compute time-weighted average price.
    // Each sample holds from its timestamp until the next sample.
    const points = data.history;
    let weightedSum = 0;
    let totalDuration = 0;

    for (let i = 0; i < points.length; i++) {
      const price = points[i].p;
      const t0 = points[i].t;
      const t1 = i + 1 < points.length ? points[i + 1].t : endTime;
      const duration = t1 - t0;
      if (duration > 0) {
        weightedSum += price * duration;
        totalDuration += duration;
      }
    }

    if (totalDuration === 0) {
      // Single point or all same timestamp — use the last price
      const lastPrice = points[points.length - 1].p;
      return {
        twapPriceYes: BigInt(Math.round(lastPrice * Number(PRICE_SCALE))),
      };
    }

    const avgPrice = weightedSum / totalDuration;
    return {
      twapPriceYes: BigInt(Math.round(avgPrice * Number(PRICE_SCALE))),
    };
  }
}
