// Chain cache: a small in-memory TTL map in front of a disk cache under `CARDANO_DEBUG_CACHE_DIR`.
//
// Layout (`<root>/<namespace>/<key>`). Rows the providers returned are kept per provider (Koios and
// Blockfrost rows of one kind differ: a Blockfrost tx row has no slot, a Koios one has): <p> below is
// `koios` or `blockfrost`.
//   tx/<net>/<p>/<hash>.json (tx_cbor rows, forever), utxo/<net>/<p>/<hash>_<ix>.json (10 min),
//   epoch_params/<net>/<p>/latest.json (1 h), epoch_params/<net>/<p>/<epoch>.json and
//   rows/<net>/<p>/totals/<epoch>.json (forever), other rows/<net>/<p>/<kind>/<key>.json (5 min).
// Facts about a block and bytes the providers agree on are shared: inclusion/<net>/<hash>.json and
// scripts/<net>/<hash>.json (forever).
// A context (what the validator reads) and the verdict computed on it:
//   context/<net>/<hash>.<p>[.at-<slot>].json: 60 min for a transaction on chain, 10 min for one that
//     is not (its tip slot and spent flags go stale);
//   validation/<net>/<hash>.<sha256(bytes)/16>.<sha256(context)/16>.json (60 min): a verdict is
//     restored only for the exact bytes AND the exact context it was computed on.
// bundles/<net>/<hash>.json (forever): the last live context of the tx (and what bundle_export writes
// on request); the automatic copy of a context imported from a bundle / DebuggerContext / share link
// goes to bundles/<net>/<hash>.imported.json instead, so it never replaces what a live load wrote.
// Values with bigint fields are stored with the `{"$bi"}` box encoding (core share/bigintJson) so
// they round-trip exactly.
//
// The disk budget (512 MB) is enforced by removing the least recently modified files; bundles are
// evicted last. Leftovers of a write interrupted by a hard kill (`*.tmp`) are removed the first time
// the cache is written to. Every disk failure is logged and swallowed: the cache is an accelerator,
// never a correctness dependency.

import { mkdirSync, promises as fsp, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";

import { parseShareJson, stringifyShareJson } from "@cardananium/cquisitor-lib/share/bigintJson";

export const TTL = {
  forever: Number.POSITIVE_INFINITY,
  utxoRows: 10 * 60 * 1000,
  epochParams: 60 * 60 * 1000,
  providerRows: 5 * 60 * 1000,
  context: 60 * 60 * 1000,
  /** A context built at the current tip for a transaction that is not on chain. */
  pendingContext: 10 * 60 * 1000,
} as const;

/** A `*.tmp` file older than this is a leftover of an interrupted write (another live process finishes a write in seconds). */
const STALE_TMP_MS = 5 * 60 * 1000;

export const DEFAULT_DISK_BUDGET_BYTES = 512 * 1024 * 1024;

/** Keys become file names; keep them to a safe alphabet. */
export function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._@-]/g, "_").slice(0, 200);
}

export interface CacheLogger {
  (line: string): void;
}

/** Bounded in-memory map with per-entry expiry. */
export class MemoryTtlCache<T = unknown> {
  private readonly entries = new Map<string, { value: T; expiresAt: number }>();
  constructor(
    private readonly max = 512,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // refresh recency
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlMs: number): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: Number.isFinite(ttlMs) ? this.now() + ttlMs : Number.POSITIVE_INFINITY });
    while (this.entries.size > this.max) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

export interface DiskCacheOptions {
  root: string;
  maxBytes?: number;
  now?: () => number;
  log?: CacheLogger;
}

export interface DiskCacheStats {
  root: string;
  files: number;
  bytes: number;
  max_bytes: number;
}

export class DiskCache {
  readonly root: string;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly log: CacheLogger;
  private approxBytes: number | undefined;
  private ready: Promise<void> | undefined;

  constructor(options: DiskCacheOptions) {
    this.root = options.root;
    this.maxBytes = options.maxBytes ?? DEFAULT_DISK_BUDGET_BYTES;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.error(`[cardano-debug] cache: ${line}`));
  }

  /** Absolute path of a cache entry. */
  pathOf(namespace: string, key: string): string {
    return path.join(this.root, ...namespace.split("/").map(safeKey), safeKey(key));
  }

  /** Read a text entry younger than `ttlMs` (mtime-based); undefined when absent or stale. */
  async getText(namespace: string, key: string, ttlMs: number = TTL.forever): Promise<string | undefined> {
    const file = this.pathOf(namespace, key);
    try {
      const stat = await fsp.stat(file);
      if (Number.isFinite(ttlMs) && this.now() - stat.mtimeMs > ttlMs) return undefined;
      return await fsp.readFile(file, "utf8");
    } catch (error) {
      if (!isMissing(error)) this.log(`read ${file} failed: ${message(error)}`);
      return undefined;
    }
  }

  async setText(namespace: string, key: string, text: string): Promise<string | undefined> {
    const file = this.pathOf(namespace, key);
    try {
      await this.ensureSized();
      await fsp.mkdir(path.dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await fsp.writeFile(tmp, text, "utf8");
      await fsp.rename(tmp, file);
      this.approxBytes = (this.approxBytes ?? 0) + Buffer.byteLength(text);
      if (this.approxBytes > this.maxBytes) await this.enforceBudget();
      return file;
    } catch (error) {
      this.log(`write ${file} failed: ${message(error)}`);
      return undefined;
    }
  }

  /** JSON entry (bigint-preserving `{"$bi"}` encoding). */
  async getJson<T = unknown>(namespace: string, key: string, ttlMs: number = TTL.forever): Promise<T | undefined> {
    const text = await this.getText(namespace, key, ttlMs);
    if (text === undefined) return undefined;
    try {
      return parseShareJson(text) as T;
    } catch (error) {
      this.log(`corrupt entry ${namespace}/${key}: ${message(error)}`);
      await this.delete(namespace, key);
      return undefined;
    }
  }

  setJson(namespace: string, key: string, value: unknown): Promise<string | undefined> {
    return this.setText(namespace, key, stringifyShareJson(value));
  }

  /** File names in a namespace directory ([] when it does not exist). */
  async list(namespace: string): Promise<string[]> {
    try {
      return (await fsp.readdir(path.join(this.root, ...namespace.split("/").map(safeKey)))).filter((name) => !name.endsWith(".tmp"));
    } catch {
      return [];
    }
  }

  async delete(namespace: string, key: string): Promise<void> {
    try {
      await fsp.unlink(this.pathOf(namespace, key));
    } catch (error) {
      if (!isMissing(error)) this.log(`delete failed: ${message(error)}`);
    }
  }

  async stats(): Promise<DiskCacheStats> {
    const files = listFiles(this.root);
    const bytes = files.reduce((sum, f) => sum + f.size, 0);
    this.approxBytes = bytes;
    return { root: this.root, files: files.length, bytes, max_bytes: this.maxBytes };
  }

  /** Remove `*.tmp` leftovers of interrupted writes; returns how many. */
  sweepStaleTmp(): number {
    let removed = 0;
    for (const f of listFiles(this.root, true)) {
      if (this.now() - f.mtimeMs <= STALE_TMP_MS) continue;
      try {
        unlinkSync(f.file);
        removed++;
      } catch {
        // gone already
      }
    }
    if (removed > 0) this.log(`removed ${removed} stale .tmp file(s) left by an interrupted write`);
    return removed;
  }

  private ensureSized(): Promise<void> {
    if (!this.ready) {
      this.ready = (async () => {
        try {
          mkdirSync(this.root, { recursive: true });
          this.sweepStaleTmp();
          this.approxBytes = listFiles(this.root).reduce((sum, f) => sum + f.size, 0);
        } catch (error) {
          this.log(`cannot size ${this.root}: ${message(error)}`);
          this.approxBytes = 0;
        }
      })();
    }
    return this.ready;
  }

  /** Drop least-recently-modified files until 90 % of the budget; bundles go last. */
  private async enforceBudget(): Promise<void> {
    const files = listFiles(this.root);
    const bundlesDir = path.join(this.root, "bundles") + path.sep;
    files.sort((a, b) => {
      const aBundle = a.file.startsWith(bundlesDir) ? 1 : 0;
      const bBundle = b.file.startsWith(bundlesDir) ? 1 : 0;
      if (aBundle !== bBundle) return aBundle - bBundle;
      return a.mtimeMs - b.mtimeMs;
    });
    let total = files.reduce((sum, f) => sum + f.size, 0);
    const target = this.maxBytes * 0.9;
    let removed = 0;
    for (const f of files) {
      if (total <= target) break;
      try {
        unlinkSync(f.file);
        total -= f.size;
        removed++;
      } catch {
        // ignore
      }
    }
    this.approxBytes = total;
    if (removed > 0) this.log(`evicted ${removed} files to stay under ${Math.round(this.maxBytes / 1024 / 1024)} MB`);
  }
}

interface FileInfo {
  file: string;
  size: number;
  mtimeMs: number;
}

/** Every file under `root`; with `tmpOnly` just the `*.tmp` ones (never counted against the budget). */
function listFiles(root: string, tmpOnly = false): FileInfo[] {
  const out: FileInfo[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      try {
        const stat = statSync(full);
        if (stat.isDirectory()) stack.push(full);
        else if (stat.isFile() && name.endsWith(".tmp") === tmpOnly) out.push({ file: full, size: stat.size, mtimeMs: stat.mtimeMs });
      } catch {
        // vanished
      }
    }
  }
  return out;
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown })?.code === "ENOENT";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
