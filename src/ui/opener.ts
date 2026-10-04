// Opening a URL in the user's browser through the OS opener (macOS `open`, Linux `xdg-open`,
// Windows `cmd /c start`), spawned without a shell, detached, stdio ignored. The call waits for the
// opener process to start (or fail to), never for the browser.
//
// The opener is replaceable: `ctx.services.urlOpener` (tests inject a recorder; no real browser).

import { spawn, type SpawnOptions } from "node:child_process";

import type { AppContext } from "../context.js";

export type OpenResult = { ok: true } | { ok: false; error: string };
export type UrlOpener = (url: string) => Promise<OpenResult>;

declare module "../context.js" {
  interface AppServices {
    urlOpener?: UrlOpener;
  }
}

/** cmd.exe's command line limit (8191 characters) minus the `start` prefix. */
export const WINDOWS_MAX_URL_CHARS = 8_000;
/** How long to wait for the opener process to report that it started. */
const SPAWN_WAIT_MS = 2_000;

export interface OpenerCommand {
  command: string;
  args: string[];
  options: SpawnOptions;
}

/** Only absolute http(s) URLs are opened. */
export function isOpenableUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * The opener invocation for a platform. Windows: `cmd /c start "" "<url>"` with verbatim arguments,
 * so `&` in the URL stays inside the quotes; a URL containing `"` or `%` is refused there (cmd would
 * read it as a quote or an environment variable).
 */
export function openerCommand(url: string, platform: NodeJS.Platform = process.platform): OpenerCommand | { error: string } {
  const options: SpawnOptions = { detached: true, stdio: "ignore", shell: false };
  if (platform === "darwin") return { command: "open", args: [url], options };
  if (platform === "win32") {
    if (/["%]/.test(url)) return { error: "the URL contains a character cmd.exe cannot pass through (\" or %)" };
    if (url.length > WINDOWS_MAX_URL_CHARS) return { error: `the URL is ${url.length} characters, longer than the Windows command line allows (${WINDOWS_MAX_URL_CHARS})` };
    return { command: "cmd", args: ["/c", "start", '""', `"${url}"`], options: { ...options, windowsVerbatimArguments: true, windowsHide: true } };
  }
  return { command: "xdg-open", args: [url], options };
}

export type SpawnFn = (command: string, args: readonly string[], options: SpawnOptions) => ReturnType<typeof spawn>;

/** The OS opener: resolves once the opener process started (ok) or failed to start (error). */
export function systemOpener(platform: NodeJS.Platform = process.platform, spawnFn: SpawnFn = spawn): UrlOpener {
  return (url) =>
    new Promise<OpenResult>((resolve) => {
      if (!isOpenableUrl(url)) return resolve({ ok: false, error: "only http(s) URLs are opened" });
      const cmd = openerCommand(url, platform);
      if ("error" in cmd) return resolve({ ok: false, error: cmd.error });
      let settled = false;
      const done = (result: OpenResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      try {
        const child = spawnFn(cmd.command, cmd.args, cmd.options);
        child.once("error", (error: Error) => done({ ok: false, error: `${cmd.command}: ${error.message}` }));
        child.once("spawn", () => done({ ok: true }));
        child.unref();
        setTimeout(() => done({ ok: true }), SPAWN_WAIT_MS).unref();
      } catch (error) {
        done({ ok: false, error: `${cmd.command}: ${error instanceof Error ? error.message : String(error)}` });
      }
    });
}

/**
 * With `CARDANO_DEBUG_TEST_HOOKS=1` the server never spawns anything: the opener logs the URL's
 * length to stderr and reports success.
 */
function testHookOpener(): UrlOpener {
  return async (url) => {
    if (!isOpenableUrl(url)) return { ok: false, error: "only http(s) URLs are opened" };
    console.error(`[cardano-debug] test-hook open: ${url.length} chars`);
    return { ok: true };
  };
}

export interface OpenOutcome {
  opened: boolean;
  open_error?: string;
  note?: string;
}

/** Open `url` unless CARDANO_DEBUG_NO_OPEN disables it; the injected opener wins over the OS one. */
export async function openUrl(ctx: AppContext, url: string): Promise<OpenOutcome> {
  if (ctx.config.noOpen) return { opened: false, note: "CARDANO_DEBUG_NO_OPEN=1: the server does not open a browser; give the user the URL" };
  if (!isOpenableUrl(url)) return { opened: false, open_error: "only http(s) URLs are opened" };
  const opener = ctx.services.urlOpener ?? (process.env.CARDANO_DEBUG_TEST_HOOKS === "1" ? testHookOpener() : systemOpener());
  try {
    const result = await opener(url);
    return result.ok ? { opened: true } : { opened: false, open_error: result.error };
  } catch (error) {
    return { opened: false, open_error: error instanceof Error ? error.message : String(error) };
  }
}
