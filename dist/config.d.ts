/**
 * Everything about *where* the chain is, in one file.
 *
 * The three registries below are deployed and live on Algorand TestNet. They are
 * not fixtures — every app id here resolves on a public explorer, and the box
 * reads in `registry.ts` hit them directly. Nothing in this package fabricates
 * a number; if a read fails you get an error, never a plausible-looking zero.
 */
export type Network = "testnet" | "mainnet";
/** The three Ripar registries. TestNet is the only network they exist on today. */
export declare const REGISTRY_APP_IDS: {
    readonly testnet: {
        readonly identity: 768547159;
        readonly reputation: 768559198;
        readonly validation: 768547172;
    };
};
export type RegistryName = keyof (typeof REGISTRY_APP_IDS)["testnet"];
/**
 * AlgoNode's public endpoints. No API key, CORS open — which is why this package
 * has no credential story at all: it reads what anyone can read.
 */
export declare const ENDPOINTS: {
    readonly testnet: {
        readonly algod: "https://testnet-api.algonode.cloud";
        readonly indexer: "https://testnet-idx.algonode.cloud";
        readonly explorer: "https://testnet.explorer.perawallet.app";
    };
    readonly mainnet: {
        readonly algod: "https://mainnet-api.algonode.cloud";
        readonly indexer: "https://mainnet-idx.algonode.cloud";
        readonly explorer: "https://explorer.perawallet.app";
    };
};
/**
 * CAIP-2 network ids as x402 uses them.
 *
 * These are the TRUNCATED genesis hashes: CAIP-2 caps a network reference at 32
 * characters, so the id is the first 32 chars of the base64 genesis hash rather
 * than the whole thing. Some facilitators advertise the full hash instead, so
 * comparisons against a facilitator's `/supported` output must be prefix-based,
 * not equality. Values mirror `@x402/avm`'s constants; kept local so this
 * package stays dependency-light.
 */
export declare const CAIP2: Record<Network, string>;
/** USDC as an Algorand ASA. Wrong id per network means a payment that never settles. */
export declare const USDC_ASSET_ID: Record<Network, number>;
export declare const USDC_DECIMALS = 6;
/** Box name prefixes, exactly as the contracts write them. */
export declare const BOX_PREFIX: {
    /** IdentityRegistry: `ag_` + uint64 agent id, big-endian. */
    readonly agent: "ag_";
    /** IdentityRegistry: `dm_` + the domain's raw UTF-8 bytes. */
    readonly domain: "dm_";
    /** IdentityRegistry: `ad_` + the 32-byte account public key. */
    readonly address: "ad_";
    /** ReputationRegistry: `sc_` + uint64 agent id, big-endian. */
    readonly score: "sc_";
    /** ReputationRegistry: `pd_` + the 32-byte payment txid that was credited. */
    readonly paid: "pd_";
    /** ValidationRegistry: `jb_` + uint64 job id, big-endian. */
    readonly job: "jb_";
};
/**
 * Job lifecycle, copied from the constants at the top of
 * `ripar-contracts/contracts/validation_registry.py`. `disputed` (4) is a
 * validator's failing verdict, not an error — the contract keeps it because
 * hiding failures would make the score meaningless.
 */
export declare const JOB_STATUS: {
    readonly 0: "open";
    readonly 1: "assigned";
    readonly 2: "submitted";
    readonly 3: "validated";
    readonly 4: "disputed";
    readonly 5: "cancelled";
};
export type JobStatusCode = keyof typeof JOB_STATUS;
export type JobStatus = (typeof JOB_STATUS)[JobStatusCode];
export declare function jobStatusName(code: number | bigint): JobStatus | "unknown";
export type RiparConfig = {
    network: Network;
    algod: string;
    indexer: string;
    explorer: string;
    appIds: {
        identity: number;
        reputation: number;
        validation: number;
    };
    fetch: typeof fetch;
};
export type RiparConfigInput = Partial<Omit<RiparConfig, "appIds">> & {
    appIds?: Partial<RiparConfig["appIds"]>;
};
export declare function resolveConfig(input?: RiparConfigInput): RiparConfig;
export declare function explorerTxUrl(cfg: RiparConfig, txId: string): string;
export declare function explorerAppUrl(cfg: RiparConfig, appId: number): string;
export declare function explorerAddressUrl(cfg: RiparConfig, address: string): string;
