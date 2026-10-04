// The e2e harness itself: the environment a spawned server gets must not depend on the developer's shell.
import { describe, expect, it } from "vitest";

import { serverEnv } from "../mcpClient.js";

describe("serverEnv", () => {
  const shell = {
    PATH: "/usr/bin",
    HOME: "/home/dev",
    TMPDIR: "/tmp",
    LANG: "en_US.UTF-8",
    LC_ALL: "C",
    NODE_OPTIONS: "--max-old-space-size=4096",
    KOIOS_API_KEY: "shell-key",
    BLOCKFROST_PROJECT_ID_MAINNET: "mainnetShell",
    CARDANO_DEBUG_OFFLINE: "1",
    CARDANO_DEBUG_CACHE_DIR: "/home/dev/.cache/mine",
    CARDANO_DEBUG_PROVIDER: "blockfrost",
    SSH_AUTH_SOCK: "/run/agent",
    npm_config_cache: "/x",
  };

  it("keeps PATH, HOME, TMPDIR, NODE_*, LANG and LC_*, and nothing else of the shell", () => {
    expect(serverEnv({}, shell)).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      TMPDIR: "/tmp",
      LANG: "en_US.UTF-8",
      LC_ALL: "C",
      NODE_OPTIONS: "--max-old-space-size=4096",
    });
  });

  it("drops KOIOS_*, BLOCKFROST_* and CARDANO_DEBUG_* of the shell; the test's own env wins", () => {
    const env = serverEnv({ CARDANO_DEBUG_OFFLINE: "1", CARDANO_DEBUG_CACHE_DIR: "/tmp/test-cache", KOIOS_API_KEY: "test-key" }, shell);
    expect(env.CARDANO_DEBUG_CACHE_DIR).toBe("/tmp/test-cache");
    expect(env.KOIOS_API_KEY).toBe("test-key");
    expect(env.BLOCKFROST_PROJECT_ID_MAINNET).toBeUndefined();
    expect(env.CARDANO_DEBUG_PROVIDER).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
  });
});
