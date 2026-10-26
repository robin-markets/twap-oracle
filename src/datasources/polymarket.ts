import { sendNotification } from '../services/notification.js';
import { PRICE_SCALE, type PolymarketMarketInfo } from '../types.js';

const GAMMA_API_BASE = 'https://gamma-api.polymarket.com';
const DATA_API_BASE = 'https://data-api.polymarket.com/v2';

// The data-api prices-history endpoint caps explicit `start`/`end` windows at 15 days.
// Wider windows are only served by `interval=max`, which returns
// the market's whole life: buckets narrower than 3h then cover just the trailing 30 days, so
// whole-life requests use 3h buckets and the window is cut client-side.
const MAX_WINDOW_SECONDS = 15 * 24 * 60 * 60;
const WHOLE_LIFE_BUCKET_SECONDS = 3 * 60 * 60;
const PRICE_HISTORY_PAGE_LIMIT = 10000; // data-api cap per request

interface GammaResponse {
    markets: GammaMarketResponse[];
}
interface GammaMarketResponse {
    conditionId: string;
    /** "v1" = Conditional Tokens (what the subgraph indexes), "v2" = Polymarket Protocol V2 (PositionManager / ExchangeV3). */
    version?: string | null;
    outcomes: string; // JSON string like '["Yes", "No"]'
    outcomePrices: string; // JSON string like '["0.55","0.45"]'
    clobTokenIds: string | null; // JSON string like '["123...", "456..."]'; null on Protocol V2 markets
    active: boolean;
    closed: boolean;
    closedTime: string | null; // e.g. "2021-10-05 03:54:25+00"
}

interface PriceHistoryPoint {
    t: number;
    p: number;
}

/** One row of the data-api `GET /v2/prices-history` endpoint. */
interface DataApiPricePoint {
    timestamp: number;
    price: number;
    /** 0 for an exact tick (terminal observation, settlement payout), otherwise the bucket width. */
    resolution_seconds: number;
}

interface DataApiPriceHistoryResponse {
    data: DataApiPricePoint[] | null;
    pagination: { has_more: boolean; next_cursor: string | null };
}

/**
 * Polymarket API data source.
 *
 * - getMarketInfo: current price + resolution status from gamma-api.
 *   Used as fallback price for edge cases and to verify subgraph resolution data.
 *
 * - getTwapData: historical TWAP computed from data-api price-history samples.
 *   Primary failover when the subgraph is down or returning stale data.
 */
export interface IPolymarketDataSource {
    getMarketInfo(conditionId: string): Promise<PolymarketMarketInfo>;
    getMarketInfoBatch(conditionIds: string[]): Promise<Map<string, PolymarketMarketInfo>>;
    getTwapData(yesTokenId: string, startTime: number, endTime: number): Promise<{ twapPriceYes: bigint }>;
}

export class PolymarketDataSource implements IPolymarketDataSource {
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
     * Fetch raw gamma-api markets for a set of condition ids.
     *
     * The /markets endpoint now excludes closed markets by default, and there is no way to request
     * both open and closed markets for a set of condition ids in a single query. So every lookup
     * fires two requests in parallel — one with the default `closed` filter (open markets) and one
     * with `closed=true` (closed markets) — and merges the results. Closed markets matter here
     * because resolution status drives the oracle's resolved-price handling.
     */
    private async fetchMarkets(conditionIds: string[], closed?: boolean): Promise<GammaMarketResponse[]> {
        const params = [...conditionIds.map(id => `condition_ids=${id}`), ...(closed === undefined ? [] : [`closed=${closed}`])];
        const url = `${GAMMA_API_BASE}/markets/keyset?${params.join('&')}`;
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Gamma API error: ${response.status}`);
        }
        return ((await response.json()) as GammaResponse).markets;
    }

    /**
     * Fetch market info for multiple condition IDs in a single request.
     * Returns a map from conditionId to market info (missing markets are omitted).
     */
    async getMarketInfoBatch(conditionIds: string[]): Promise<Map<string, PolymarketMarketInfo>> {
        if (conditionIds.length === 0) return new Map();

        const [open, closed] = await Promise.all([this.fetchMarkets(conditionIds), this.fetchMarkets(conditionIds, true)]);

        // Dedupe by conditionId in case a market appears in both responses.
        const marketsByConditionId = new Map<string, GammaMarketResponse>();
        for (const market of [...open, ...closed]) marketsByConditionId.set(market.conditionId, market);
        const markets = Array.from(marketsByConditionId.values());
        const result = new Map<string, PolymarketMarketInfo>();

        for (const market of markets) {
            // Robin only tracks Conditional Tokens markets: the subgraph follows the CTF exchanges and the
            // CLOB fallback needs CTF token ids. A market Gamma reports as another protocol version has
            // moved its trading elsewhere (Polymarket Protocol V2), so its price data here would be stale.
            if (market.version != null && market.version !== 'v1') {
                sendNotification(
                    `[ALERT] Market ${market.conditionId} reports Polymarket protocol version "${market.version}" (not Conditional Tokens / v1): ` +
                        'its fills no longer flow through the CTF exchanges the TWAP subgraph indexes; skipping Polymarket fallback data',
                ).catch(() => {});
                continue;
            }
            if (typeof market.outcomes !== 'string' || typeof market.outcomePrices !== 'string' || typeof market.clobTokenIds !== 'string') {
                sendNotification(
                    `[WARN] Market ${market.conditionId} has no CTF outcome data on Polymarket (clobTokenIds=${market.clobTokenIds}); skipping`,
                ).catch(() => {});
                continue;
            }
            const outcomes = JSON.parse(market.outcomes) as string[];
            const prices = JSON.parse(market.outcomePrices) as string[];
            const tokenIds = JSON.parse(market.clobTokenIds) as string[];

            // Robin defines YES as outcome slot 0 (CTF index set 1) and NO as slot 1 regardless of
            // the labels: sports markets use team names ("Georgia"/"Oklahoma"), crypto markets
            // "Up"/"Down". Matching on a literal "Yes" label dropped every such market from this
            // map, which left the fallback price undefined and failed the TWAP computation.
            if (outcomes.length !== 2 || prices.length !== 2 || tokenIds.length !== 2) {
                sendNotification(`[WARN] Market ${market.conditionId} is not binary on Polymarket (outcomes=${market.outcomes}); skipping`).catch(
                    () => {},
                );
                continue;
            }

            const yesIdx = 0;
            const noIdx = 1;
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
                if (market.closedTime) {
                    const ms = new Date(market.closedTime).getTime();
                    if (!isNaN(ms)) {
                        resolvedTimestamp = Math.floor(ms / 1000);
                        resolvedYesPrice = yesPrice;
                    } else {
                        sendNotification(`[WARN] Market ${market.conditionId} closedTime is not a valid date: ${market.closedTime}`).catch(() => {});
                    }
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
     * Fetch one outcome token's price series from the data-api, oldest first, following the cursor
     * across pages. `params` carries `token_id` plus the window (`start`/`end` or `interval`).
     */
    private async fetchPriceHistory(params: URLSearchParams): Promise<PriceHistoryPoint[]> {
        const points: PriceHistoryPoint[] = [];
        let cursor: string | null = null;
        do {
            const page = new URLSearchParams(params);
            if (cursor) page.set('cursor', cursor);
            else page.set('limit', PRICE_HISTORY_PAGE_LIMIT.toString());

            const response = await fetch(`${DATA_API_BASE}/prices-history?${page}`);
            if (!response.ok) {
                throw new Error(`Price-history error: ${response.status}; ${await response.text()}`);
            }
            const body = (await response.json()) as DataApiPriceHistoryResponse;
            for (const row of body.data ?? []) points.push({ t: row.timestamp, p: row.price });
            cursor = body.pagination.next_cursor;
        } while (cursor);
        return points;
    }

    /**
     * Compute TWAP from data-api price history samples.
     * GET https://data-api.polymarket.com/v2/prices-history?token_id=<tokenId>&start=<start>&end=<end>
     *
     * Returns the time-weighted average YES price (0 to 1e6 scale).
     *
     * Windows up to 15 days are requested explicitly without `bucket_seconds`: the server picks the
     * finest grain that still covers the window. Wider windows exceed the endpoint's
     * cap, so the market's whole life is fetched at 3h buckets (the finest whole-life grain) and
     * cut to [startTime, endTime] here. Resolved markets end with a settlement point at the payout
     * price just before resolution; clamping endTime to the resolution time keeps it, weighted at
     * most like one bucket.
     *
     * @param yesTokenId - CLOB token ID for the YES outcome (from getMarketInfo)
     * @param startTime - Unix timestamp (seconds) for the start of the period
     * @param endTime - Unix timestamp (seconds) for the end of the period
     */
    async getTwapData(yesTokenId: string, startTime: number, endTime: number): Promise<{ twapPriceYes: bigint }> {
        const params = new URLSearchParams({ token_id: yesTokenId });
        if (endTime - startTime <= MAX_WINDOW_SECONDS) {
            params.set('start', startTime.toString());
            params.set('end', endTime.toString());
        } else {
            params.set('interval', 'max');
            params.set('bucket_seconds', WHOLE_LIFE_BUCKET_SECONDS.toString());
        }
        const history = await this.fetchPriceHistory(params);

        // Cut the series to the requested window. A whole-life series starts long before startTime:
        // the last sample at or before startTime is the price in force there, so it is carried
        // forward from startTime instead of extending the first in-window sample backwards.
        const inWindow = history.filter(pt => pt.t > startTime && pt.t <= endTime);
        const atStart = history.filter(pt => pt.t <= startTime).pop();
        const points = atStart ? [{ t: startTime, p: atStart.p }, ...inWindow] : inWindow;
        if (points.length === 0) {
            throw new Error('No price history data returned');
        }

        // Compute time-weighted average price.
        // Each sample holds from its timestamp until the next sample.
        // The first sample is extended back to startTime and the last forward to endTime
        let weightedSum = 0;
        let totalDuration = 0;

        for (let i = 0; i < points.length; i++) {
            const price = points[i].p;
            const t0 = i === 0 ? startTime : points[i].t;
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

/**
 * Request-scoped wrapper that caches getMarketInfoBatch results.
 * Create one per request; it is GC'd when the request finishes.
 * getTwapData is not cached (unique per token + time range).
 */
export class CachedPolymarketDataSource implements IPolymarketDataSource {
    private cache = new Map<string, PolymarketMarketInfo>();

    constructor(private inner: PolymarketDataSource) {}

    async getMarketInfo(conditionId: string): Promise<PolymarketMarketInfo> {
        const results = await this.getMarketInfoBatch([conditionId]);
        const info = results.get(conditionId);
        if (!info) {
            throw new Error(`Market not found on Polymarket: ${conditionId}`);
        }
        return info;
    }

    async getMarketInfoBatch(conditionIds: string[]): Promise<Map<string, PolymarketMarketInfo>> {
        const missing = conditionIds.filter(id => !this.cache.has(id));

        if (missing.length > 0) {
            const fetched = await this.inner.getMarketInfoBatch(missing);
            for (const [id, info] of fetched) {
                this.cache.set(id, info);
            }
        }

        const result = new Map<string, PolymarketMarketInfo>();
        for (const id of conditionIds) {
            const info = this.cache.get(id);
            if (info) result.set(id, info);
        }
        return result;
    }

    async getTwapData(yesTokenId: string, startTime: number, endTime: number): Promise<{ twapPriceYes: bigint }> {
        return this.inner.getTwapData(yesTokenId, startTime, endTime);
    }
}
