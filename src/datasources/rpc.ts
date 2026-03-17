import {
    createPublicClient,
    createWalletClient,
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
     * Submit signed TWAP data on-chain via the oracle's submitTwap function.
     * Returns the transaction hash once the transaction is confirmed.
     */
    async submitTwap(markets: TwapData[], signature: Hex): Promise<Hex> {
        if (!this.walletClient) {
            throw new Error('Cannot submit on-chain: wallet client not configured (missing private key)');
        }

        const hash = await this.walletClient.writeContract({
            chain: polygon,
            address: this.oracleAddress,
            abi: oracleAbi,
            functionName: 'submitTwap',
            args: [{ markets, signature }],
        });

        const receipt = await this.client.waitForTransactionReceipt({ hash });
        if (receipt.status === 'reverted') {
            throw new Error(`submitTwap transaction reverted: ${hash}`);
        }

        return hash;
    }
}
