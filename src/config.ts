import type { Hex } from 'viem';

export interface Config {
    twapSignerPrivateKey: Hex;
    subgraphUrl: string;
    subgraphAuthToken: string | null;
    rpcUrl: string;
    oracleAddress: Hex;
    vaultAddress: Hex;
    ports: number[];
    twapDivergenceThresholdPct: number;
    twapGracePeriodSeconds: number;
    submitOnchain: boolean;
    rateLimitEnabled: boolean;
    trustProxy: boolean | number | string;
}

const DEFAULT_VAULT_ADDRESS = '0xcb7444981296D08dA7161B75378e3773DbF5D806';

function requireEnv(name: string): string {
    const value = process.env[name];
    if (!value) {
        throw new Error(`Missing required environment variable: ${name}`);
    }
    return value;
}

function parsePorts(value: string | undefined): number[] {
    if (!value) return [3000];
    const ports = value
        .split(',')
        .map(p => Number(p.trim()))
        .filter(p => Number.isFinite(p) && p > 0);
    if (ports.length === 0) {
        throw new Error(`Invalid PORT value: ${value}`);
    }
    return ports;
}

// TRUST_PROXY accepts: "true"/"false", a hop count ("1", "2"), or an
// Express trust-proxy string ("loopback", an IP, a CIDR, or a comma-separated
// list). See https://expressjs.com/en/guide/behind-proxies.html
function parseTrustProxy(raw: string | undefined): boolean | number | string {
    if (raw === undefined || raw === '') return false;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    const asNumber = Number(raw);
    if (Number.isInteger(asNumber) && asNumber >= 0) return asNumber;
    return raw;
}

export function loadConfig(): Config {
    return {
        twapSignerPrivateKey: requireEnv('TWAP_SIGNER_PRIVATE_KEY') as Hex,
        subgraphUrl: requireEnv('SUBGRAPH_URL'),
        subgraphAuthToken: process.env.SUBGRAPH_AUTH_TOKEN ? process.env.SUBGRAPH_AUTH_TOKEN : null,
        rpcUrl: requireEnv('RPC_URL'),
        oracleAddress: requireEnv('ORACLE_ADDRESS') as Hex,
        vaultAddress: (process.env.VAULT_ADDRESS ?? DEFAULT_VAULT_ADDRESS) as Hex,
        ports: parsePorts(process.env.PORT),
        twapDivergenceThresholdPct: Number(process.env.TWAP_DIVERGENCE_THRESHOLD_PCT ?? '10'),
        twapGracePeriodSeconds: Number(process.env.TWAP_GRACE_PERIOD_SECONDS ?? '60'),
        submitOnchain: process.env.SUBMIT_ONCHAIN === 'true',
        rateLimitEnabled: process.env.RATE_LIMIT_ENABLED === 'true',
        trustProxy: parseTrustProxy(process.env.TRUST_PROXY),
    };
}
