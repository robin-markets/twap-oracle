import type { Hex } from "viem";

// ---- Constants ----

export const PRICE_SCALE = 1_000_000n;

// ---- Contract types ----

export interface TwapData {
  required: boolean;
  conditionId: Hex;
  startTimestamp: bigint;
  endTimestamp: bigint;
  twapPriceYes: bigint;
  marketEndedAt: bigint;
  marketEndYesPrice: bigint;
}

export interface SignedBatchTwapData {
  markets: TwapData[];
  signature: Hex;
}

// ---- Subgraph response types ----

export interface SubgraphTokenIndex {
  id: string;
  twapIndex: string;
  startedAt: string | null;
  lastUpdatedAt: string | null;
  lastPrice: string | null;
  resolvedAt: string | null;
  resolvedPrice: string | null;
}

export interface SubgraphMarket {
  id: string;
  yesToken: SubgraphTokenIndex;
  noToken: SubgraphTokenIndex;
  robinInitializedAt: string;
  twapSnapshotYes: string;
  twapSnapshotNo: string;
  robinTwapIndexYes: string | null;
  robinLastUpdatedAt: string | null;
  robinResolvedAt: string | null;
  robinResolvedYesPrice: string | null;
  robinResolvedNoPrice: string | null;
}

// ---- Polymarket types ----

export interface PolymarketMarketInfo {
  yesPrice?: number;
  noPrice?: number;
  resolved: boolean;
  resolvedYesPrice?: number;
  resolvedTimestamp?: number;
  yesTokenId: string;
}

// ---- API types ----

export interface TwapRequest {
  conditionIds: string[];
}

export interface TwapResponseMarket {
  required: boolean;
  conditionId: string;
  startTimestamp: string;
  endTimestamp: string;
  twapPriceYes: string;
  marketEndedAt: string;
  marketEndYesPrice: string;
}

export interface TwapResponse {
  markets: TwapResponseMarket[];
  signature: string;
}

// ---- Errors ----

export class TwapError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public details?: string,
  ) {
    super(message);
  }
}

export class ValidationError extends TwapError {
  constructor(message: string, details?: string) {
    super(message, 400, details);
  }
}

export class DataSourceError extends TwapError {
  constructor(message: string, details?: string) {
    super(message, 502, details);
  }
}
