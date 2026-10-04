// DecompileCache: full decompiled texts keyed by (script_hash, options_hash) so paging is free, plus
// failure markers per (script_hash, output layer) so a script that timed out or trapped is not
// retried in a storm. Bounded by entry count and total characters (LRU on both), idle TTL 24 h.

import type { DecompileNote } from "./notes.js";

export interface CacheEntry {
  key: string;
  scriptHash: string;
  optionsHash: string;
  /** Wire output layer (`Decompiled` | `Uplc` | `UplcCanonical` | …). */
  layer: string;
  /** Wire options JSON (sorted keys) that produced `text`. */
  optionsJson: string;
  text: string;
  lines: string[];
  notes: DecompileNote[];
  headerLines: number;
  elapsedMs: number;
  createdAt: number;
  lastUsedAt: number;
  /** What the decompiler was told (or left to detect) — echoed to the model. */
  versionToken: string | null;
  purposeToken: string | null;
}

export interface FailureMarker {
  scriptHash: string;
  layer: string;
  optionsHash: string;
  code: string;
  message: string;
  at: number;
  until: number;
}

export interface DecompileCacheOptions {
  maxEntries?: number;
  maxTotalChars?: number;
  ttlMs?: number;
  /** How long a failure marker blocks identical retries. Default 15 min. */
  failureTtlMs?: number;
  now?: () => number;
}

export function cacheKey(scriptHash: string, optionsHash: string): string {
  return `${scriptHash}:${optionsHash}`;
}

export class DecompileCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly failures = new Map<string, FailureMarker>();
  private readonly maxEntries: number;
  private readonly maxTotalChars: number;
  private readonly ttlMs: number;
  private readonly failureTtlMs: number;
  private readonly now: () => number;
  private totalChars = 0;

  constructor(options: DecompileCacheOptions = {}) {
    this.maxEntries = options.maxEntries ?? 64;
    this.maxTotalChars = options.maxTotalChars ?? 64 * 1024 * 1024;
    this.ttlMs = options.ttlMs ?? 24 * 60 * 60 * 1000;
    this.failureTtlMs = options.failureTtlMs ?? 15 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  get chars(): number {
    return this.totalChars;
  }

  /** Touching read. */
  get(scriptHash: string, optionsHash: string): CacheEntry | undefined {
    const key = cacheKey(scriptHash, optionsHash);
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (this.now() - entry.lastUsedAt > this.ttlMs) {
      this.drop(key);
      return undefined;
    }
    entry.lastUsedAt = this.now();
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  put(entry: Omit<CacheEntry, "key" | "createdAt" | "lastUsedAt" | "lines">): CacheEntry {
    const key = cacheKey(entry.scriptHash, entry.optionsHash);
    if (this.entries.has(key)) this.drop(key);
    const now = this.now();
    const full: CacheEntry = { ...entry, key, lines: entry.text.split("\n"), createdAt: now, lastUsedAt: now };
    this.entries.set(key, full);
    this.totalChars += full.text.length;
    this.failures.delete(failureKey(entry.scriptHash, entry.layer));
    this.evict();
    return full;
  }

  /** Most recently used entry for a script and layer (any options) — what the resources serve. */
  latestFor(scriptHash: string, layer: string): CacheEntry | undefined {
    let best: CacheEntry | undefined;
    for (const entry of this.entries.values()) {
      if (entry.scriptHash !== scriptHash || entry.layer !== layer) continue;
      if (!best || entry.lastUsedAt > best.lastUsedAt) best = entry;
    }
    if (best && this.now() - best.lastUsedAt > this.ttlMs) {
      this.drop(best.key);
      return undefined;
    }
    return best;
  }

  /** Script hashes with at least one cached text (for listings). */
  scriptHashes(): string[] {
    return Array.from(new Set(Array.from(this.entries.values()).map((e) => e.scriptHash)));
  }

  markFailure(marker: Omit<FailureMarker, "at" | "until">): FailureMarker {
    const now = this.now();
    const full: FailureMarker = { ...marker, at: now, until: now + this.failureTtlMs };
    this.failures.set(failureKey(marker.scriptHash, marker.layer), full);
    return full;
  }

  /** Active failure marker for (script, layer), or undefined once expired. */
  failure(scriptHash: string, layer: string): FailureMarker | undefined {
    const key = failureKey(scriptHash, layer);
    const marker = this.failures.get(key);
    if (!marker) return undefined;
    if (this.now() >= marker.until) {
      this.failures.delete(key);
      return undefined;
    }
    return marker;
  }

  clearFailure(scriptHash: string, layer: string): void {
    this.failures.delete(failureKey(scriptHash, layer));
  }

  sweep(): number {
    let removed = 0;
    const now = this.now();
    for (const [key, entry] of this.entries) {
      if (now - entry.lastUsedAt > this.ttlMs) {
        this.drop(key);
        removed++;
      }
    }
    for (const [key, marker] of this.failures) if (now >= marker.until) this.failures.delete(key);
    return removed;
  }

  clear(): void {
    this.entries.clear();
    this.failures.clear();
    this.totalChars = 0;
  }

  private evict(): void {
    while (this.entries.size > this.maxEntries || (this.totalChars > this.maxTotalChars && this.entries.size > 1)) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.drop(oldest);
    }
  }

  private drop(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    this.entries.delete(key);
    this.totalChars -= entry.text.length;
  }
}

function failureKey(scriptHash: string, layer: string): string {
  return `${scriptHash}:${layer}`;
}
