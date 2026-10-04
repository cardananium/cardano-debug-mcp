// loadConfig: environment values are read exactly or refused out loud, never misread (`90s` -> 90, `1e4` -> 1).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ENV_LIMITS, loadConfig } from "../../../src/config.js";

let stderr: string[];
beforeEach(() => {
  stderr = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => void stderr.push(args.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

describe("numeric variables", () => {
  it("defaults when unset or blank, silently", () => {
    const config = loadConfig({ CARDANO_DEBUG_EVAL_TIMEOUT_MS: "  " });
    expect(config).toMatchObject({ evalTimeoutMs: 90_000, libCallTimeoutMs: 10_000, workerReadyTimeoutMs: 60_000, runTimeoutMs: 60_000, decompileTimeoutMs: 120_000, txStoreMax: 32, sessionMax: 8 });
    expect(stderr).toEqual([]);
  });

  it("reads a whole number exactly", () => {
    expect(loadConfig({ CARDANO_DEBUG_EVAL_TIMEOUT_MS: "120000" }).evalTimeoutMs).toBe(120_000);
    expect(loadConfig({ CARDANO_DEBUG_EVAL_TIMEOUT_MS: " 2000 " }).evalTimeoutMs).toBe(2000);
    expect(stderr).toEqual([]);
  });

  it.each(["90s", "60_000", "1e4", "1.5", "-5", "0x10", "ten", "10 000"])("refuses %j with a stderr line and uses the default", (raw) => {
    const config = loadConfig({ CARDANO_DEBUG_EVAL_TIMEOUT_MS: raw });
    expect(config.evalTimeoutMs).toBe(ENV_LIMITS.CARDANO_DEBUG_EVAL_TIMEOUT_MS.default);
    expect(stderr.join("\n")).toContain("CARDANO_DEBUG_EVAL_TIMEOUT_MS");
    expect(stderr.join("\n")).toContain("digits only");
  });

  it("refuses zero and clamps to the maximum, saying so", () => {
    expect(loadConfig({ CARDANO_DEBUG_RUN_TIMEOUT_MS: "0" }).runTimeoutMs).toBe(60_000);
    expect(stderr.join("\n")).toContain("below the minimum 1");
    stderr.length = 0;
    expect(loadConfig({ CARDANO_DEBUG_RUN_TIMEOUT_MS: "999999" }).runTimeoutMs).toBe(110_000);
    expect(stderr.join("\n")).toContain("above the maximum 110000");
  });

  it("applies the documented maxima", () => {
    const big = "99999999999";
    const config = loadConfig({
      CARDANO_DEBUG_EVAL_TIMEOUT_MS: big,
      CARDANO_DEBUG_LIB_TIMEOUT_MS: big,
      CARDANO_DEBUG_WORKER_READY_TIMEOUT_MS: big,
      CARDANO_DEBUG_RUN_TIMEOUT_MS: big,
      CARDANO_DEBUG_DECOMPILE_TIMEOUT_MS: big,
      CARDANO_DEBUG_TX_STORE_MAX: big,
      CARDANO_DEBUG_SESSION_MAX: big,
      CARDANO_DEBUG_MAX_MESSAGE_BYTES: big,
      CARDANO_DEBUG_WORKER_HEAP_MB: big,
    });
    expect(config).toMatchObject({
      evalTimeoutMs: 300_000,
      libCallTimeoutMs: 120_000,
      workerReadyTimeoutMs: 300_000,
      runTimeoutMs: 110_000,
      decompileTimeoutMs: 300_000,
      txStoreMax: 1024,
      sessionMax: 64,
      maxMessageBytes: 1024 * 1024 * 1024,
      workerMaxOldGenerationMb: 8192,
    });
  });

  it("a message cap below 1 MiB is refused (the transport would reject every request)", () => {
    expect(loadConfig({ CARDANO_DEBUG_MAX_MESSAGE_BYTES: "1024" }).maxMessageBytes).toBe(128 * 1024 * 1024);
    expect(loadConfig({ CARDANO_DEBUG_MAX_MESSAGE_BYTES: String(1024 * 1024) }).maxMessageBytes).toBe(1024 * 1024);
  });
});

describe("provider", () => {
  it("is case-insensitive", () => {
    expect(loadConfig({ CARDANO_DEBUG_PROVIDER: "Blockfrost" }).defaultProvider).toBe("blockfrost");
    expect(loadConfig({ CARDANO_DEBUG_PROVIDER: " KOIOS " }).defaultProvider).toBe("koios");
    expect(stderr).toEqual([]);
  });

  it("an unknown value is announced, not silently koios", () => {
    expect(loadConfig({ CARDANO_DEBUG_PROVIDER: "blockfrots" }).defaultProvider).toBe("koios");
    expect(stderr.join("\n")).toMatch(/CARDANO_DEBUG_PROVIDER="blockfrots".*koios or blockfrost/);
  });
});

describe("switches", () => {
  it.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    [" True ", true],
    ["0", false],
    ["false", false],
    ["", false],
  ])("CARDANO_DEBUG_OFFLINE=%j -> %s", (raw, expected) => {
    expect(loadConfig({ CARDANO_DEBUG_OFFLINE: raw }).offline).toBe(expected);
    expect(stderr).toEqual([]);
  });

  it("is off when unset, and an unreadable value is announced and stays off", () => {
    expect(loadConfig({}).offline).toBe(false);
    expect(loadConfig({ CARDANO_DEBUG_OFFLINE: "yes" }).offline).toBe(false);
    expect(stderr.join("\n")).toContain("CARDANO_DEBUG_OFFLINE");
  });

  it("no-open and the log level read the same way", () => {
    expect(loadConfig({ CARDANO_DEBUG_NO_OPEN: "true" }).noOpen).toBe(true);
    expect(loadConfig({ CARDANO_DEBUG_NO_OPEN: "1" }).noOpen).toBe(true);
    expect(loadConfig({}).noOpen).toBe(false);
    expect(loadConfig({ CARDANO_DEBUG_LOG: "DEBUG" }).logLevel).toBe("debug");
    expect(loadConfig({ CARDANO_DEBUG_LOG: "verbose" }).logLevel).toBe("info");
    expect(stderr.join("\n")).toContain("CARDANO_DEBUG_LOG");
  });
});

describe("keys", () => {
  it("are read from the environment only and blank values are absent", () => {
    const config = loadConfig({ KOIOS_API_KEY: " k ", BLOCKFROST_PROJECT_ID_MAINNET: "mainnetXYZ", BLOCKFROST_PROJECT_ID_PREPROD: "  " });
    expect(config.koiosApiKey).toBe("k");
    expect(config.blockfrostProjectIds).toEqual({ mainnet: "mainnetXYZ", preprod: undefined, preview: undefined });
  });
});
