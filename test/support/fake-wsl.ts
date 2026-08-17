import type { WslExec } from "../../src/sandbox/wsl-exec.ts";

export interface FakeWsl {
  wslExec: WslExec;
  distros: Set<string>;
  agentLaunched: { port: number; token: string } | null;
  wslDown: boolean;
}

export function installFakeWsl(): FakeWsl {
  const self: FakeWsl = {
    distros: new Set(["meerkat-sandbox"]),
    agentLaunched: null,
    wslDown: false,
    wslExec: async (args) => exec(args),
  };
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr: string) => ({ code: 1, stdout: "", stderr });
  function exec(args: string[]) {
    if (self.wslDown) return fail("wsl.exe not found");
    if (args[0] === "-l" && args[1] === "-q") return ok([...self.distros].join("\n") + "\n");
    if (args[0] === "-d") {
      const distro = args[1]!;
      if (!self.distros.has(distro)) return fail("There is no distribution with the supplied name.");
      const shIdx = args.indexOf("sh");
      if (shIdx > 0 && args[shIdx + 1] === "-c") {
        const script = args[shIdx + 2]!;
        const m = script.match(/AGENT_PORT=(\d+) AGENT_AUTH_TOKEN=(\S+)/);
        if (m) self.agentLaunched = { port: Number(m[1]), token: m[2]! };
      }
      return ok();
    }
    return fail(`fake wsl: unsupported args ${args.join(" ")}`);
  }
  return self;
}
