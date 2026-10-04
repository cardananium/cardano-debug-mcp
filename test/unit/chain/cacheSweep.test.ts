// A write cut short by a hard kill leaves `<file>.<pid>.<rand>.tmp`: swept (when old) the first time the cache is
// written to, never counted against the budget.
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { DiskCache } from "../../../src/chain/cache.js";
import { tempDir } from "./serviceHarness.js";

describe("stale .tmp files", () => {
  it("old ones are removed on the first write, fresh ones (another process mid-write) are kept", async () => {
    const root = tempDir("cdm-sweep-");
    const dir = path.join(root, "bundles", "mainnet");
    mkdirSync(dir, { recursive: true });
    const stale = path.join(dir, "aa.json.123.abc.tmp");
    const fresh = path.join(dir, "bb.json.456.def.tmp");
    const real = path.join(dir, "cc.json");
    for (const file of [stale, fresh, real]) writeFileSync(file, "x".repeat(10));
    const old = new Date(Date.now() - 10 * 60 * 1000);
    utimesSync(stale, old, old);
    utimesSync(real, old, old);

    const logged: string[] = [];
    const cache = new DiskCache({ root, log: (line) => logged.push(line) });
    await cache.setText("tx/mainnet/koios", "x.json", "{}");
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(real)).toBe(true);
    expect(logged.join("\n")).toMatch(/removed 1 stale \.tmp file/);
    expect((await cache.stats()).files).toBe(2); // cc.json and x.json; no .tmp counted
    expect(await cache.list("bundles/mainnet")).toEqual(["cc.json"]);
  });

  it("sweepStaleTmp can be called directly and uses the cache's clock", () => {
    const root = tempDir("cdm-sweep-");
    mkdirSync(path.join(root, "a"), { recursive: true });
    const tmp = path.join(root, "a", "f.json.1.x.tmp");
    writeFileSync(tmp, "x");
    let now = Date.now();
    const cache = new DiskCache({ root, now: () => now, log: () => undefined });
    expect(cache.sweepStaleTmp()).toBe(0);
    now += 6 * 60 * 1000;
    expect(cache.sweepStaleTmp()).toBe(1);
    expect(existsSync(tmp)).toBe(false);
  });
});
