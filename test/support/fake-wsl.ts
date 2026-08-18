import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { WslExec, } from "../../src/sandbox/wsl-exec.ts";
import type { WslSpawn } from "../../src/sandbox/wsl2-sandbox.ts";

export interface FakeWsl {
  wslExec: WslExec;
  spawnWsl: WslSpawn;
  distros: Set<string>;
  spawned: Array<{ args: string[]; env: Record<string, string> }>;
  wslDown: boolean;
}

export function installFakeWsl(): FakeWsl {
  const self: FakeWsl = {
    distros: new Set(["meerkat-sandbox"]),
    spawned: [],
    wslDown: false,
    wslExec: async (args) => exec(args),
    spawnWsl: (args, env) => {
      self.spawned.push({ args, env });
      const child = new EventEmitter() as ChildProcess;
      child.kill = () => true;
      return child;
    },
  };
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr: string) => ({ code: 1, stdout: "", stderr });
  function exec(args: string[]) {
    if (self.wslDown) return fail("wsl.exe not found");
    if (args[0] === "-l" && args[1] === "-q") return ok([...self.distros].join("\n") + "\n");
    if (args[0] === "-d") {
      const distro = args[1]!;
      if (!self.distros.has(distro)) return fail("There is no distribution with the supplied name.");
      return ok();
    }
    return fail(`fake wsl: unsupported args ${args.join(" ")}`);
  }
  return self;
}
