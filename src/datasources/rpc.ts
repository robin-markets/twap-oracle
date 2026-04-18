import {
    createPublicClient,
    createWalletClient,
    encodeFunctionData,
    http,
    type Hex,
    type PublicClient,
    type WalletClient,
    type Transport,
    type Chain,
    type Account,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';
import type { TwapData } from '../types.js';

// Canonical Multicall3 address (same on most chains, including Polygon)
const MULTICALL3_ADDRESS: Hex = '0xcA11bde05977b3631167028862bE2a173976CA11';

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

const robinStakingVaultAbi = [
    {
        type: 'function',
        inputs: [{ name: 'conditionId', internalType: 'bytes32', type: 'bytes32' }],
        name: 'initializeMarket',
        outputs: [],
        stateMutability: 'nonpayable',
    },
] as const;

const multicall3Abi = [
    {
        inputs: [
            {
                components: [
                    { internalType: 'address', name: 'target', type: 'address' },
                    { internalType: 'bool', name: 'allowFailure', type: 'bool' },
                    { internalType: 'bytes', name: 'callData', type: 'bytes' },
                ],
                internalType: 'struct Multicall3.Call3[]',
                name: 'calls',
                type: 'tuple[]',
            },
        ],
        name: 'aggregate3',
        outputs: [
            {
                components: [
                    { internalType: 'bool', name: 'success', type: 'bool' },
                    { internalType: 'bytes', name: 'returnData', type: 'bytes' },
                ],
                internalType: 'struct Multicall3.Result[]',
                name: 'returnData',
                type: 'tuple[]',
            },
        ],
        stateMutability: 'payable',
        type: 'function',
    },
];

const oracleAbi = [
    {
        type: 'function',
        name: 'batchGetMarketState',
        inputs: [{ name: 'conditionIds', type: 'bytes32[]', internalType: 'bytes32[]' }],
        outputs: [
            {
                name: 'states',
                type: 'tuple[]',
                internalType: 'struct IRobinTwapOracle.MarketState[]',
                components: [
                    { name: 'twapAccumulatorYes', type: 'uint128', internalType: 'uint128' },
                    { name: 'twapRequired', type: 'bool', internalType: 'bool' },
                    { name: 'marketEndYesPrice', type: 'uint64', internalType: 'uint64' },
                    { name: 'marketEndedAt', type: 'uint40', internalType: 'uint40' },
                    { name: 'marketInitTimestamp', type: 'uint40', internalType: 'uint40' },
                    { name: 'lastTwapUpdate', type: 'uint40', internalType: 'uint40' },
                ],
            },
            { name: 'signatureRequired', type: 'bool[]', internalType: 'bool[]' },
        ],
        stateMutability: 'view',
    },
    {
        type: 'function',
        name: 'domainSeparator',
        inputs: [],
        outputs: [{ name: '', type: 'bytes32', internalType: 'bytes32' }],
        stateMutability: 'view',
    },
    {
        type: 'function',
        name: 'eip712Domain',
        inputs: [],
        outputs: [
            { name: 'fields', type: 'bytes1', internalType: 'bytes1' },
            { name: 'name', type: 'string', internalType: 'string' },
            { name: 'version', type: 'string', internalType: 'string' },
            { name: 'chainId', type: 'uint256', internalType: 'uint256' },
            { name: 'verifyingContract', type: 'address', internalType: 'address' },
            { name: 'salt', type: 'bytes32', internalType: 'bytes32' },
            { name: 'extensions', type: 'uint256[]', internalType: 'uint256[]' },
        ],
        stateMutability: 'view',
    },
    {
        type: 'function',
        name: 'submitTwap',
        inputs: [
            {
                name: 'twapData',
                type: 'tuple',
                internalType: 'struct DataTypes.BatchTwapData',
                components: [
                    {
                        name: 'markets',
                        type: 'tuple[]',
                        internalType: 'struct DataTypes.TwapData[]',
                        components: [
                            { name: 'required', type: 'bool', internalType: 'bool' },
                            { name: 'conditionId', type: 'bytes32', internalType: 'bytes32' },
                            { name: 'startTimestamp', type: 'uint256', internalType: 'uint256' },
                            { name: 'endTimestamp', type: 'uint256', internalType: 'uint256' },
                            { name: 'twapPriceYes', type: 'uint256', internalType: 'uint256' },
                            { name: 'marketEndedAt', type: 'uint256', internalType: 'uint256' },
                            { name: 'marketEndYesPrice', type: 'uint256', internalType: 'uint256' },
                        ],
                    },
                    { name: 'signature', type: 'bytes', internalType: 'bytes' },
                ],
            },
        ],
        outputs: [],
        stateMutability: 'nonpayable',
    },
] as const;

export class RpcDataSource {
    private client: PublicClient;
    private walletClient: WalletClient<Transport, Chain, Account> | null = null;
    private cachedDomain: Eip712Domain | null = null;

    constructor(
        rpcUrl: string,
        private oracleAddress: Hex,
        private vaultAddress: Hex,
        privateKey?: Hex,
    ) {
        const transport = http(rpcUrl);
        this.client = createPublicClient({
            chain: polygon,
            transport,
        });
        if (privateKey) {
            const account = privateKeyToAccount(privateKey);
            this.walletClient = createWalletClient({
                account,
                chain: polygon,
                transport,
            });
        }
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
            functionName: 'eip712Domain',
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
    async getMarketStateBatch(conditionIds: Hex[]): Promise<Map<string, { state: RpcMarketState; twapSignatureRequired: boolean }>> {
        if (conditionIds.length === 0) return new Map();

        const [states, signatureRequired] = await this.client.readContract({
            address: this.oracleAddress,
            abi: oracleAbi,
            functionName: 'batchGetMarketState',
            args: [conditionIds],
        });

        const map = new Map<string, { state: RpcMarketState; twapSignatureRequired: boolean }>();

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

    /**
     * Submit signed TWAP data on-chain. If `initConditionIds` is non-empty,
     * the call is bundled with vault `initializeMarket` calls via Multicall3
     * so everything lands in a single transaction. Init calls allow failure
     * (we still want the TWAP to land if a market was initialized in a race).
     *
     * Pass `twap = null` to only run inits (no TWAP submission).
     */
    async submitTwap(twap: { markets: TwapData[]; signature: Hex } | null, initConditionIds: Hex[] = []): Promise<Hex> {
        if (!this.walletClient) {
            throw new Error('Cannot submit on-chain: wallet client not configured (missing private key)');
        }

        const hasInits = initConditionIds.length > 0;
        const hasTwap = twap !== null;

        if (!hasInits && !hasTwap) {
            throw new Error('submitTwap called with nothing to do');
        }

        // Fast path: a plain submitTwap (no inits) goes directly to the oracle,
        // avoiding the Multicall3 hop and its slight gas overhead.
        if (!hasInits && hasTwap) {
            const hash = await this.walletClient.writeContract({
                chain: polygon,
                address: this.oracleAddress,
                abi: oracleAbi,
                functionName: 'submitTwap',
                args: [{ markets: twap.markets, signature: twap.signature }],
            });

            const receipt = await this.client.waitForTransactionReceipt({ hash });
            if (receipt.status === 'reverted') {
                throw new Error(`submitTwap transaction reverted: ${hash}`);
            }

            return hash;
        }

        // Multicall path: build [initializeMarket × N (allowFailure), submitTwap (no failure)]
        const calls: { target: Hex; allowFailure: boolean; callData: Hex }[] = [];

        for (const conditionId of initConditionIds) {
            calls.push({
                target: this.vaultAddress,
                allowFailure: true,
                callData: encodeFunctionData({
                    abi: robinStakingVaultAbi,
                    functionName: 'initializeMarket',
                    args: [conditionId],
                }),
            });
        }

        if (hasTwap) {
            calls.push({
                target: this.oracleAddress,
                allowFailure: false,
                callData: encodeFunctionData({
                    abi: oracleAbi,
                    functionName: 'submitTwap',
                    args: [{ markets: twap.markets, signature: twap.signature }],
                }),
            });
        }

        console.log('Submitting Multicall3 transaction');
        const hash = await this.walletClient.writeContract({
            chain: polygon,
            address: MULTICALL3_ADDRESS,
            abi: multicall3Abi,
            functionName: 'aggregate3',
            args: [calls],
        });

        const receipt = await this.client.waitForTransactionReceipt({ hash });
        if (receipt.status === 'reverted') {
            throw new Error(`Multicall3 aggregate3 transaction reverted: ${hash}`);
        }

        return hash;
    }
}
