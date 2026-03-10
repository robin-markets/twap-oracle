import { Router, type Request, type Response } from "express";
import type { Config } from "../config.js";
import { fetchMarkets } from "../datasources/subgraph.js";
import { PolymarketDataSource } from "../datasources/polymarket.js";
import { computeTwapData } from "../services/twap-computation.js";
import { signBatchTwapData } from "../services/signing.js";
import {
  PRICE_SCALE,
  ValidationError,
  TwapError,
  type TwapRequest,
  type TwapResponse,
} from "../types.js";

const BYTES32_REGEX = /^0x[0-9a-f]{64}$/i;
const MAX_CONDITION_IDS = 50;

const polymarket = new PolymarketDataSource();

export function createTwapRouter(config: Config): Router {
  const router = Router();

  router.post("/", async (req: Request, res: Response) => {
    try {
      const body = req.body as TwapRequest;

      // Validate request
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

      // Normalize to lowercase (subgraph stores conditionId.toHex() which is lowercase)
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

      // Fetch market data from subgraph
      const markets = await fetchMarkets(config.subgraphUrl, conditionIds);

      // Build lookup map
      const marketMap = new Map(markets.map((m) => [m.id, m]));

      // Check all requested markets exist
      const missing = conditionIds.filter((id) => !marketMap.has(id));
      if (missing.length > 0) {
        throw new ValidationError(
          `Markets not found: ${missing.join(", ")}`,
          "These conditionIds are not initialized in the subgraph",
        );
      }

      // Fetch Polymarket prices as fallback (non-blocking, best-effort)
      const fallbackPrices = await Promise.all(
        conditionIds.map(async (id) => {
          try {
            const info = await polymarket.getMarketInfo(id);
            // Convert Polymarket price (0-1 float) to 6-decimal scale
            return BigInt(Math.round(info.yesPrice * Number(PRICE_SCALE)));
          } catch {
            return undefined;
          }
        }),
      );

      // Compute TwapData for each market in request order
      const twapDataArray = conditionIds.map((id, i) => {
        const market = marketMap.get(id)!;
        return computeTwapData(market, endTimestamp, fallbackPrices[i]);
      });

      // Sign the batch
      const signed = await signBatchTwapData(
        twapDataArray,
        config.twapSignerPrivateKey,
        config.chainId,
        config.vaultAddress,
      );

      // Serialize bigints to decimal strings for JSON
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
      if (err instanceof TwapError) {
        res
          .status(err.statusCode)
          .json({ error: err.message, details: err.details });
      } else {
        console.error("Unexpected error:", err);
        res.status(500).json({ error: "Internal server error" });
      }
    }
  });

  return router;
}
