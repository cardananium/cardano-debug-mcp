// Server configuration, read from the environment once at start-up.
// Secrets (API keys) are never read from anywhere else and are never echoed back:
// `cardano-debug://server/info` reports only whether a key is present.

import os from "node:os";
import path from "node:path";

export type Network = "mainnet" | "preprod" | "preview";
export const NETWORKS: readonly Network[] = ["mainnet", "preprod", "preview"] as const;

export function isNetwork(value: unknown): value is Network {
  return typeof value === "string" && (NETWORKS as readonly string[]).includes(value);
}

export interface ServerConfig {
  /** Disk cache root (tx cbor, utxo rows, epoch params, bundles, scripts). `CARDANO_DEBUG_CACHE_DIR`. */
  cacheDir: string;
  /** `KOIOS_API_KEY`; Koios also works anonymously with lower rate limits. */
  koiosApiKey: string | undefined;
  /** `BLOCKFROST_PROJECT_ID_<NETWORK>`. */
  blockfrostProjectIds: Partial<Record<Network, string>>;
  /** Preferred chain provider when the caller does not pick one. `CARDANO_DEBUG_PROVIDER` (koios | blockfrost, any case). */
  defaultProvider: "koios" | "blockfrost";
  /** `CARDANO_DEBUG_OFFLINE=1|true`: provider requests are refused; bundles and the disk cache still work. */
  offline: boolean;

  /** Wall-clock budget of one `validate_transaction_js` call (phase 2 runs with an unbounded budget). `CARDANO_DEBUG_EVAL_TIMEOUT_MS`, 1 ms - 300 s. */
  evalTimeoutMs: number;
  /** Budget of every other lib call (decoders, hashing, CDDL). `CARDANO_DEBUG_LIB_TIMEOUT_MS`, 1 ms - 120 s. */
  libCallTimeoutMs: number;
  /** Time to wait for a freshly spawned worker to load its module before calls start their budgets. `CARDANO_DEBUG_WORKER_READY_TIMEOUT_MS`, 1 ms - 300 s. */
  workerReadyTimeoutMs: number;
  /** Default budget of a `debug_run` / `debug_profile` call. `CARDANO_DEBUG_RUN_TIMEOUT_MS`, 1 ms - 110 s. */
  runTimeoutMs: number;
  /** Budget of one `decompile_uplc` call. `CARDANO_DEBUG_DECOMPILE_TIMEOUT_MS`, 1 ms - 300 s. */
  decompileTimeoutMs: number;

  /** Input caps (UTF-8 bytes of string arguments of one worker call). */
  maxLibInputBytes: number;
  maxValidateInputBytes: number;
  maxDecompileInputBytes: number;

  /** TxStore: entries (`CARDANO_DEBUG_TX_STORE_MAX`, 1 - 1024) and idle TTL. */
  txStoreMax: number;
  txStoreTtlMs: number;
  /** SessionRegistry: entries (`CARDANO_DEBUG_SESSION_MAX`, 1 - 64), idle TTL, absolute TTL, sweep interval. */
  sessionMax: number;
  sessionIdleTtlMs: number;
  sessionAbsoluteTtlMs: number;
  sweepIntervalMs: number;

  /**
   * Largest JSON-RPC message the stdio transport accepts (bytes). Above it the transport closes and
   * the process exits (the host sees a dead server, not a silent one). `CARDANO_DEBUG_MAX_MESSAGE_BYTES`,
   * default 128 MiB (1 MiB - 1 GiB): an inline bundle at the 64 MB bundle cap, JSON-escaped, still fits.
   */
  maxMessageBytes: number;
  /** Heap ceiling handed to every worker (`resourceLimits.maxOldGenerationSizeMb`). `CARDANO_DEBUG_WORKER_HEAP_MB`, 128 - 8192. */
  workerMaxOldGenerationMb: number;
  /** `CARDANO_DEBUG_LOG` = 'debug' (any case) enables verbose stderr logging. */
  logLevel: "info" | "debug";

  /** Where cquisitor share links point: `CARDANO_DEBUG_CQUISITOR_URL` split into origin + base path. */
  cquisitorBase: UiBase;
  /** Where de-uplc-web links point (no trailing slash): `CARDANO_DEBUG_DE_UPLC_URL`. */
  deUplcBase: string;
  /** `CARDANO_DEBUG_NO_OPEN=1|true`: ui_link never starts a browser. */
  noOpen: boolean;
}

/** A web app location: `${origin}${basePath}/#…`. */
export interface UiBase {
  origin: string;
  basePath: string;
}

/** Deployed cquisitor app (GitHub Pages). */
export const DEFAULT_CQUISITOR_BASE: UiBase = { origin: "https://cardananium.github.io", basePath: "/cquisitor" };
/** Deployed de-uplc-web app (GitHub Pages). */
export const DEFAULT_DE_UPLC_BASE = "https://cardananium.github.io/de-uplc-web";

/** An http(s) URL split into origin and path without a trailing slash; undefined for anything else. */
export function parseUiBase(raw: string | undefined): UiBase | undefined {
  const text = raw?.trim();
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
  if (url.search || url.hash || url.username || url.password) return undefined;
  return { origin: url.origin, basePath: url.pathname.replace(/\/+$/, "") };
}

function uiBaseEnv(env: NodeJS.ProcessEnv, name: string, fallback: UiBase): UiBase {
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = parseUiBase(raw);
  if (!parsed) {
    console.error(`[cardano-debug] ignoring ${name}=${JSON.stringify(raw)}: not an http(s) URL without query or fragment`);
    return fallback;
  }
  return parsed;
}

/** Default, minimum and maximum of every numeric environment variable (the README table quotes these). */
export const ENV_LIMITS = {
  CARDANO_DEBUG_EVAL_TIMEOUT_MS: { default: 90_000, min: 1, max: 300_000 },
  CARDANO_DEBUG_LIB_TIMEOUT_MS: { default: 10_000, min: 1, max: 120_000 },
  CARDANO_DEBUG_WORKER_READY_TIMEOUT_MS: { default: 60_000, min: 1, max: 300_000 },
  CARDANO_DEBUG_RUN_TIMEOUT_MS: { default: 60_000, min: 1, max: 110_000 },
  CARDANO_DEBUG_DECOMPILE_TIMEOUT_MS: { default: 120_000, min: 1, max: 300_000 },
  CARDANO_DEBUG_TX_STORE_MAX: { default: 32, min: 1, max: 1024 },
  CARDANO_DEBUG_SESSION_MAX: { default: 8, min: 1, max: 64 },
  CARDANO_DEBUG_MAX_MESSAGE_BYTES: { default: 128 * 1024 * 1024, min: 1024 * 1024, max: 1024 * 1024 * 1024 },
  CARDANO_DEBUG_WORKER_HEAP_MB: { default: 1024, min: 128, max: 8192 },
} as const;

type LimitedVariable = keyof typeof ENV_LIMITS;

function warnEnv(message: string): void {
  console.error(`[cardano-debug] ${message}`);
}

/**
 * A whole number from the environment: digits only (`90s`, `60_000` and `1e4` are refused, not read as
 * 90 / 60 / 1), at least `min` (else the default), at most `max` (else clamped); every refusal is
 * announced on stderr.
 */
function intEnv(env: NodeJS.ProcessEnv, name: LimitedVariable): number {
  const { default: fallback, min, max } = ENV_LIMITS[name];
  const raw = env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const text = raw.trim();
  const value = /^\d+$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(value)) {
    warnEnv(`ignoring ${name}=${JSON.stringify(raw)}: expected a whole number (digits only, no unit, separator or exponent); using ${fallback}`);
    return fallback;
  }
  if (value < min) {
    warnEnv(`ignoring ${name}=${value}: below the minimum ${min}; using ${fallback}`);
    return fallback;
  }
  if (value > max) {
    warnEnv(`${name}=${value} is above the maximum ${max}; using ${max}`);
    return max;
  }
  return value;
}

/** 1 / true (any case) = on, 0 / false / empty = off; anything else is announced and read as off. */
function flagEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  const raw = env[name];
  const text = raw?.trim().toLowerCase();
  if (!text || text === "0" || text === "false") return false;
  if (text === "1" || text === "true") return true;
  warnEnv(`ignoring ${name}=${JSON.stringify(raw)}: expected 1 or true; the switch stays off`);
  return false;
}

function providerEnv(env: NodeJS.ProcessEnv): "koios" | "blockfrost" {
  const raw = env.CARDANO_DEBUG_PROVIDER?.trim();
  if (!raw) return "koios";
  const name = raw.toLowerCase();
  if (name === "koios" || name === "blockfrost") return name;
  warnEnv(`ignoring CARDANO_DEBUG_PROVIDER=${JSON.stringify(raw)}: expected koios or blockfrost; using koios`);
  return "koios";
}

function logLevelEnv(env: NodeJS.ProcessEnv): "info" | "debug" {
  const raw = env.CARDANO_DEBUG_LOG?.trim();
  if (!raw) return "info";
  const level = raw.toLowerCase();
  if (level === "debug" || level === "info") return level;
  warnEnv(`ignoring CARDANO_DEBUG_LOG=${JSON.stringify(raw)}: expected info or debug; using info`);
  return "info";
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    cacheDir: nonEmpty(env.CARDANO_DEBUG_CACHE_DIR) ?? path.join(os.homedir(), ".cache", "cardano-debug-mcp"),
    koiosApiKey: nonEmpty(env.KOIOS_API_KEY),
    blockfrostProjectIds: {
      mainnet: nonEmpty(env.BLOCKFROST_PROJECT_ID_MAINNET),
      preprod: nonEmpty(env.BLOCKFROST_PROJECT_ID_PREPROD),
      preview: nonEmpty(env.BLOCKFROST_PROJECT_ID_PREVIEW),
    },
    defaultProvider: providerEnv(env),
    offline: flagEnv(env, "CARDANO_DEBUG_OFFLINE"),

    evalTimeoutMs: intEnv(env, "CARDANO_DEBUG_EVAL_TIMEOUT_MS"),
    libCallTimeoutMs: intEnv(env, "CARDANO_DEBUG_LIB_TIMEOUT_MS"),
    workerReadyTimeoutMs: intEnv(env, "CARDANO_DEBUG_WORKER_READY_TIMEOUT_MS"),
    runTimeoutMs: intEnv(env, "CARDANO_DEBUG_RUN_TIMEOUT_MS"),
    decompileTimeoutMs: intEnv(env, "CARDANO_DEBUG_DECOMPILE_TIMEOUT_MS"),

    maxLibInputBytes: 2 * 1024 * 1024,
    maxValidateInputBytes: 16 * 1024 * 1024,
    maxDecompileInputBytes: 4 * 1024 * 1024,

    txStoreMax: intEnv(env, "CARDANO_DEBUG_TX_STORE_MAX"),
    txStoreTtlMs: 2 * 60 * 60 * 1000,
    sessionMax: intEnv(env, "CARDANO_DEBUG_SESSION_MAX"),
    sessionIdleTtlMs: 30 * 60 * 1000,
    sessionAbsoluteTtlMs: 4 * 60 * 60 * 1000,
    sweepIntervalMs: 60 * 1000,

    maxMessageBytes: intEnv(env, "CARDANO_DEBUG_MAX_MESSAGE_BYTES"),
    workerMaxOldGenerationMb: intEnv(env, "CARDANO_DEBUG_WORKER_HEAP_MB"),
    logLevel: logLevelEnv(env),

    cquisitorBase: uiBaseEnv(env, "CARDANO_DEBUG_CQUISITOR_URL", DEFAULT_CQUISITOR_BASE),
    deUplcBase: (() => {
      const base = uiBaseEnv(env, "CARDANO_DEBUG_DE_UPLC_URL", parseUiBase(DEFAULT_DE_UPLC_BASE)!);
      return `${base.origin}${base.basePath}`;
    })(),
    noOpen: flagEnv(env, "CARDANO_DEBUG_NO_OPEN"),
  };
}

/** stderr-only logger. stdout is the JSON-RPC channel and must never receive log lines. */
export const log = {
  info(message: string, ...rest: unknown[]): void {
    console.error(`[cardano-debug] ${message}`, ...rest);
  },
  warn(message: string, ...rest: unknown[]): void {
    console.error(`[cardano-debug] warn: ${message}`, ...rest);
  },
  debug(config: Pick<ServerConfig, "logLevel">, message: string, ...rest: unknown[]): void {
    if (config.logLevel === "debug") console.error(`[cardano-debug] debug: ${message}`, ...rest);
  },
};
