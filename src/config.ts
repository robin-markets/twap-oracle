import type { Hex } from "viem";

export interface Config {
  twapSignerPrivateKey: Hex;
  subgraphUrl: string;
  rpcUrl: string;
  oracleAddress: Hex;
  port: number;
  twapDivergenceThresholdPct: number;
  twapGracePeriodSeconds: number;
  submitOnchain: boolean;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export function loadConfig(): Config {
  return {
    twapSignerPrivateKey: requireEnv("TWAP_SIGNER_PRIVATE_KEY") as Hex,
    subgraphUrl: requireEnv("SUBGRAPH_URL"),
    rpcUrl: requireEnv("RPC_URL"),
    oracleAddress: requireEnv("ORACLE_ADDRESS") as Hex,
    port: Number(process.env.PORT ?? "3000"),
    twapDivergenceThresholdPct: Number(
      process.env.TWAP_DIVERGENCE_THRESHOLD_PCT ?? "10",
    ),
    twapGracePeriodSeconds: Number(
      process.env.TWAP_GRACE_PERIOD_SECONDS ?? "120",
    ),
    submitOnchain: process.env.SUBMIT_ONCHAIN === "true",
  };
}
