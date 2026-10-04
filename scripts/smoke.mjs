#!/usr/bin/env node
// Stdio smoke gate: spawns dist/server.js (or `tsx src/server.ts` with --dev), performs the legacy `initialize`
// handshake and checks the whole path end to end: the tool list equals the tools the source registers (and every
// schema is strict), cbor_decode, tx_inspect, resources, one debugger session (debug_open -> debug_run ->
// debug_close), one decompile, an unknown argument, and a clean exit on stdin close. Any failed check, a server
// that dies early, a non-JSON line on stdout or a timeout makes the exit code 1.
// Usage: node scripts/smoke.mjs [--dev] [--node <path-to-node>] [--timeout <seconds>]
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const args = process.argv.slice(2);
const dev = args.includes("--dev");
const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const nodeBin = valueOf("--node") ?? process.execPath;
const timeoutMs = Number(valueOf("--timeout") ?? 180) * 1000;
const CALL_TIMEOUT_MS = 90_000;

const failures = [];
const fail = (message) => {
  failures.push(message);
  console.error(`FAIL ${message}`);
};
const check = (name, ok, detail = "") => {
  if (ok) console.log(`ok   ${name}`);
  else fail(`${name}${detail ? `: ${detail}` : ""}`);
  return ok;
};

// A scratch cache and no shell keys: the result must not depend on the developer's environment.
const env = { ...process.env, CARDANO_DEBUG_CACHE_DIR: mkdtempSync(path.join(os.tmpdir(), "cdm-smoke-")), CARDANO_DEBUG_OFFLINE: "1", CARDANO_DEBUG_NO_OPEN: "1" };
for (const key of Object.keys(env)) if (/^(KOIOS_|BLOCKFROST_)/.test(key)) delete env[key];

const child = dev
  ? spawn(path.join(root, "node_modules/.bin/tsx"), [path.join(root, "src/server.ts")], { stdio: ["pipe", "pipe", "pipe"], env })
  : spawn(nodeBin, [path.join(root, "dist/server.js")], { stdio: ["pipe", "pipe", "pipe"], env });

let stderrText = "";
child.stderr.on("data", (chunk) => {
  stderrText += chunk.toString("utf8");
  process.stderr.write(chunk);
});

let exited;
const exitPromise = new Promise((resolve) => {
  child.once("exit", (code, signal) => {
    exited = { code, signal };
    resolve(exited);
  });
});

const globalTimer = setTimeout(() => {
  console.error(`FAIL smoke test did not finish within ${timeoutMs / 1000} s`);
  child.kill("SIGKILL");
  process.exit(1);
}, timeoutMs);

let buffer = "";
const pending = new Map();
let nextId = 1;
const strayStdout = [];
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      strayStdout.push(line.slice(0, 200));
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      const settle = pending.get(msg.id);
      pending.delete(msg.id);
      settle(msg);
    }
  }
});

/** A JSON-RPC request; resolves with the whole response (`result` or `error`), rejects on timeout or a dead server. */
function rpc(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    if (exited) return reject(new Error(`${method}: the server had already exited (code ${exited.code}, signal ${exited.signal})`));
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method}: no answer within ${CALL_TIMEOUT_MS / 1000} s`));
    }, CALL_TIMEOUT_MS);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    exitPromise.then(() => {
      if (pending.delete(id)) {
        clearTimeout(timer);
        reject(new Error(`${method}: the server exited (code ${exited.code}, signal ${exited.signal}) before answering`));
      }
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
/** A request that must succeed at the protocol level. */
async function request(method, params) {
  const msg = await rpc(method, params);
  if (msg.error) throw new Error(`${method} failed: ${JSON.stringify(msg.error)}`);
  return msg.result;
}
const call = (name, toolArgs) => request("tools/call", { name, arguments: toolArgs });
const notify = (method, params) => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");

async function step(name, fn) {
  try {
    await fn();
  } catch (error) {
    fail(`${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Tool names the source registers: the keys of TOOL_TEXT (a unit test ties them to ALL_TOOLS). */
function expectedTools() {
  const text = readFileSync(path.join(root, "src/tools/descriptions.ts"), "utf8");
  const body = text.slice(text.indexOf("export const TOOL_TEXT"));
  return [...body.matchAll(/^ {2}([a-z_]+): \{/gm)].map((m) => m[1]).sort();
}

const t0 = Date.now();
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const smallProgram = "(program 1.0.0 [(lam x [(builtin addInteger) x (con integer 1)]) (con integer 41)])";

await step("initialize", async () => {
  const init = await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0.0.0" } });
  notify("notifications/initialized", {});
  console.log(`initialize ok in ${Date.now() - t0} ms: ${init.serverInfo.name} v${init.serverInfo.version}, protocol ${init.protocolVersion}`);
  check("serverInfo.version is the package version", init.serverInfo.version === pkg.version, `${init.serverInfo.version} vs ${pkg.version}`);
  check("instructions are served", typeof init.instructions === "string" && init.instructions.length > 200);
});

await step("tools/list", async () => {
  const { tools } = await request("tools/list", {});
  const names = tools.map((t) => t.name).sort();
  const expected = expectedTools();
  check(`the ${expected.length} registered tools are listed`, JSON.stringify(names) === JSON.stringify(expected), `listed [${names.join(", ")}], source registers [${expected.join(", ")}] (is dist stale? run npm run build)`);
  const lax = tools.filter((t) => t.inputSchema?.additionalProperties !== false).map((t) => t.name);
  check("every input schema is strict (additionalProperties: false)", lax.length === 0, lax.join(", "));
});

await step("cbor_decode", async () => {
  const dec = await call("cbor_decode", { hex: "d8799f41aa02ff" });
  check("cbor_decode answers", !dec.isError && dec.structuredContent !== undefined, dec.content?.[0]?.text?.slice(0, 200));
});

let txId;
await step("tx_inspect", async () => {
  const tx = readFileSync(path.join(root, "test/fixtures/lock-spend.tx"), "utf8").trim(); // an artificial V2 reference-script spend (scenario s08)
  const body = await call("tx_inspect", { tx_cbor: tx, section: "body" });
  check("tx_inspect(section=body) answers with a tx_id", !body.isError && typeof body.structuredContent?.tx_id === "string", body.content?.[0]?.text?.slice(0, 200));
  txId = body.structuredContent?.tx_id;
  const red = await call("tx_inspect", { tx_id: txId, section: "redeemers" });
  check("tx_inspect(section=redeemers) answers", !red.isError, red.content?.[0]?.text?.slice(0, 200));
});

await step("resources", async () => {
  if (txId) {
    const res = await request("resources/read", { uri: `cardano-debug://tx/${txId}/cbor` });
    check("resource tx cbor is readable", res.contents?.[0]?.text?.length > 100);
  }
  const info = JSON.parse((await request("resources/read", { uri: "cardano-debug://server/info" })).contents[0].text);
  check("server/info reports the version and a build", info.version === pkg.version && typeof info.build?.source === "string", JSON.stringify({ version: info.version, build: info.build }));
});

await step("unknown argument", async () => {
  const msg = await rpc("tools/call", { name: "cbor_validate", arguments: { hex: "00", era: "babbage" } });
  const text = msg.error?.message ?? msg.result?.content?.[0]?.text ?? "";
  check("an unknown argument is rejected and names the valid ones", /unknown parameter 'era' for cbor_validate; valid parameters: hex, cddl/.test(text), text.slice(0, 300));
});

await step("debug session", async () => {
  const opened = await call("debug_open", { script: smallProgram, plutus_version: "V2" });
  const dbg = opened.structuredContent?.dbg_id;
  if (!check("debug_open opens a session", !opened.isError && typeof dbg === "string", opened.content?.[0]?.text?.slice(0, 300))) return;
  const run = await call("debug_run", { dbg_id: dbg, until: "done" });
  check("debug_run reaches the end", !run.isError && run.structuredContent?.stopped?.kind === "done", JSON.stringify(run.structuredContent?.stopped ?? run.content?.[0]?.text).slice(0, 300));
  const closed = await call("debug_close", { dbg_id: dbg });
  check("debug_close closes it", !closed.isError, closed.content?.[0]?.text?.slice(0, 200));
});

await step("script_decompile", async () => {
  // the artificial always-succeeds V2 script of the synthetic fixtures (test/fixtures/synthetic/uplc/tiny.uplc), from its registry
  const registry = JSON.parse(readFileSync(path.join(root, "test/fixtures/synthetic/scripts.json"), "utf8"));
  const dec = await call("script_decompile", { script: registry.scripts.tiny.cborHex, plutus_version: "V2" });
  check("script_decompile answers with code", !dec.isError && typeof dec.structuredContent?.code === "string" && dec.structuredContent.code.length > 0, dec.content?.[0]?.text?.slice(0, 300));
});

check("stdout carried only JSON-RPC", strayStdout.length === 0, strayStdout.join(" | "));
check("no startup or unhandled error on stderr", !/failed to start|failed to warm|unhandled rejection|uncaught exception/i.test(stderrText), stderrText.slice(0, 300));

child.stdin.end();
const done = await Promise.race([exitPromise, new Promise((resolve) => setTimeout(() => resolve(undefined), 15_000))]);
if (!done) {
  fail("the server did not exit within 15 s of stdin closing");
  child.kill("SIGKILL");
} else {
  check("the server exits 0 when stdin closes", done.code === 0, `code ${done.code}, signal ${done.signal}`);
}
clearTimeout(globalTimer);
console.log(`${failures.length === 0 ? "smoke ok" : `smoke FAILED (${failures.length})`}; total ${Date.now() - t0} ms`);
process.exit(failures.length === 0 ? 0 : 1);
