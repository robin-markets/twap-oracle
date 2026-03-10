import { Address, BigInt, Bytes } from "@graphprotocol/graph-ts";

export const COLLATERAL_ASSET_ID = BigInt.fromI32(0);
export const PRICE_SCALE = BigInt.fromI32(1000000);
export const INDEX_SET_YES = BigInt.fromI32(1);
export const INDEX_SET_NO = BigInt.fromI32(2);
export const PARENT_COLLECTION_ID = Bytes.fromHexString(
  "0x0000000000000000000000000000000000000000000000000000000000000000"
) as Bytes;
export const CONDITIONAL_TOKENS_ADDRESS = Address.fromString(
  "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045"
);
export const COLLATERAL_USDCE = Address.fromString(
  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"
);
export const COLLATERAL_WCOL = Address.fromString(
  "0x3A3BD7bb9528E159577F7C2e685CC81A765002E2"
);

export function tokenIndexId(conditionId: Bytes, index: i32): string {
  return conditionId.toHex().concat("-").concat(index.toString());
}
