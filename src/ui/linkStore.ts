// URLs built by ui_link, kept for `cardano-debug://link/{link_id}/url.txt` (the full text of a URL too
// long to inline). Keyed by a hash of the URL; bounded LRU, process lifetime. Each URL is also written
// to `<cache>/links/<link_id>.url.txt` (`link_file`): a path the user or the assistant can open or copy
// from without re-typing thousands of base64 characters.

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { AppContext } from "../context.js";

export const LINK_STORE_MAX = 32;
export const LINK_ID_PATTERN = /^lnk_[0-9a-f]{16}$/;

export class UiLinkStore {
  private readonly urls = new Map<string, string>();
  constructor(private readonly max = LINK_STORE_MAX) {}

  /** Store `url`; answers its id (the same URL always gets the same id). */
  put(url: string): string {
    const id = `lnk_${createHash("sha256").update(url).digest("hex").slice(0, 16)}`;
    this.urls.delete(id);
    this.urls.set(id, url);
    while (this.urls.size > this.max) this.urls.delete(this.urls.keys().next().value!);
    return id;
  }

  get(id: string): string | undefined {
    return this.urls.get(id);
  }
}

declare module "../context.js" {
  interface AppServices {
    uiLinks?: UiLinkStore;
  }
}

export function uiLinkStore(ctx: AppContext): UiLinkStore {
  if (!ctx.services.uiLinks) ctx.services.uiLinks = new UiLinkStore();
  return ctx.services.uiLinks;
}

export function linkResourceUri(id: string): string {
  return `cardano-debug://link/${id}/url.txt`;
}

/** Link files kept on disk; the oldest go first. */
export const LINK_FILE_MAX = 64;

/**
 * Write `url` to `<cacheDir>/links/<id>.url.txt` (no trailing newline, owner-only) and answer the
 * absolute path; undefined when the cache directory is not writable (the resource still serves it).
 */
export function writeLinkFile(cacheDir: string, id: string, url: string, max = LINK_FILE_MAX): string | undefined {
  try {
    const dir = path.join(path.resolve(cacheDir), "links");
    mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.url.txt`);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, url, { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, file);
    pruneLinkFiles(dir, max);
    return file;
  } catch {
    return undefined;
  }
}

function pruneLinkFiles(dir: string, max: number): void {
  try {
    const files = readdirSync(dir)
      .filter((name) => name.endsWith(".url.txt"))
      .map((name) => ({ name, mtime: statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);
    for (const old of files.slice(0, Math.max(0, files.length - max))) unlinkSync(path.join(dir, old.name));
  } catch {
    // best effort
  }
}
