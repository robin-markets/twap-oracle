import { createPublicClient, http, type Hex, type PublicClient } from "viem";
import { polygon } from "viem/chains";

export interface RpcMarketState {
  lastTwapUpdate: bigint;
  twapAccumulatorYes: bigint;
  marketEndedAt: bigint;
  marketEndYesPrice: bigint;
  marketInitTimestamp: bigint;
}

export interface Eip712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: Hex;
}

// TODO store abi somewhere central when we have the mono repo
const oracleAbi = [
  {
    type: "function",
    name: "batchGetMarketState",
    inputs: [
      {
        name: "conditionIds",
        type: "bytes32[]",
      },
    ],
    outputs: [
      {
        name: "states",
        type: "tuple[]",
        internalType: "struct IRobinTwapOracle.MarketState[]",
        components: [
          { name: "twapAccumulatorYes", type: "uint128" },
          { name: "twapRequired", type: "bool" },
          { name: "marketEndYesPrice", type: "uint64" },
          { name: "marketEndedAt", type: "uint40" },
          { name: "marketInitTimestamp", type: "uint40" },
          { name: "lastTwapUpdate", type: "uint40" },
        ],
      },
      {
        name: "signatureRequired",
        type: "bool[]",
        internalType: "bool[]",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "eip712Domain",
    inputs: [],
    outputs: [
      { name: "fields", type: "bytes1" },
      { name: "name", type: "string" },
      { name: "version", type: "string" },
      { name: "chainId", type: "uint256" },
      { name: "verifyingContract", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "extensions", type: "uint256[]" },
    ],
    stateMutability: "view",
  },
] as const;

export class RpcDataSource {
  private client: PublicClient;
  private cachedDomain: Eip712Domain | null = null;

  constructor(
    rpcUrl: string,
    private oracleAddress: Hex,
  ) {
    this.client = createPublicClient({
      chain: polygon,
      transport: http(rpcUrl),
    });
  }

  /**
   * Fetch the EIP-712 domain from the oracle contract (EIP-5267).
   * Cached after the first call since the domain doesn't change.
   */
  async getEip712Domain(): Promise<Eip712Domain> {
    if (this.cachedDomain) return this.cachedDomain;

    const result = await this.client.readContract({
      address: this.oracleAddress,
      abi: oracleAbi,
      functionName: "eip712Domain",
    });

    const [, name, version, chainId, verifyingContract] = result;
    this.cachedDomain = {
      name,
      version,
      chainId: Number(chainId),
      verifyingContract: verifyingContract as Hex,
    };
    return this.cachedDomain;
  }

  /**
   * Batch-fetch market state + isTwapSignatureRequired for multiple markets
   * in a single contract call using the native batchGetMarketState view.
   */
  async getMarketStateBatch(
    conditionIds: Hex[],
  ): Promise<
    Map<string, { state: RpcMarketState; twapSignatureRequired: boolean }>
  > {
    if (conditionIds.length === 0) return new Map();

    const [states, signatureRequired] = await this.client.readContract({
      address: this.oracleAddress,
      abi: oracleAbi,
      functionName: "batchGetMarketState",
      args: [conditionIds],
    });

    const map = new Map<
      string,
      { state: RpcMarketState; twapSignatureRequired: boolean }
    >();

    for (let i = 0; i < conditionIds.length; i++) {
      const r = states[i];
      map.set(conditionIds[i], {
        state: {
          lastTwapUpdate: BigInt(r.lastTwapUpdate),
          twapAccumulatorYes: BigInt(r.twapAccumulatorYes),
          marketEndedAt: BigInt(r.marketEndedAt),
          marketEndYesPrice: BigInt(r.marketEndYesPrice),
          marketInitTimestamp: BigInt(r.marketInitTimestamp),
        },
        twapSignatureRequired: signatureRequired[i],
      });
    }

    return map;
  }
}
