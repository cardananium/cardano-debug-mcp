// Compatibility shim over test/mcpClient.ts (the reusable harness). New tests should import
// `McpTestClient` from "../mcpClient.js" directly.
import { McpTestClient, NODE20_BIN, PROJECT_ROOT } from "../mcpClient.js";

export { PROJECT_ROOT, NODE20_BIN };
export type { JsonRpcError } from "../mcpClient.js";

/** Raw stdio client without automatic handshake: call `initialize()` yourself. */
export class StdioClient extends McpTestClient {
  static dist(nodeBin: string = process.execPath, env?: NodeJS.ProcessEnv): StdioClient {
    return new StdioClient({ mode: "dist", nodeBin, env });
  }

  static dev(env?: NodeJS.ProcessEnv): StdioClient {
    return new StdioClient({ mode: "dev", env });
  }
}
