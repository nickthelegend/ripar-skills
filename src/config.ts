/**
 * Everything about *where* the chain is, in one file.
 *
 * The three registries below are deployed and live on Algorand TestNet. They are
 * not fixtures — every app id here resolves on a public explorer, and the box
 * reads in `registry.ts` hit them directly. Nothing in this package fabricates
 * a number; if a read fails you get an error, never a plausible-looking zero.
 */

export type Network = "testnet" | "mainnet";

/** The three Ripar registries. TestNet is the only network they exist on today.
 *
 *  These named 768633998/999/634000 until now — a superseded generation that is
 *  still on chain and still answers reads, so every lookup succeeded while
 *  returning the wrong thing: agent 1 resolved to KBDRZK3B… instead of
 *  NGVUO43A…, and 768634000 is bootstrapped to rUSDC 768547363 with a 20-second
 *  dispute window, where the live one settles real USDC 10458941 over 300s.
 *  A dead registry does not error; it understates. */
export const REGISTRY_APP_IDS = {
  testnet: {
    identity: 770382913,
    // v4. v1 (768547170) took the payment id and amount as ARGUMENTS and only
    // checked the id was 32 bytes and unseen, so a score could be minted from
    // bytes — two of the scores it published resolve to no transaction at all.
    // v2 (768559198) read them off the settling transfer, but never checked
    // WHERE the money went, so a microUSDC between two addresses you own
    // credited any agent id you named. v3 resolved both ends through the
    // IdentityRegistry: a credit requires the payment to have gone from the
    // client's registered address to the server's. This one adds
    // record_validation, called by the ValidationRegistry and by nothing else,
    // so a verdict finally reaches the score — before it, `validated` and
    // `disputed` were permanently 0 while jobs plainly read VALIDATED.
    reputation: 770382914,
    validation: 770382915,
  },
} as const satisfies Record<"testnet", Record<string, number>>;

export type RegistryName = keyof (typeof REGISTRY_APP_IDS)["testnet"];

/**
 * AlgoNode's public endpoints. No API key, CORS open — which is why this package
 * has no credential story at all: it reads what anyone can read.
 */
export const ENDPOINTS = {
  testnet: {
    algod: "https://testnet-api.algonode.cloud",
    indexer: "https://testnet-idx.algonode.cloud",
    explorer: "https://testnet.explorer.perawallet.app",
  },
  mainnet: {
    algod: "https://mainnet-api.algonode.cloud",
    indexer: "https://mainnet-idx.algonode.cloud",
    explorer: "https://explorer.perawallet.app",
  },
} as const satisfies Record<Network, { algod: string; indexer: string; explorer: string }>;

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
export const CAIP2: Record<Network, string> = {
  testnet: "algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDe",
  mainnet: "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73k",
};

/** USDC as an Algorand ASA. Wrong id per network means a payment that never settles. */
export const USDC_ASSET_ID: Record<Network, number> = {
  testnet: 10458941,
  mainnet: 31566704,
};

export const USDC_DECIMALS = 6;

/** Box name prefixes, exactly as the contracts write them. */
export const BOX_PREFIX = {
  /** IdentityRegistry: `ag_` + uint64 agent id, big-endian. */
  agent: "ag_",
  /** IdentityRegistry: `dm_` + the domain's raw UTF-8 bytes. */
  domain: "dm_",
  /** IdentityRegistry: `ad_` + the 32-byte account public key. */
  address: "ad_",
  /** ReputationRegistry: `sc_` + uint64 agent id, big-endian. */
  score: "sc_",
  /** ReputationRegistry: `pd_` + the 32-byte payment txid that was credited. */
  paid: "pd_",
  /** ValidationRegistry: `jb_` + uint64 job id, big-endian. */
  job: "jb_",
  /**
   * ValidationRegistry: `es_` + uint64 job id, holding a bare uint64 of what
   * is actually escrowed. Its own box map rather than a field on Job, so the
   * `jb_` layout never moved and every decoder that already read it kept
   * working. An ABSENT box is zero, not an error: the contract deletes it when
   * the escrow is paid out, and never creates it for a job nobody funded.
   */
  escrow: "es_",
  /**
   * ValidationRegistry: `bd_` + itob(job_id) + itob(bidder_agent_id) — a
   * 16-byte composite key, not one id. The job id comes FIRST so that every
   * bid on one job shares a byte prefix and algod can filter the listing
   * server-side.
   *
   * Live on 769444121 since 2026-08-05. Against an OLDER ValidationRegistry —
   * and eight earlier generations are still on chain, still answering — this
   * prefix matches zero boxes, which is a real, checkable answer rather than an
   * error. `src/deployed.ts` is what stops a WRITE against those same missing
   * methods being composed at all.
   */
  bid: "bd_",
} as const;

/**
 * Job lifecycle, copied from the constants at the top of
 * `ripar-contracts/contracts/validation_registry.py`. `disputed` (4) is a
 * validator's failing verdict, not an error — the contract keeps it because
 * hiding failures would make the score meaningless.
 */
export const JOB_STATUS = {
  0: "open",
  1: "assigned",
  2: "submitted",
  3: "validated",
  4: "disputed",
  5: "cancelled",
} as const;

export type JobStatusCode = keyof typeof JOB_STATUS;
export type JobStatus = (typeof JOB_STATUS)[JobStatusCode];

export function jobStatusName(code: number | bigint): JobStatus | "unknown" {
  const k = Number(code) as JobStatusCode;
  return JOB_STATUS[k] ?? "unknown";
}

export type RiparConfig = {
  network: Network;
  algod: string;
  indexer: string;
  explorer: string;
  appIds: { identity: number; reputation: number; validation: number };
  fetch: typeof fetch;
};

export type RiparConfigInput = Partial<Omit<RiparConfig, "appIds">> & {
  appIds?: Partial<RiparConfig["appIds"]>;
};

export function resolveConfig(input: RiparConfigInput = {}): RiparConfig {
  const network = input.network ?? "testnet";
  const eps = ENDPOINTS[network];
  // Only TestNet has registries deployed. Asking for mainnet without supplying
  // app ids should fail loudly rather than read app id 0 and return nothing.
  const defaults = network === "testnet" ? REGISTRY_APP_IDS.testnet : undefined;
  const appIds = {
    identity: input.appIds?.identity ?? defaults?.identity ?? 0,
    reputation: input.appIds?.reputation ?? defaults?.reputation ?? 0,
    validation: input.appIds?.validation ?? defaults?.validation ?? 0,
  };
  return {
    network,
    algod: input.algod ?? eps.algod,
    indexer: input.indexer ?? eps.indexer,
    explorer: input.explorer ?? eps.explorer,
    appIds,
    fetch: input.fetch ?? globalThis.fetch,
  };
}

export function explorerTxUrl(cfg: RiparConfig, txId: string): string {
  return `${cfg.explorer}/tx/${txId}`;
}

export function explorerAppUrl(cfg: RiparConfig, appId: number): string {
  return `${cfg.explorer}/application/${appId}`;
}

export function explorerAddressUrl(cfg: RiparConfig, address: string): string {
  return `${cfg.explorer}/address/${address}`;
}
