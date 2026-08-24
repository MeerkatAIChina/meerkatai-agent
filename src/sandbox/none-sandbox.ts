import type { Sandbox } from "./sandbox.ts";
import { NonRetryableTurnError } from "../core/turn-error.ts";

const UNAVAILABLE = "sandbox unavailable: SANDBOX_BACKEND=none (no sandbox substrate on this machine)";

export function createNoneSandbox(): Sandbox {
  const fail = (): Promise<never> => Promise.reject(new NonRetryableTurnError(UNAVAILABLE));
  return {
    profile: {
      backend: "none",
      writablePersistence: "resident_disk",
      processSessions: false,
      egressEnforcement: "none",
    },
    provision: fail,
    run: fail,
    readFile: fail,
    writeFile: fail,
    writeFileBytes: fail,
    readFileBytes: fail,
    listDir: fail,
    removeDir: fail,
    teardown: fail,
  };
}
