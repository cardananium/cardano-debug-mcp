// A local Koios: an HTTP server on 127.0.0.1 (port chosen by the OS) that answers the endpoints the server calls when it loads a
// transaction by hash, from rows built by the synthetic toolkit (scenario s08 writes them to `lock-spend.provider-rows.json`).
// Nothing here touches the network.
//
//   const stub = await startKoiosStub(loadProviderRows("lock-spend.provider-rows.json"));
//   const client = StdioClient.dist(process.execPath, { ...stub.env, CARDANO_DEBUG_CACHE_DIR: dir });
//   ...
//   await stub.close();
//
// The server picks the base URL up from `CARDANO_DEBUG_KOIOS_URL_<NETWORK>` (src/chain/http.ts), so `stub.env` is all a test sets.
// Endpoints (src/chain/providers.ts and cquisitor-lib's KoiosClient): GET /tip /totals /epoch_params /committee_info /proposal_list,
// POST /tx_cbor /utxo_info /account_info /pool_info /drep_info /ogmios /asset_info /asset_utxos /datum_info. A row the stub does not
// hold is answered with an empty list (Koios does the same); a path it does not know is a 404. Every request is logged.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { readFixtureJson } from "./fixtures.js";

type Row = Record<string, unknown>;

/** What a scenario writes: the Koios rows of one on-chain transaction and the chain around it. */
export interface ProviderRows {
  network: "mainnet" | "preprod" | "preview";
  /** a `tx_cbor` row: tx_hash, block_hash, block_height, epoch_no, absolute_slot, tx_timestamp, cbor, valid_contract */
  tx: Row;
  /** `utxo_info` rows (every UTxO the transaction consumes, references or uses as collateral) */
  utxos: Row[];
  /** the `epoch_params` row of the inclusion epoch */
  epoch_params: Row;
  /** the `totals` row of the inclusion epoch */
  totals: Row;
}

export function loadProviderRows(file: string): ProviderRows {
  return readFixtureJson<ProviderRows>(file);
}

export interface KoiosStub {
  /** `http://127.0.0.1:<port>/api/v1` */
  url: string;
  /** The environment variable that points the server at this stub (merge it into the server's env). */
  env: Record<string, string>;
  /** `METHOD /path?query` of every request, in arrival order. */
  requests: string[];
  /** How many requests hit a path starting with `prefix` (`"/utxo_info"`). */
  count(prefix: string): number;
  close(): Promise<void>;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) }).end(text);
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  if (text === "") return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export async function startKoiosStub(rows: ProviderRows): Promise<KoiosStub> {
  const requests: string[] = [];
  const epoch = Number(rows.tx.epoch_no);
  const slot = Number(rows.tx.absolute_slot);
  const utxoKey = (r: Row): string => `${String(r.tx_hash).toLowerCase()}#${String(r.tx_index)}`;
  const utxosByRef = new Map(rows.utxos.map((r) => [utxoKey(r), r]));

  const server: Server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://stub");
      requests.push(`${req.method} ${url.pathname}${url.search}`);
      const path = url.pathname.replace(/^\/api\/v1/, "");
      const body = req.method === "POST" ? await readJson(req) : {};
      const wantedEpoch = url.searchParams.get("_epoch_no");

      switch (`${req.method} ${path}`) {
        case "GET /tip":
          // the chain moved on a little after the inclusion
          return send(res, 200, [{ hash: String(rows.tx.block_hash), epoch_no: epoch, abs_slot: slot + 600, epoch_slot: 0, block_height: Number(rows.tx.block_height) + 30, block_time: Number(rows.tx.tx_timestamp) + 600 }]);
        case "GET /totals":
          return send(res, 200, wantedEpoch === null || Number(wantedEpoch) === epoch ? [rows.totals] : []);
        case "GET /epoch_params":
          return send(res, 200, wantedEpoch === null || Number(wantedEpoch) === epoch ? [rows.epoch_params] : []);
        case "POST /tx_cbor": {
          const wanted = ((body._tx_hashes as string[] | undefined) ?? []).map((h) => h.toLowerCase());
          return send(res, 200, wanted.includes(String(rows.tx.tx_hash).toLowerCase()) ? [rows.tx] : []);
        }
        case "POST /utxo_info": {
          const wanted = ((body._utxo_refs as string[] | undefined) ?? []).map((r) => r.toLowerCase());
          return send(res, 200, wanted.flatMap((ref) => utxosByRef.get(ref) ?? []));
        }
        case "POST /account_info":
        case "POST /pool_info":
        case "POST /drep_info":
        case "POST /asset_info":
        case "POST /asset_utxos":
        case "POST /datum_info":
        case "GET /committee_info":
        case "GET /proposal_list":
          return send(res, 200, []);
        case "POST /ogmios":
          return send(res, 200, { jsonrpc: "2.0", result: null });
        default:
          return send(res, 404, []);
      }
    })().catch((error: unknown) => send(res, 500, { error: String(error) }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const env: Record<string, string> = {};
  env[`CARDANO_DEBUG_KOIOS_URL_${rows.network.toUpperCase()}`] = url;
  return {
    url,
    env,
    requests,
    count: (prefix) => requests.filter((r) => r.split(" ")[1]!.replace(/^\/api\/v1/, "").startsWith(prefix)).length,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
