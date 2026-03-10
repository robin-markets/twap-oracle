import { createPublicClient, http, type Hex, type PublicClient } from "viem";
import { polygon } from "viem/chains";

export interface RpcMarketState {
  lastTwapUpdate: bigint;
  twapAccumulatorYes: bigint;
  marketEndedAt: bigint;
  marketEndYesPrice: bigint;
  twapRequired: boolean;
  marketInitTimestamp: bigint;
}

// ABI subset for the view functions we need
//TODO store abi somewhere else when we have the mono repo
const vaultAbi = [
  {
    type: "function",
    name: "getMarketState",
    inputs: [{ name: "conditionId", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "totalSharesYes", type: "uint256" },
          { name: "totalSharesNo", type: "uint256" },
          { name: "lossIndexYes", type: "uint128" },
          { name: "lossIndexNo", type: "uint128" },
          { name: "yieldPerShareYes", type: "uint128" },
          { name: "yieldPerShareNo", type: "uint128" },
          { name: "twapAccumulatorYes", type: "uint128" },
          { name: "lastYieldTwapCheckpointYes", type: "uint128" },
          { name: "marketInitTimestamp", type: "uint40" },
          { name: "lastTwapUpdate", type: "uint40" },
          { name: "lastYieldTimestamp", type: "uint40" },
          { name: "twapRequired", type: "bool" },
          { name: "yieldReductionFactor", type: "uint128" },
          { name: "marketPoolShares", type: "uint256" },
          { name: "principalContributed", type: "uint256" },
          { name: "marketEndedAt", type: "uint40" },
          { name: "marketEndYesPrice", type: "uint64" },
          { name: "totalWeightedSnapshotYes", type: "uint256" },
          { name: "totalWeightedSnapshotNo", type: "uint256" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "isMarketTwapRequired",
    inputs: [{ name: "conditionId", type: "bytes32" }],
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
  },
] as const;

export class RpcDataSource {
  private client: PublicClient;

  constructor(rpcUrl: string, private vaultAddress: Hex) {
    this.client = createPublicClient({
      chain: polygon,
      transport: http(rpcUrl),
    });
  }

  async getMarketState(conditionId: Hex): Promise<RpcMarketState> {
    const result = await this.client.readContract({
      address: this.vaultAddress,
      abi: vaultAbi,
      functionName: "getMarketState",
      args: [conditionId],
    });

    return {
      lastTwapUpdate: BigInt(result.lastTwapUpdate),
      twapAccumulatorYes: BigInt(result.twapAccumulatorYes),
      marketEndedAt: BigInt(result.marketEndedAt),
      marketEndYesPrice: BigInt(result.marketEndYesPrice),
      twapRequired: result.twapRequired,
      marketInitTimestamp: BigInt(result.marketInitTimestamp),
    };
  }

  //TODO we need isTwapSignatureRequired instead
  async isMarketTwapRequired(conditionId: Hex): Promise<boolean> {
    return this.client.readContract({
      address: this.vaultAddress,
      abi: vaultAbi,
      functionName: "isMarketTwapRequired",
      args: [conditionId],
    });
  }
}
