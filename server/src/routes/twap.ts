import { Router, type Request, type Response } from "express";
import type { Config } from "../config.js";
import { fetchMarkets } from "../datasources/subgraph.js";
import { PolymarketDataSource } from "../datasources/polymarket.js";
import { RpcDataSource } from "../datasources/rpc.js";
import {
  computeTwapData,
  needsFallbackPrice,
} from "../services/twap-computation.js";
import { computeAlternativeTwapDataBatch } from "../services/alternative-twap.js";
import { verifyTwapDataBatch } from "../services/verification.js";
import { signBatchTwapData } from "../services/signing.js";
import { sendNotification } from "../services/notification.js";
import {
  PRICE_SCALE,
  DataSourceError,
  ValidationError,
  TwapError,
  type TwapData,
  type TwapRequest,
  type TwapResponse,
  type SubgraphMarket,
  PolymarketMarketInfo,
} from "../types.js";

const BYTES32_REGEX = /^0x[0-9a-f]{64}$/i;
const MAX_CONDITION_IDS = 50;

//TODO build the api in a way where the caller knows which conditionIds failed in case. So the user can remove that specific market in case of complete failure.
export function createTwapRouter(config: Config): Router {
  const router = Router();
  const polymarket = new PolymarketDataSource();
  const rpc = new RpcDataSource(config.rpcUrl, config.vaultAddress);

  router.post("/", async (req: Request, res: Response) => {
    try {
      const body = req.body as TwapRequest;

      // ---- Validation ----
      if (!body.conditionIds || !Array.isArray(body.conditionIds)) {
        throw new ValidationError("conditionIds must be a non-empty array");
      }
      if (body.conditionIds.length === 0) {
        throw new ValidationError("conditionIds must not be empty");
      }
      if (body.conditionIds.length > MAX_CONDITION_IDS) {
        throw new ValidationError(
          `Too many conditionIds (max ${MAX_CONDITION_IDS})`,
        );
      }

      const conditionIds = body.conditionIds.map((id) => {
        const normalized = id.toLowerCase();
        if (!BYTES32_REGEX.test(normalized)) {
          throw new ValidationError(
            `Invalid conditionId format: ${id}`,
            "Must be a 0x-prefixed 64-character hex string (bytes32)",
          );
        }
        return normalized;
      });

      const endTimestamp = BigInt(Math.floor(Date.now() / 1000));

      // ---- Attempt subgraph fetch ----
      let subgraphMarkets: SubgraphMarket[] | null = null;
      let subgraphFailed = false;

      try {
        subgraphMarkets = await fetchMarkets(config.subgraphUrl, conditionIds);
      } catch (err) {
        subgraphFailed = true;
        let message = "";
        if (err instanceof DataSourceError) {
          message = `Error: ${err.message}`;
        } else {
          message = `Unknown error: ${
            err instanceof Error ? err.message : String(err)
          }`;
        }
        sendNotification(
          `[ALERT] Subgraph completely unavailable, falling back to RPC+Polymarket ` +
            `for all ${conditionIds.length} markets. Error: ${message}`,
        ).catch(() => {});
      }

      let twapDataArray: TwapData[];

      if (subgraphFailed || subgraphMarkets === null) {
        // ===== FLOW C: Complete subgraph failure =====
        twapDataArray = await handleCompleteFailure(
          conditionIds,
          endTimestamp,
          rpc,
          polymarket,
        );
      } else {
        // ===== FLOW A/B: Subgraph returned data =====
        twapDataArray = await handleSubgraphData(
          conditionIds,
          endTimestamp,
          subgraphMarkets,
          rpc,
          polymarket,
          config,
        );
      }

      // ---- Sign and respond ----
      const signed = await signBatchTwapData(
        twapDataArray,
        config.twapSignerPrivateKey,
        config.chainId,
        config.vaultAddress,
      );

      const response: TwapResponse = {
        markets: signed.markets.map((m) => ({
          required: m.required,
          conditionId: m.conditionId,
          startTimestamp: m.startTimestamp.toString(),
          endTimestamp: m.endTimestamp.toString(),
          twapPriceYes: m.twapPriceYes.toString(),
          marketEndedAt: m.marketEndedAt.toString(),
          marketEndYesPrice: m.marketEndYesPrice.toString(),
        })),
        signature: signed.signature,
      };

      res.json(response);
    } catch (err) {
      sendNotification(
        `[CRITICAL] Unrecoverable TWAP oracle failure at signing: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      ).catch(() => {});
      if (err instanceof TwapError) {
        res
          .status(err.statusCode)
          .json({ error: err.message, details: err.details });
        console.error("Error:", err);
      } else {
        console.error("Unexpected error:", err);
        res.status(500).json({ error: "Internal server error" });
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
  polymarket: PolymarketDataSource,
): Promise<TwapData[]> {
  const altResults = await computeAlternativeTwapDataBatch(
    conditionIds,
    endTimestamp,
    rpc,
    polymarket,
  );

  for (const [id, result] of altResults) {
    if (result.usedPolymarketSpot) {
      sendNotification(
        `[WARN] Market ${id}: subgraph down, used Polymarket spot price (CLOB TWAP unavailable)`,
      ).catch(() => {});
    }
  }

  return conditionIds.map((id) => altResults.get(id)!.twapData);
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
  polymarket: PolymarketDataSource,
  config: Config,
): Promise<TwapData[]> {
  //TODO We are missing the check if twap is required overall? We might have to track twapRequirements in the subgraph (per market as well as globalls). Might be fine though because there is no harm in signing correct data if it is not used in the end
  const marketMap = new Map(subgraphMarkets.map((m) => [m.id, m]));
  const foundIds = conditionIds.filter((id) => marketMap.has(id));
  const missingIds = conditionIds.filter((id) => !marketMap.has(id));

  // ---- Compute TwapData for subgraph markets ----
  const needsFallbackIds = foundIds.filter((id) =>
    needsFallbackPrice(marketMap.get(id)!, endTimestamp),
  );

  let fallbackMap = new Map<string, bigint>();
  let polymarketInfoCache = new Map<string, PolymarketMarketInfo>();
  if (needsFallbackIds.length > 0) {
    try {
      const infoMap = await polymarket.getMarketInfoBatch(needsFallbackIds);
      for (const [id, info] of infoMap) {
        if (info.yesPrice === undefined) continue;
        fallbackMap.set(
          id,
          BigInt(Math.round(info.yesPrice * Number(PRICE_SCALE))),
        );
        polymarketInfoCache.set(id, info);
      }
    } catch {
      // Best-effort — markets will use DEFAULT_PRICE
    }
  }

  const subgraphTwapMap = new Map<string, TwapData>();
  for (const id of foundIds) {
    const market = marketMap.get(id)!;
    const fallbackPrice = fallbackMap.get(id);
    const twapData = computeTwapData(market, endTimestamp, fallbackPrice);
    subgraphTwapMap.set(id, twapData);

    // Notify about fallback usage
    if (needsFallbackPrice(market, endTimestamp)) {
      if (fallbackPrice !== undefined) {
        sendNotification(
          `[INFO] Market ${id}: used Polymarket spot price as fallback in subgraph TWAP computation`,
        ).catch(() => {});
      } else {
        sendNotification(
          `[WARN] Market ${id}: used DEFAULT_PRICE (50%) — Polymarket fallback also unavailable`,
        ).catch(() => {});
      }
    }
  }

  // ---- Handle missing markets (Flow B) ----
  let altTwapMap = new Map<string, TwapData>();
  if (missingIds.length > 0) {
    sendNotification(
      `[ALERT] Subgraph partial failure: ${missingIds.length}/${conditionIds.length} markets missing ` +
        `(${missingIds.join(", ")}). Falling back to RPC+Polymarket.`,
    ).catch(() => {});

    const altResults = await computeAlternativeTwapDataBatch(
      missingIds,
      endTimestamp,
      rpc,
      polymarket,
    );

    for (const [id, result] of altResults) {
      altTwapMap.set(id, result.twapData);
      if (result.usedPolymarketSpot) {
        sendNotification(
          `[WARN] Market ${id}: subgraph missing, used Polymarket spot price (CLOB TWAP unavailable)`,
        ).catch(() => {});
      }
    }
  }

  // ---- Verify subgraph-sourced markets against Polymarket ----
  const verificationInputs = foundIds
    .filter((id) => subgraphTwapMap.get(id)!.required)
    .map((id) => {
      const twapData = subgraphTwapMap.get(id)!;
      const market = marketMap.get(id)!;
      const startTimestamp =
        market.robinLastUpdatedAt !== null
          ? BigInt(market.robinLastUpdatedAt)
          : BigInt(market.robinInitializedAt);
      return { twapData, startTimestamp, endTimestamp };
    });

  await verifyTwapDataBatch(
    verificationInputs,
    polymarket,
    { twapDivergenceThresholdPct: config.twapDivergenceThresholdPct },
    polymarketInfoCache,
  );

  // ---- Merge in request order ----
  return conditionIds.map(
    (id) => subgraphTwapMap.get(id) ?? altTwapMap.get(id)!,
  );
}
