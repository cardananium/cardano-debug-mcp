// tx_load's answers when the provider says no, stalls or is switched off, and for arguments that conflict.
// Koios is a stub on 127.0.0.1 that the tests switch between behaviours; the library is the real one.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { installProviderFetch, providerEndpoints } from "../../../src/chain/http.js";
import { chainStateOf } from "../../../src/chain/state.js";
import { txLoad } from "../../../src/tools/tx_load.js";
import type { ToolResult } from "../../../src/tools/_shared.js";
import { json, makeContext, SAMPLE_CONTEXT, SAMPLE_HASH, SAMPLE_ID, SAMPLE_TX, startStub, type Stub, type TestContext } from "./serviceHarness.js";

type Json = Record<string, any>;
type Behaviour = (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, body: string) => void;

let koios: Stub;
let behave: Behaviour = (_req, res) => json(res, []);
let uninstall: () => void;
const saved: Record<string, string | undefined> = {};
const contexts: TestContext[] = [];

beforeAll(async () => {
  koios = await startStub((req, res, body) => behave(req, res, body));
  saved.CARDANO_DEBUG_KOIOS_URL_MAINNET = process.env.CARDANO_DEBUG_KOIOS_URL_MAINNET;
  process.env.CARDANO_DEBUG_KOIOS_URL_MAINNET = `${koios.url}/api/v1`;
  // installed first, so the chain service's own install is a no-op and the policy here is the one in force
  uninstall = installProviderFetch({ endpoints: providerEndpoints(), policy: { retries: 1, baseBackoffMs: 1, timeoutMs: 400 }, sleep: async () => undefined, log: () => undefined });
});

afterAll(async () => {
  uninstall();
  if (saved.CARDANO_DEBUG_KOIOS_URL_MAINNET === undefined) delete process.env.CARDANO_DEBUG_KOIOS_URL_MAINNET;
  else process.env.CARDANO_DEBUG_KOIOS_URL_MAINNET = saved.CARDANO_DEBUG_KOIOS_URL_MAINNET;
  await koios.close();
});

beforeEach(() => {
  behave = (_req, res) => json(res, []);
});

const ctxWith = (env: NodeJS.ProcessEnv = {}): TestContext => {
  const t = makeContext(env);
  contexts.push(t);
  return t;
};
const out = (result: ToolResult): Json => result.structuredContent as Json;

describe("when the provider refuses", () => {
  it("tx_hash with a rejected key: auth_failed, with the hash and network to repeat the call and the ways around it", async () => {
    behave = (_req, res) => json(res, { message: "bad key" }, 401);
    const { ctx } = ctxWith({ KOIOS_API_KEY: "stale" });
    const result = await txLoad(ctx, { tx_hash: SAMPLE_HASH, network: "mainnet" });
    expect(result.isError).toBe(true);
    expect(out(result)).toMatchObject({ code: "auth_failed", provider: "koios", network: "mainnet", status: 401, tx_hash: SAMPLE_HASH });
    expect(out(result).message).toContain("KOIOS_API_KEY was rejected");
    expect(out(result).next.join(" ")).toMatch(/provider=blockfrost/);
    expect(out(result).next.join(" ")).toMatch(/tx_load\(bundle=/);
  });

  it("tx_cbor with a rejected key: the bytes are loaded, the chain state is honestly unavailable, and the answer says what to do", async () => {
    behave = (_req, res) => json(res, { message: "bad key" }, 403);
    const { ctx } = ctxWith({ KOIOS_API_KEY: "stale" });
    const result = await txLoad(ctx, { tx_cbor: SAMPLE_TX, network: "mainnet" });
    expect(result.isError).toBeFalsy();
    const s = out(result);
    expect(s.tx_id).toBe(SAMPLE_ID);
    expect(s).toMatchObject({ warning_code: "auth_failed" });
    expect(s.warning).toContain("KOIOS_API_KEY was rejected");
    expect(s.warning).not.toMatch(/^ToolInputError/);
    expect(s.next.join(" ")).toMatch(/tx_load\(bundle=/);
    expect(s.context).toMatchObject({ status: "unavailable", captured_at: null });
    expect(chainStateOf(ctx.txStore.get(SAMPLE_ID)!)?.capturedAt).toBeNull();
    expect(s.provider_warnings.join(" ")).toContain("chain state not loaded");
  });

  it("429: rate_limited with the provider's Retry-After, and advice that fits whether a key is set", async () => {
    behave = (_req, res) => json(res, { message: "slow down" }, 429, { "retry-after": "3" });
    const anonymous = out(await txLoad(ctxWith().ctx, { tx_hash: SAMPLE_HASH, network: "mainnet" }));
    expect(anonymous).toMatchObject({ code: "rate_limited", status: 429, retry_after_s: 3 });
    expect(anonymous.message).toContain("set KOIOS_API_KEY");
    const keyed = out(await txLoad(ctxWith({ KOIOS_API_KEY: "kk" }).ctx, { tx_hash: SAMPLE_HASH, network: "mainnet" }));
    expect(keyed.code).toBe("rate_limited");
    expect(keyed.message).not.toContain("set KOIOS_API_KEY");
    expect(keyed.message).toMatch(/KOIOS_API_KEY's plan/);
  });

  it("a provider that sends the headers and then stalls ends as a timeout answer, not a hang", async () => {
    behave = (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.write("[");
    };
    const started = Date.now();
    const result = await txLoad(ctxWith().ctx, { tx_cbor: SAMPLE_TX, network: "mainnet" });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(out(result).warning).toMatch(/request exceeded 400 ms/);
    expect(out(result).warning_code).toBe("provider_error");
  });

  it("an unknown hash: provider answers an empty list -> a hint about the network and about tx_cbor", async () => {
    const result = await txLoad(ctxWith().ctx, { tx_hash: SAMPLE_HASH, network: "mainnet" });
    expect(result.isError).toBe(true);
    expect(out(result)).toMatchObject({ code: "invalid_argument", argument: "tx_hash" });
    expect(out(result).message).toMatch(/try mainnet, preprod and preview/);
    expect(out(result).message).toMatch(/pass tx_cbor instead/);
  });
});

describe("offline", () => {
  // the fetch wrapper is process-wide and takes `offline` from whoever installs it first (the server's one chain service)
  beforeAll(() => {
    uninstall();
    uninstall = installProviderFetch({ endpoints: providerEndpoints(), offline: true, log: () => undefined });
  });
  afterAll(() => {
    uninstall();
    uninstall = installProviderFetch({ endpoints: providerEndpoints(), policy: { retries: 1, baseBackoffMs: 1, timeoutMs: 400 }, sleep: async () => undefined, log: () => undefined });
  });

  it("tx_hash: code offline", async () => {
    const result = await txLoad(ctxWith({ CARDANO_DEBUG_OFFLINE: "true" }).ctx, { tx_hash: SAMPLE_HASH, network: "mainnet" });
    expect(out(result)).toMatchObject({ code: "offline", tx_hash: SAMPLE_HASH });
    expect(out(result).next.join(" ")).toMatch(/tx_load\(bundle=/);
  });

  it("tx_cbor with nothing cached: bytes only, warning code offline (not invalid_argument for tx_id), no ToolInputError prefix", async () => {
    const result = await txLoad(ctxWith({ CARDANO_DEBUG_OFFLINE: "1" }).ctx, { tx_cbor: SAMPLE_TX, network: "mainnet" });
    expect(result.isError).toBeFalsy();
    expect(out(result)).toMatchObject({ warning_code: "offline", context: { status: "unavailable", captured_at: null } });
    expect(out(result).warning).not.toMatch(/ToolInputError/);
  });
});

describe("arguments", () => {
  it("exactly one of tx_cbor / tx_hash / bundle: the message names what was given, not a wrong argument", async () => {
    const { ctx } = ctxWith();
    const none = out(await txLoad(ctx, {}));
    expect(none).toMatchObject({ code: "invalid_argument" });
    expect(none.argument).toBeUndefined();
    expect(none.message).toBe("Pass exactly one of tx_cbor, tx_hash or bundle (got none).");
    const two = out(await txLoad(ctx, { tx_cbor: SAMPLE_TX, tx_hash: SAMPLE_HASH }));
    expect(two.argument).toBeUndefined();
    expect(two.message).toBe("Pass exactly one of tx_cbor, tx_hash or bundle (got tx_cbor, tx_hash).");
  });

  it("a transaction hash given as tx_cbor says it is a hash and what to call", async () => {
    const result = out(await txLoad(ctxWith().ctx, { tx_cbor: SAMPLE_HASH }));
    expect(result).toMatchObject({ code: "invalid_argument", argument: "tx_cbor" });
    expect(result.message).toContain("transaction HASH");
    expect(result.message).toContain(`tx_load(tx_hash="${SAMPLE_HASH}"`);
  });

  it("bundle: invalid JSON, a missing path and a conflicting network each name the bundle", async () => {
    const { ctx } = ctxWith({ CARDANO_DEBUG_OFFLINE: "1" });
    const broken = out(await txLoad(ctx, { bundle: '{"cardano_debug_bundle": 1, "network": "mainnet", "tx_cbor": ' }));
    expect(broken).toMatchObject({ code: "invalid_argument", argument: "bundle" });
    expect(broken.message).toMatch(/not valid JSON/);
    const missing = out(await txLoad(ctx, { bundle: "/definitely/not/here.json" }));
    expect(missing).toMatchObject({ code: "invalid_argument", argument: "bundle" });
    const conflict = out(await txLoad(ctx, { bundle: SAMPLE_CONTEXT, network: "preprod" }));
    expect(conflict.tx_id).toMatch(/^tx_preprod_/);
    expect(conflict.provider_warnings[0]).toMatch(/network=preprod was passed but the source says mainnet/);
  });

  it("provider= is reported as ignored while a chain state is already loaded, and not when it is the one that loaded it", async () => {
    const { ctx } = ctxWith({ CARDANO_DEBUG_OFFLINE: "1" });
    await txLoad(ctx, { bundle: SAMPLE_CONTEXT });
    const ignored = out(await txLoad(ctx, { tx_cbor: SAMPLE_TX, network: "mainnet", provider: "koios" }));
    expect(ignored.defaults_applied.join("\n")).toMatch(new RegExp(`provider=koios ignored: the chain state already loaded for ${SAMPLE_ID} \\(bundle, `));
    expect(ignored.defaults_applied.join("\n")).toMatch(/refresh=true/);
    const without = out(await txLoad(ctx, { tx_cbor: SAMPLE_TX, network: "mainnet" }));
    expect(without.defaults_applied.join("\n")).not.toMatch(/provider=.* ignored/);
  });

  it("a loaded state shows how old it is", async () => {
    const { ctx } = ctxWith({ CARDANO_DEBUG_OFFLINE: "1" });
    const loaded = out(await txLoad(ctx, { bundle: SAMPLE_CONTEXT }));
    expect(loaded.context.captured_at).toBeNull(); // the DebuggerContext carries no capture time
    expect(loaded.context.age_s).toBeNull();
    const state = chainStateOf(ctx.txStore.get(SAMPLE_ID)!)!;
    state.status = "cached";
    state.capturedAt = Date.now() - 125_000;
    const again = out(await txLoad(ctx, { tx_cbor: SAMPLE_TX, network: "mainnet" }));
    expect(again.context.age_s).toBeGreaterThanOrEqual(125);
    expect(again.context.stale_hint).toMatch(/refresh=true re-fetches the current ones/);
    ctx.txStore.get(SAMPLE_ID)!.onChain = { slot: "1", epoch: 1, block_height: 1, is_valid: true, source: "test" };
    expect(out(await txLoad(ctx, { tx_cbor: SAMPLE_TX, network: "mainnet" })).context.stale_hint).toBeUndefined();
  });
});
