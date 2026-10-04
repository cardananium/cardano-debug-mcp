// Worker used by host.test.ts: echo, slow loop that honours the stop flag, hang, throw, trap, exit.
import { serveWorker, stopRequested, throwIfStopRequested, getWorkerData } from "../../../src/workers/rpc-worker.js";

serveWorker(
  {
    echo: (...args: unknown[]) => args,
    add: (a: number, b: number) => a + b,
    bigint: () => ({ big: 2n ** 70n, small: 5n }),
    data: () => getWorkerData(),
    /** Busy loop until the stop flag is raised or `ms` elapsed; reports whether it was cancelled. */
    spin: (ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (stopRequested()) return { cancelled: true, remainingMs: end - Date.now() };
      }
      return { cancelled: false };
    },
    /** Busy loop that throws WorkerCancelledError when stopped. */
    spinThrow: (ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) throwIfStopRequested();
      return "finished";
    },
    /** Ignores the stop flag entirely (forces the hard kill). */
    hang: (ms: number) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        /* spin */
      }
      return "survived";
    },
    throwError: (message: string) => {
      throw new Error(message);
    },
    throwString: (message: string) => {
      throw message;
    },
    trap: () => {
      const wasm = (globalThis as unknown as { WebAssembly: { RuntimeError: new (m: string) => Error } }).WebAssembly;
      throw new wasm.RuntimeError("unreachable executed");
    },
    overflow: () => {
      const recurse = (n: number): number => recurse(n + 1) + 1;
      return recurse(0);
    },
    /** Says why on stderr (a cause line and stack frames), then dies inside the call. */
    dieLoudly: () => {
      console.error("thread 'main' panicked at src/lib.rs:1: out of cheese");
      console.error("    at stack frame one (lib.rs:1:1)");
      console.error("    at stack frame two (lib.rs:2:2)");
      process.exit(7);
    },
    exit: (code: number) => {
      setTimeout(() => process.exit(code), 5);
      return "exiting";
    },
    log: (text: string) => {
      console.log(text);
      console.error(text.toUpperCase());
      return true;
    },
    notCloneable: () => ({ fn: () => 1 }),
    slowAsync: async (ms: number) => {
      await new Promise((r) => setTimeout(r, ms));
      return "done";
    },
  },
  { info: () => ({ role: "test-worker" }) },
);
