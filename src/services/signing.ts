import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { TwapData, SignedBatchTwapData } from '../types.js';
import type { Eip712Domain } from '../datasources/rpc.js';

const types = {
    BatchTwapData: [{ name: 'markets', type: 'TwapData[]' }],
    TwapData: [
        { name: 'required', type: 'bool' },
        { name: 'conditionId', type: 'bytes32' },
        { name: 'startTimestamp', type: 'uint256' },
        { name: 'endTimestamp', type: 'uint256' },
        { name: 'twapPriceYes', type: 'uint256' },
        { name: 'marketEndedAt', type: 'uint256' },
        { name: 'marketEndYesPrice', type: 'uint256' },
    ],
} as const;

/**
 * Sign a batch of TwapData with EIP-712 using viem's signTypedData.
 *
 * The EIP-712 domain is fetched from the oracle contract (EIP-5267)
 * and passed in by the caller, so the server never hardcodes domain params.
 *
 * If no market requires TWAP, returns an empty signature (no signing needed).
 */
export async function signBatchTwapData(markets: TwapData[], privateKey: Hex, domain: Eip712Domain): Promise<SignedBatchTwapData> {
    if (!markets.some(m => m.required)) {
        return { markets, signature: '0x' };
    }

    const account = privateKeyToAccount(privateKey);

    const signature = await account.signTypedData({
        domain,
        types,
        primaryType: 'BatchTwapData',
        message: { markets },
    });

    return { markets, signature };
}
