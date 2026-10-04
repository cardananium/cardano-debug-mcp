import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // @cardananium/de-uplc-* ship TypeScript sources: transform them instead of loading them as externals.
    server: { deps: { inline: [/@cardananium\/de-uplc-/] } },
    include: ["test/**/*.test.ts"],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    pool: "forks",
    fileParallelism: false,
  },
});
