// The local Koios (test/helpers/koiosStub.ts): the endpoints a tx_hash load calls, answered from scenario s08's rows; nothing else.
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { fx, fxInt, fxStr } from "../../helpers/fixtures.js";
import { loadProviderRows, startKoiosStub, type KoiosStub } from "../../helpers/koiosStub.js";

describe("koios stub", () => {
  const rows = loadProviderRows(fxStr("s08.providerRows"));
  let stub: KoiosStub;

  beforeAll(async () => {
    stub = await startKoiosStub(rows);
  });
  afterAll(async () => {
    await stub.close();
  });

  const get = async (path: string) => {
    const res = await fetch(`${stub.url}${path}`);
    return { status: res.status, body: (await res.json()) as unknown };
  };
  const post = async (path: string, body: unknown) => {
    const res = await fetch(`${stub.url}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any[] };
  };

  it("listens on loopback and names itself through the server's environment variable", () => {
    expect(stub.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/api\/v1$/);
    expect(stub.env).toEqual({ CARDANO_DEBUG_KOIOS_URL_MAINNET: stub.url });
  });

  it("tx_cbor answers the s08 transaction's row, and no row for an unknown hash", async () => {
    const found = await post("/tx_cbor", { _tx_hashes: [fxStr("s08.txHash").toUpperCase()] });
    expect(found.body).toHaveLength(1);
    expect(found.body[0]).toMatchObject({ tx_hash: fxStr("s08.txHash"), epoch_no: fxInt("s08.epoch"), block_height: fxInt("s08.blockHeight") });
    expect((await post("/tx_cbor", { _tx_hashes: ["00".repeat(32)] })).body).toEqual([]);
  });

  it("utxo_info answers the requested UTxOs that exist, in request order of the rows it holds", async () => {
    const wanted = [fxStr("s08.referenceInput"), fxStr("s08.spendInput"), `${"00".repeat(32)}#0`];
    const answer = await post("/utxo_info", { _utxo_refs: wanted, _extended: true });
    expect(answer.body.map((r) => `${r.tx_hash}#${r.tx_index}`)).toEqual(wanted.slice(0, 2));
    expect((await post("/utxo_info", { _utxo_refs: [] })).body).toEqual([]);
  });

  it("epoch_params and totals: the latest and the inclusion epoch answer, another epoch has no row; the tip is just after the inclusion", async () => {
    const epoch = fxInt("s08.epoch");
    expect(((await get("/epoch_params")).body as Array<{ epoch_no: number }>)[0]!.epoch_no).toBe(epoch);
    expect(((await get(`/epoch_params?_epoch_no=${epoch}`)).body as unknown[]).length).toBe(1);
    expect((await get(`/epoch_params?_epoch_no=${epoch - 1}`)).body).toEqual([]);
    expect(((await get(`/totals?_epoch_no=${epoch}`)).body as unknown[]).length).toBe(1);
    const tip = ((await get("/tip")).body as Array<{ abs_slot: number; epoch_no: number }>)[0]!;
    expect(tip.abs_slot).toBeGreaterThan(Number(fx<string>("s08.slot")));
    expect(tip.epoch_no).toBe(epoch);
  });

  it("governance and account endpoints answer empty lists; an unknown path is a 404; every request is logged", async () => {
    expect((await post("/account_info", { _stake_addresses: [] })).body).toEqual([]);
    expect((await get("/proposal_list")).body).toEqual([]);
    expect((await get("/nope")).status).toBe(404);
    expect(stub.requests.at(-1)).toBe("GET /api/v1/nope");
    expect(stub.count("/tx_cbor")).toBeGreaterThanOrEqual(2);
  });
});
