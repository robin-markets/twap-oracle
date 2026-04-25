import { Router, type Request, type Response } from 'express';
import type { Hex } from 'viem';
import type { Config } from '../config.js';
import { fetchMarkets } from '../datasources/subgraph.js';
import { CachedPolymarketDataSource, PolymarketDataSource, type IPolymarketDataSource } from '../datasources/polymarket.js';
import { RpcDataSource } from '../datasources/rpc.js';
import { computeTwapData, needsFallbackPrice } from '../services/twap-computation.js';
import { computeAlternativeTwapDataBatch } from '../services/alternative-twap.js';
import { verifyTwapDataBatch } from '../services/verification.js';
import { signBatchTwapData } from '../services/signing.js';
import { sendNotification } from '../services/notification.js';
import {
    PRICE_SCALE,
    DataSourceError,
    ValidationError,
    TwapError,
    type TwapData,
    type TwapRequest,
    type TwapResponse,
    type TwapResponseFailed,
    type SubgraphMarket,
} from '../types.js';

const BYTES32_REGEX = /^0x[0-9a-f]{64}$/i;
const MAX_CONDITION_IDS = 25;
const TIME_TO_SUBMIT_ONCHAIN = 10; // seconds

interface HandlerResult {
    twapData: TwapData[];
    failed: TwapResponseFailed[];
    needsInit: Set<string>;
}

export function createTwapRouter(config: Config): Router {
    const router = Router();
    const polymarket = new PolymarketDataSource();
    // Wallet is always configured: even in off-chain mode we fire vault
    // initializeMarket calls in the background so frontend staking isn't
    // blocked waiting for the next TWAP cycle to bundle them.
    const rpc = new RpcDataSource(
        config.rpcUrl,
        config.oracleAddress,
        config.vaultAddress,
        config.twapSignerPrivateKey,
    );

    router.get('/prices', async (req: Request, res: Response) => {
        try {
            const raw = req.query.conditionIds;
            if (!raw || typeof raw !== 'string') {
                throw new ValidationError('conditionIds query parameter is required (comma-separated)');
            }

            const conditionIds = raw.split(',').map(id => {
                const normalized = id.trim().toLowerCase();
                if (!BYTES32_REGEX.test(normalized)) {
                    throw new ValidationError(`Invalid conditionId format: ${id}`, 'Must be a 0x-prefixed 64-character hex string (bytes32)');
                }
                return normalized;
            });

            if (conditionIds.length === 0) {
                throw new ValidationError('conditionIds must not be empty');
            }
            if (conditionIds.length > MAX_CONDITION_IDS) {
                throw new ValidationError(`Too many conditionIds (max ${MAX_CONDITION_IDS})`);
            }

            // Fetch from subgraph
            const fetchResult = await fetchMarkets(config.subgraphUrl, conditionIds);
            const endTimestamp = BigInt(fetchResult.blockTimestamp);
            const marketMap = new Map(fetchResult.markets.map(m => [m.id, m]));

            const results: Array<{
                conditionId: string;
                twapPriceYes: string;
                startTimestamp: string;
                endTimestamp: string;
                required: boolean;
                marketEndedAt: string;
                marketEndYesPrice: string;
            }> = [];
            const failed: TwapResponseFailed[] = [];

            for (const id of conditionIds) {
                const market = marketMap.get(id);
                if (!market) {
                    failed.push({ conditionId: id, error: 'Market not found in subgraph' });
                    continue;
                }
                try {
                    const twapData = computeTwapData(market, endTimestamp);
                    results.push({
                        conditionId: twapData.conditionId,
                        twapPriceYes: twapData.twapPriceYes.toString(),
                        startTimestamp: twapData.startTimestamp.toString(),
                        endTimestamp: twapData.endTimestamp.toString(),
                        required: twapData.required,
                        marketEndedAt: twapData.marketEndedAt.toString(),
                        marketEndYesPrice: twapData.marketEndYesPrice.toString(),
                    });
                } catch (err) {
                    failed.push({ conditionId: id, error: err instanceof Error ? err.message : String(err) });
                }
            }

            if (results.length === 0) {
                res.status(404).json({ error: 'No TWAP data available for any of the requested markets', failed });
                return;
            }

            res.json({ markets: results, failed });
        } catch (err) {
            if (err instanceof TwapError) {
                res.status(err.statusCode).json({ error: err.message, details: err.details });
            } else {
                console.error('Unexpected error:', err);
                res.status(500).json({ error: 'Internal server error' });
            }
        }
    });

    router.post('/', async (req: Request, res: Response) => {
        try {
            const body = req.body as TwapRequest;

            // ---- Validation ----
            if (!body.conditionIds || !Array.isArray(body.conditionIds)) {
                throw new ValidationError('conditionIds must be a non-empty array');
            }
            if (body.conditionIds.length === 0) {
                throw new ValidationError('conditionIds must not be empty');
            }
            if (body.conditionIds.length > MAX_CONDITION_IDS) {
                throw new ValidationError(`Too many conditionIds (max ${MAX_CONDITION_IDS})`);
            }

            const conditionIds = body.conditionIds.map(id => {
                const normalized = id.toLowerCase();
                if (!BYTES32_REGEX.test(normalized)) {
                    throw new ValidationError(`Invalid conditionId format: ${id}`, 'Must be a 0x-prefixed 64-character hex string (bytes32)');
                }
                return normalized;
            });

            const nowSeconds = Math.floor(Date.now() / 1000);
            const cachedPolymarket = new CachedPolymarketDataSource(polymarket);

            // ---- Attempt subgraph fetch ----
            let subgraphMarkets: SubgraphMarket[] | null = null;
            let subgraphBlockTimestamp: number | null = null;
            let subgraphFailed = false;

            try {
                const fetchResult = await fetchMarkets(config.subgraphUrl, conditionIds);
                const subgraphLag = nowSeconds - fetchResult.blockTimestamp;

                //If the subgraph is behind more than the grace period allows, the stake/withdraw will revert. (include some time for the transaction to go through)
                if (subgraphLag > Math.abs(config.twapGracePeriodSeconds - TIME_TO_SUBMIT_ONCHAIN)) {
                    subgraphFailed = true;
                    sendNotification(
                        `[ALERT] Subgraph too far behind (${subgraphLag}s lag, grace period ${config.twapGracePeriodSeconds}s minus ${TIME_TO_SUBMIT_ONCHAIN}s for transaction), ` +
                            `falling back to RPC+Polymarket for all ${conditionIds.length} markets.`,
                    ).catch(() => {});
                } else {
                    subgraphMarkets = fetchResult.markets;
                    subgraphBlockTimestamp = fetchResult.blockTimestamp;
                }
            } catch (err) {
                subgraphFailed = true;
                let message = '';
                if (err instanceof DataSourceError) {
                    message = `Error: ${err.message}`;
                } else {
                    message = `Unknown error: ${err instanceof Error ? err.message : String(err)}`;
                }
                sendNotification(
                    `[ALERT] Subgraph completely unavailable, falling back to RPC+Polymarket ` +
                        `for all ${conditionIds.length} markets. Error: ${message}`,
                ).catch(() => {});
            }

            let result: HandlerResult;

            if (subgraphFailed || subgraphMarkets === null) {
                // ===== FLOW C: Complete subgraph failure — use Date.now() =====
                result = await handleCompleteFailure(conditionIds, BigInt(nowSeconds), rpc, cachedPolymarket);
            } else {
                // ===== FLOW A/B: Subgraph returned data — use subgraph block timestamp =====
                const endTimestamp = BigInt(subgraphBlockTimestamp!);
                result = await handleSubgraphData(conditionIds, endTimestamp, subgraphMarkets, rpc, cachedPolymarket, config);
            }

            // ---- Check for failures ----
            if (result.failed.length > 0) {
                sendNotification(
                    `[CRITICAL] ${result.failed.length}/${conditionIds.length} markets failed: ` +
                        result.failed.map(f => `${f.conditionId}: ${f.error}`).join('; '),
                ).catch(() => {});
                res.status(500).json({
                    error: 'Some markets could not be computed',
                    failed: result.failed,
                });
                return;
            }

            // ---- Sign and respond ----
            const domain = await rpc.getEip712Domain();
            const signed = await signBatchTwapData(result.twapData, config.twapSignerPrivateKey, domain);

            // Skip on-chain submission entirely if every market is a no-op
            // (not initialized, already finalized in contract, or signature not required
            // and not finalizing). The contract would silently skip them all anyway.
            const allNoOp = signed.markets.every(m => !m.required && m.marketEndedAt === 0n);
            const initIds = Array.from(result.needsInit) as Hex[];
            const hasWork = !allNoOp || initIds.length > 0;

            if (config.submitOnchain && hasWork) {
                // ---- Submit on-chain (bundled with vault inits if any) ----
                const twapPayload = allNoOp ? null : { markets: signed.markets, signature: signed.signature };
                const txHash = await rpc.submitTwap(twapPayload, initIds);
                res.json({ txHash, initialized: initIds.length });
                console.log(`Submitted on-chain: ${txHash} (twap=${!allNoOp}, inits=${initIds.length})`);
            } else if (config.submitOnchain && !hasWork) {
                console.log(`Skipped on-chain submission: all ${signed.markets.length} markets are no-op`);
                res.json({ txHash: null, skipped: true, reason: 'all markets are no-op' });
            } else {
                // ---- Return signed data for caller to submit ----
                // Fire vault inits in the background (no await) so the response
                // isn't delayed — frontend staking proceeds immediately while
                // initializeMarket lands a few seconds later.
                if (initIds.length > 0) {
                    rpc.submitTwap(null, initIds).then(
                        txHash => console.log(`Background init submitted: ${txHash} (${initIds.length} markets)`),
                        err => {
                            const msg = err instanceof Error ? err.message : String(err);
                            console.error(`Background init failed (${initIds.length} markets):`, err);
                            sendNotification(`[WARN] Background init failed for ${initIds.length} markets: ${msg}`).catch(() => {});
                        },
                    );
                }

                const response: TwapResponse = {
                    markets: signed.markets.map(m => ({
                        required: m.required,
                        conditionId: m.conditionId,
                        startTimestamp: m.startTimestamp.toString(),
                        endTimestamp: m.endTimestamp.toString(),
                        twapPriceYes: m.twapPriceYes.toString(),
                        marketEndedAt: m.marketEndedAt.toString(),
                        marketEndYesPrice: m.marketEndYesPrice.toString(),
                    })),
                    signature: signed.signature,
                    failed: [],
                };
                res.json(response);
            }
        } catch (err) {
            sendNotification(
                `[CRITICAL] Unrecoverable TWAP oracle failure at signing: ` + `${err instanceof Error ? err.message : String(err)}`,
            ).catch(() => {});
            if (err instanceof TwapError) {
                res.status(err.statusCode).json({ error: err.message, details: err.details });
                console.error('Error:', err);
            } else {
                console.error('Unexpected error:', err);
                res.status(500).json({ error: 'Internal server error' });
            }
        }
    });

    return router;
}

/**
 * Flow C: Subgraph completely unavailable.
 * Compute all TwapData from RPC + Polymarket.
 */
async function handleCompleteFailure(
    conditionIds: string[],
    endTimestamp: bigint,
    rpc: RpcDataSource,
    polymarket: IPolymarketDataSource,
): Promise<HandlerResult> {
    const failed: TwapResponseFailed[] = [];

    let altBatch;
    try {
        altBatch = await computeAlternativeTwapDataBatch(conditionIds, endTimestamp, rpc, polymarket);
    } catch (err) {
        // Batch-level failure (RPC or Polymarket down) — all markets fail
        const message = err instanceof Error ? err.message : String(err);
        return {
            twapData: [],
            failed: conditionIds.map(id => ({ conditionId: id, error: message })),
            needsInit: new Set(),
        };
    }

    for (const [id, message] of altBatch.failed) {
        failed.push({ conditionId: id, error: message });
    }

    const twapData = conditionIds.filter(id => altBatch.results.has(id)).map(id => altBatch.results.get(id)!);

    return { twapData, failed, needsInit: altBatch.needsInit };
}

/**
 * Flow A/B: Subgraph returned data.
 * Use subgraph for found markets, RPC+Polymarket for missing ones.
 * Verify subgraph-sourced markets against Polymarket.
 */
async function handleSubgraphData(
    conditionIds: string[],
    endTimestamp: bigint,
    subgraphMarkets: SubgraphMarket[],
    rpc: RpcDataSource,
    polymarket: IPolymarketDataSource,
    config: Config,
): Promise<HandlerResult> {
    const marketMap = new Map(subgraphMarkets.map(m => [m.id, m]));
    const foundIds = conditionIds.filter(id => marketMap.has(id));
    const missingIds = conditionIds.filter(id => !marketMap.has(id));
    const failed: TwapResponseFailed[] = [];

    // ---- Compute TwapData for subgraph markets ----
    const needsFallbackIds = foundIds.filter(id => needsFallbackPrice(marketMap.get(id)!, endTimestamp));

    let fallbackMap = new Map<string, bigint>();
    if (needsFallbackIds.length > 0) {
        try {
            const infoMap = await polymarket.getMarketInfoBatch(needsFallbackIds);
            for (const [id, info] of infoMap) {
                if (info.yesPrice === undefined) continue;
                fallbackMap.set(id, BigInt(Math.round(info.yesPrice * Number(PRICE_SCALE))));
            }
        } catch {
            // Best-effort — markets will use DEFAULT_PRICE
        }
    }

    const subgraphTwapMap = new Map<string, TwapData>();
    for (const id of foundIds) {
        const market = marketMap.get(id)!;
        const fallbackPrice = fallbackMap.get(id);
        try {
            const twapData = computeTwapData(market, endTimestamp, fallbackPrice);
            subgraphTwapMap.set(id, twapData);
        } catch (err) {
            failed.push({
                conditionId: id,
                error: err instanceof Error ? err.message : String(err),
            });
            continue;
        }

        // Notify about fallback usage
        if (needsFallbackPrice(market, endTimestamp)) {
            if (fallbackPrice !== undefined) {
                sendNotification(`[INFO] Market ${id}: used Polymarket spot price as fallback in subgraph TWAP computation`).catch(() => {});
            } else {
                sendNotification(`[WARN] Market ${id}: used DEFAULT_PRICE (50%) — Polymarket fallback also unavailable`).catch(() => {});
            }
        }
    }

    // ---- Handle missing markets (Flow B) ----
    let altTwapMap = new Map<string, TwapData>();
    let needsInit = new Set<string>();
    if (missingIds.length > 0) {
        sendNotification(
            `[ALERT] Subgraph partial failure: ${missingIds.length}/${conditionIds.length} markets missing ` +
                `(${missingIds.join(', ')}). Falling back to RPC+Polymarket.`,
        ).catch(() => {});

        try {
            const altBatch = await computeAlternativeTwapDataBatch(missingIds, endTimestamp, rpc, polymarket);

            for (const [id, message] of altBatch.failed) {
                failed.push({ conditionId: id, error: message });
            }

            for (const [id, result] of altBatch.results) {
                altTwapMap.set(id, result);
            }

            needsInit = altBatch.needsInit;
        } catch (err) {
            // Batch-level failure — all missing markets fail
            const message = err instanceof Error ? err.message : String(err);
            for (const id of missingIds) {
                failed.push({ conditionId: id, error: message });
            }
        }
    }

    // ---- Verify subgraph-sourced markets against Polymarket ----
    const verificationInputs = foundIds
        .filter(id => subgraphTwapMap.has(id) && subgraphTwapMap.get(id)!.required)
        .map(id => {
            const twapData = subgraphTwapMap.get(id)!;
            const market = marketMap.get(id)!;
            const startTimestamp = market.robinLastUpdatedAt !== null ? BigInt(market.robinLastUpdatedAt) : BigInt(market.robinInitializedAt);
            return { twapData, startTimestamp, endTimestamp };
        });

    // Fire-and-forget: verification is purely observational now (auto-correction
    // is disabled in verification.ts), so we don't need to block the response on it.
    // Errors only result in Telegram alerts; nothing throws into this scope.
    void verifyTwapDataBatch(verificationInputs, polymarket, {
        twapDivergenceThresholdPct: config.twapDivergenceThresholdPct,
    }).catch(err => {
        console.error('Background verification failed:', err);
    });

    // ---- Merge in request order (only successful markets) ----
    const twapData = conditionIds
        .filter(id => subgraphTwapMap.has(id) || altTwapMap.has(id))
        .map(id => subgraphTwapMap.get(id) ?? altTwapMap.get(id)!);

    return { twapData, failed, needsInit };
}
