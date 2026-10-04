import { describe, expect, it } from "vitest";

import { deepMerge, ProviderRegistry } from "../../src/providers.js";
import { matchRoute, mimeFor, ROUTES, sliceLines, textContent, validationView } from "../../src/resources.js";
import type { TxRecord } from "../../src/store/txStore.js";

describe("ProviderRegistry", () => {
  it("asks providers in registration order and returns the first defined answer", async () => {
    const registry = new ProviderRegistry();
    const calls: string[] = [];
    registry.register({
      txNecessary: (record) => {
        calls.push("a");
        return record.txId === "x" ? { from: "a" } : undefined;
      },
    });
    const unregister = registry.register({
      txNecessary: async () => {
        calls.push("b");
        return { from: "b" };
      },
      serverInfo: () => ({ engines: { de_uplc_engine: "1.0" }, extra: 1 }),
    });
    expect(registry.size).toBe(2);
    expect(registry.implemented().sort()).toEqual(["serverInfo", "txNecessary"]);
    expect(await registry.first("txNecessary", { txId: "x" } as TxRecord)).toEqual({ from: "a" });
    expect(await registry.first("txNecessary", { txId: "y" } as TxRecord)).toEqual({ from: "b" });
    expect(calls).toEqual(["a", "a", "b"]);
    expect(await registry.first("epochParams", "mainnet")).toBeUndefined();
    expect(registry.serverInfoExtras()).toEqual({ engines: { de_uplc_engine: "1.0" }, extra: 1 });
    unregister();
    expect(await registry.first("txNecessary", { txId: "y" } as TxRecord)).toBeUndefined();
    expect(registry.serverInfoExtras()).toEqual({});
  });

  it("firstSync ignores promise answers", () => {
    const registry = new ProviderRegistry();
    registry.register({ resolvedUtxos: () => Promise.resolve(new Map()) as never });
    registry.register({ resolvedUtxos: () => new Map([["a#0", { utxo: "a#0", address: "", assets: [] }]]) });
    expect(registry.firstSync("resolvedUtxos", {} as TxRecord)?.size).toBe(1);
  });

  it("deepMerge merges nested plain objects, later wins", () => {
    expect(deepMerge({ a: { b: 1, c: 2 }, d: [1] }, { a: { c: 3, e: 4 }, d: [2], f: 5 })).toEqual({ a: { b: 1, c: 3, e: 4 }, d: [2], f: 5 });
  });
});

describe("sliceLines / textContent", () => {
  const text = ["l0", "l1", "l2", "l3"].join("\n");
  it("returns everything without a query", () => {
    const slice = sliceLines(text, new URL("cardano-debug://cddl/conway"));
    expect(slice).toEqual({ text, total_lines: 4, offset: 0, sliced: false });
    expect(textContent(new URL("cardano-debug://cddl/conway"), text, "text/plain")._meta).toBeUndefined();
  });
  it("windows by offset/limit and reports the window in _meta", () => {
    const uri = new URL("cardano-debug://cddl/conway?offset=1&limit=2");
    expect(sliceLines(text, uri)).toEqual({ text: "l1\nl2", total_lines: 4, offset: 1, limit: 2, sliced: true });
    expect(textContent(uri, text, "text/plain")).toEqual({ uri: uri.href, mimeType: "text/plain", text: "l1\nl2", _meta: { offset: 1, limit: 2, total_lines: 4, lines_returned: 2 } });
    expect(sliceLines(text, new URL("cardano-debug://x/y?offset=10")).text).toBe("");
    expect(sliceLines(text, new URL("cardano-debug://x/y?limit=1")).text).toBe("l0");
  });
});

describe("matchRoute", () => {
  it("routes every template and ignores the query string", () => {
    const cases: Array<[string, string, Record<string, string>]> = [
      ["cardano-debug://server/info", "server-info", {}],
      ["cardano-debug://server/info?offset=1", "server-info", {}],
      ["cardano-debug://cddl/conway?offset=15&limit=2", "cddl-conway", {}],
      ["cardano-debug://cddl", "cddl-index", {}],
      ["cardano-debug://cddl?limit=3", "cddl-index", {}],
      ["cardano-debug://cddl/babbage", "cddl-era", { era: "babbage" }],
      ["cardano-debug://cddl/shelley?offset=1&limit=1", "cddl-era", { era: "shelley" }],
      ["cardano-debug://docs", "docs-index", {}],
      ["cardano-debug://docs?limit=20", "docs-index", {}],
      ["cardano-debug://docs/uplc-cek", "docs-topic", { topic: "uplc-cek" }],
      ["cardano-debug://docs/tx-anatomy?offset=1&limit=9", "docs-topic", { topic: "tx-anatomy" }],
      ["cardano-debug://docs/tx-anatomy/collateral", "docs-section", { topic: "tx-anatomy", section: "collateral" }],
      ["cardano-debug://docs/uplc-cek/3?limit=2", "docs-section", { topic: "uplc-cek", section: "3" }],
      ["cardano-debug://tx/tx_mainnet_0123456789ab/cbor", "tx-cbor", { tx_id: "tx_mainnet_0123456789ab" }],
      ["cardano-debug://tx/tx_mainnet_0123456789ab/decoded.json?limit=5", "tx-decoded", { tx_id: "tx_mainnet_0123456789ab" }],
      ["cardano-debug://tx/tx_preprod_0123456789ab/validation.json", "tx-validation", { tx_id: "tx_preprod_0123456789ab" }],
      ["cardano-debug://tx/tx_preprod_0123456789ab/bundle.json", "tx-bundle", { tx_id: "tx_preprod_0123456789ab" }],
      ["cardano-debug://tx/tx_preprod_0123456789ab/necessary.json", "tx-necessary", { tx_id: "tx_preprod_0123456789ab" }],
      ["cardano-debug://tx/tx_mainnet_0123456789ab/redeemer/spend:0/context.json", "tx-redeemer-context-json", { tx_id: "tx_mainnet_0123456789ab", ref: "spend:0" }],
      ["cardano-debug://tx/tx_mainnet_0123456789ab/redeemer/mint:1/traces.txt?offset=100&limit=50", "tx-redeemer-traces-txt", { tx_id: "tx_mainnet_0123456789ab", ref: "mint:1" }],
      ["cardano-debug://tx/tx_mainnet_0123456789ab/redeemer/r:2/parts.json", "tx-redeemer-parts-json", { tx_id: "tx_mainnet_0123456789ab", ref: "r:2" }],
      ["cardano-debug://tx/tx_mainnet_0123456789ab/script/aa/bytes.hex", "tx-script-bytes", { tx_id: "tx_mainnet_0123456789ab", script_hash: "aa" }],
      ["cardano-debug://script/ab/pseudocode.txt?opts=7", "script-pseudocode-txt", { script_hash: "ab" }],
      ["cardano-debug://script/ab/uplc.txt", "script-uplc-txt", { script_hash: "ab" }],
      ["cardano-debug://script/ab/bytes.hex", "script-bytes-hex", { script_hash: "ab" }],
      ["cardano-debug://session/dbg_1/uplc.txt", "session-uplc-txt", { dbg_id: "dbg_1" }],
      ["cardano-debug://session/dbg_1/state.json", "session-state-json", { dbg_id: "dbg_1" }],
      ["cardano-debug://session/dbg_1/env.json", "session-env-json", { dbg_id: "dbg_1" }],
      ["cardano-debug://session/dbg_1/traces.txt", "session-traces-txt", { dbg_id: "dbg_1" }],
      ["cardano-debug://session/dbg_1/profile.json", "session-profile-json", { dbg_id: "dbg_1" }],
      ["cardano-debug://chain/preview/epoch_params", "chain-epoch-params", { net: "preview" }],
    ];
    for (const [uri, name, vars] of cases) {
      const match = matchRoute(new URL(uri));
      expect(match?.route.name, uri).toBe(name);
      expect(match?.vars, uri).toEqual(vars);
    }
    expect(matchRoute(new URL("cardano-debug://nothing/here"))).toBeUndefined();
    expect(matchRoute(new URL("cardano-debug://tx/x/nope"))).toBeUndefined();
  });

  it("has unique route names and JSON/text mime types by extension", () => {
    const names = ROUTES.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    expect(mimeFor("a.json")).toBe("application/json");
    expect(mimeFor("a.txt")).toBe("text/plain");
    expect(mimeFor("cbor")).toBe("text/plain");
    expect(mimeFor("a.md")).toBe("text/markdown");
    for (const route of ROUTES) {
      const expected =
        route.template.endsWith(".json") || route.template.endsWith("/info") || route.template.endsWith("epoch_params") || route.template === "cardano-debug://cddl"
          ? "application/json"
          : route.template.includes("://docs")
            ? "text/markdown"
            : "text/plain";
      expect(route.mimeType, route.template).toBe(expected);
    }
  });
});

describe("validationView", () => {
  it("drops byte fields, counts logs and keys by redeemer", () => {
    const record = {
      txId: "tx_mainnet_0123456789ab",
      txHash: "0123456789ab".padEnd(64, "0"),
      network: "mainnet",
      validation: {
        at: 0,
        elapsedMs: 12,
        phases: "both",
        result: { errors: [], warnings: [{ w: 1 }], phase2_errors: [], phase2_warnings: [] },
        redeemers: new Map([
          [
            "spend:0",
            {
              tag: "Spend",
              index: 0,
              provided_ex_units: { mem: "1", steps: "2" },
              logs: ["a", "b"],
              success: false,
              error: "boom",
              script_context_bytes: "d8",
              script_context: "{}",
              script_bytes: "59",
              redeemer_bytes: "d8",
              datum_bytes: null,
            },
          ],
        ]),
      },
    } as unknown as TxRecord;
    const view = validationView(record) as Record<string, unknown>;
    expect(view.phases).toBe("both");
    expect(view.warnings).toEqual([{ w: 1 }]);
    const [r] = view.eval_redeemer_results as Array<Record<string, unknown>>;
    expect(r).toMatchObject({ redeemer: "spend:0", success: false, error: "boom", logs_count: 2, script_context_bytes_present: true, datum_bytes_present: false });
    for (const field of ["logs", "script_context_bytes", "script_context", "script_bytes", "redeemer_bytes", "datum_bytes"]) expect(r).not.toHaveProperty(field);
    expect(validationView({} as TxRecord)).toBeUndefined();
  });
});
