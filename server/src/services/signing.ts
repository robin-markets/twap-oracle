import type { Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { TwapData, SignedBatchTwapData } from "../types.js";

const domain = {
  name: "RobinStakingVault",
  version: "1",
} as const;

const types = {
  BatchTwapData: [{ name: "markets", type: "TwapData[]" }],
  TwapData: [
    { name: "required", type: "bool" },
    { name: "conditionId", type: "bytes32" },
    { name: "startTimestamp", type: "uint256" },
    { name: "endTimestamp", type: "uint256" },
    { name: "twapPriceYes", type: "uint256" },
    { name: "marketEndedAt", type: "uint256" },
    { name: "marketEndYesPrice", type: "uint256" },
  ],
} as const;

/**
 * Sign a batch of TwapData with EIP-712 using viem's signTypedData.
 *
 * If no market requires TWAP, returns an empty signature (no signing needed).
 */
export async function signBatchTwapData(
  markets: TwapData[],
  privateKey: Hex,
  chainId: number,
  vaultAddress: Hex
): Promise<SignedBatchTwapData> {
  if (!markets.some((m) => m.required)) {
    return { markets, signature: "0x" };
  }

  const account = privateKeyToAccount(privateKey);

  const signature = await account.signTypedData({
    domain: {
      ...domain,
      chainId,
      verifyingContract: vaultAddress,
    },
    types,
    primaryType: "BatchTwapData",
    message: { markets },
  });

  return { markets, signature };
}
