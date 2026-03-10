import {
  keccak256,
  encodeAbiParameters,
  encodePacked,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { TwapData, SignedBatchTwapData } from "../types.js";

// Must exactly match the contract's SignaturesMixin.sol
// Note the space after "required," — this is intentional and must be byte-identical.
const TWAP_TYPEHASH = keccak256(
  toHex(
    "TwapData(bool required, bytes32 conditionId,uint256 startTimestamp,uint256 endTimestamp,uint256 twapPriceYes,uint256 marketEndedAt,uint256 marketEndYesPrice)"
  )
);

const BATCH_TWAP_TYPEHASH = keccak256(
  toHex("BatchTwapData(bytes32[] twapHashes)")
);

const EIP712_DOMAIN_TYPEHASH = keccak256(
  toHex(
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
  )
);

function buildDomainSeparator(chainId: number, vaultAddress: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "address" },
      ],
      [
        EIP712_DOMAIN_TYPEHASH,
        keccak256(toHex("RobinStakingVault")),
        keccak256(toHex("1")),
        BigInt(chainId),
        vaultAddress,
      ]
    )
  );
}

/**
 * Hash a single TwapData struct matching the contract's _hashTwapData assembly.
 *
 * keccak256(abi.encode(TWAP_TYPEHASH, required, conditionId, startTimestamp,
 *   endTimestamp, twapPriceYes, marketEndedAt, marketEndYesPrice))
 */
function hashTwapData(twap: TwapData): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: "bytes32" },
        { type: "bool" },
        { type: "bytes32" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
        { type: "uint256" },
      ],
      [
        TWAP_TYPEHASH,
        twap.required,
        twap.conditionId,
        twap.startTimestamp,
        twap.endTimestamp,
        twap.twapPriceYes,
        twap.marketEndedAt,
        twap.marketEndYesPrice,
      ]
    )
  );
}

/**
 * Hash a batch of TwapData matching the contract's _hashBatchTwapData assembly.
 *
 * 1. Hash each TwapData individually
 * 2. twapArrayHash = keccak256(encodePacked(hash1, hash2, ...))
 * 3. structHash = keccak256(abi.encode(BATCH_TWAP_TYPEHASH, twapArrayHash))
 */
function hashBatchTwapData(markets: TwapData[]): Hex {
  const individualHashes = markets.map(hashTwapData);

  // Pack bytes32[] tightly — matches the contract's assembly:
  //   keccak256(dataPtr, dataLen) where data is the raw bytes32[] content
  const twapArrayHash = keccak256(
    encodePacked(
      individualHashes.map(() => "bytes32" as const),
      individualHashes
    )
  );

  return keccak256(
    encodeAbiParameters(
      [{ type: "bytes32" }, { type: "bytes32" }],
      [BATCH_TWAP_TYPEHASH, twapArrayHash]
    )
  );
}

/**
 * Sign a batch of TwapData with EIP-712.
 *
 * Produces the exact signature the contract's _verifyBatchTwapSignature expects:
 *   digest = keccak256("\x19\x01" || domainSeparator || structHash)
 *   signature = ECDSA.sign(digest, privateKey)
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

  const domainSeparator = buildDomainSeparator(chainId, vaultAddress);
  const structHash = hashBatchTwapData(markets);

  // EIP-712 digest: \x19\x01 || domainSeparator || structHash
  const digest = keccak256(
    encodePacked(
      ["bytes2", "bytes32", "bytes32"],
      ["0x1901", domainSeparator, structHash]
    )
  );

  // Raw ECDSA sign — NOT signMessage (which adds Ethereum prefix)
  const account = privateKeyToAccount(privateKey);
  const signature = await account.sign({ hash: digest });

  return { markets, signature };
}
