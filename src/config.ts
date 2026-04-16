import type { Hex } from 'viem';

export interface Config {
    twapSignerPrivateKey: Hex;
    subgraphUrl: string;
    rpcUrl: string;
    oracleAddress: Hex;
    vaultAddress: Hex;
    port: number;
    twapDivergenceThresholdPct: number;
    twapGracePeriodSeconds: number;
    submitOnchain: boolean;
}

const DEFAULT_VAULT_ADDRESS = '0xcb7444981296D08dA7161B75378e3773DbF5D806';

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

export function loadConfig(): Config {
    return {
        twapSignerPrivateKey: requireEnv('TWAP_SIGNER_PRIVATE_KEY') as Hex,
        subgraphUrl: requireEnv('SUBGRAPH_URL'),
        rpcUrl: requireEnv('RPC_URL'),
        oracleAddress: requireEnv('ORACLE_ADDRESS') as Hex,
        vaultAddress: (process.env.VAULT_ADDRESS ?? DEFAULT_VAULT_ADDRESS) as Hex,
        port: Number(process.env.PORT ?? '3000'),
        twapDivergenceThresholdPct: Number(process.env.TWAP_DIVERGENCE_THRESHOLD_PCT ?? '10'),
        twapGracePeriodSeconds: Number(process.env.TWAP_GRACE_PERIOD_SECONDS ?? '60'),
        submitOnchain: process.env.SUBMIT_ONCHAIN === 'true',
    };
}
