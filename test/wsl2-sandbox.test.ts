import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createWsl2Sandbox } from "../src/sandbox/wsl2-sandbox.ts";
import { supportsProcessSessions } from "../src/sandbox/sandbox.ts";
import { createLocalWorkspaceStore } from "../src/workspace/workspace-store.ts";
import { installFakeWsl, type FakeWsl } from "./support/fake-wsl.ts";
import { sleep } from "../src/util/async.ts";

const AGENT_TOKEN = "wsl2-test-token";
const IS_WIN = process.platform === "win32";
const posixOnly = IS_WIN ? { skip: "needs POSIX exec — the daemon execs /bin/sh (runs on Linux CI / real WSL2 guest)" } : {};

let daemon: ChildProcess;
let daemonPort = 0;

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

before(async () => {
  daemonPort = await freePort();
  daemon = spawn(process.execPath, [join(process.cwd(), "aws/microvm-agent/agent.mjs")], {
    env: { ...process.env, AGENT_PORT: String(daemonPort), AGENT_AUTH_TOKEN: AGENT_TOKEN },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${daemonPort}/health`)).status === 200) return;
    } catch {
      void 0;
    }
    if (Date.now() > deadline) throw new Error("test daemon never became reachable");
    await sleep(100);
  }
});

after(() => {
  daemon?.kill("SIGKILL");
});

function makeSandbox(fake: FakeWsl) {
  const dir = mkdtempSync(join(tmpdir(), "wsl2-ws-"));
  return createWsl2Sandbox(createLocalWorkspaceStore(dir), {
    agentToken: AGENT_TOKEN,
    wsl: fake.wslExec,
    agentPortForTest: daemonPort,
  });
}

const rw = (scopeId: string) => [{ scopeId, mountPath: "", mode: "rw" as const }];

test("profile declares the wsl2 substrate honestly", () => {
  const sb = makeSandbox(installFakeWsl());
  assert.equal(sb.profile.backend, "wsl2");
  assert.equal(sb.profile.processSessions, true);
  assert.equal(sb.profile.egressEnforcement, "domain");
  assert.equal(supportsProcessSessions(sb), true);
});

test("missing distro fails provision with the import hint", async () => {
  const fake = installFakeWsl();
  fake.distros.clear();
  await assert.rejects(makeSandbox(fake).provision(rw("personal:U0") as never), /rootfs not imported/);
});

test("wsl down fails provision with the enable hint", async () => {
  const fake = installFakeWsl();
  fake.wslDown = true;
  await assert.rejects(makeSandbox(fake).provision(rw("personal:U0") as never), /WSL2 is not enabled/);
});

test("agent is launched with the per-boot token through wsl", posixOnly, async () => {
  const fake = installFakeWsl();
  const sb = makeSandbox(fake);
  const h = await sb.provision(rw("personal:U0") as never);
  assert.ok(fake.agentLaunched);
  assert.equal(fake.agentLaunched!.token, AGENT_TOKEN);
  assert.ok(h.rootDir.endsWith("/workspace"));
});

test("file ops round-trip through the real agent daemon", posixOnly, async () => {
  const sb = makeSandbox(installFakeWsl());
  const h = await sb.provision(rw("personal:U0") as never);
  await sb.writeFile(h, "a.txt", "content");
  assert.equal(await sb.readFile(h, "a.txt"), "content");
  assert.equal(await sb.readFile(h, "missing.txt"), null);
});

test("run reaches the daemon with the token", posixOnly, async () => {
  const sb = makeSandbox(installFakeWsl());
  const h = await sb.provision(rw("personal:U0") as never);
  const r = await sb.run(h, "echo hello");
  assert.equal(r.code, 0);
  assert.match(r.stdout, /hello/);
});

test("destroy teardown removes the scope home; default teardown keeps it", posixOnly, async () => {
  const sb = makeSandbox(installFakeWsl());
  const h = await sb.provision(rw("personal:U0") as never);
  await sb.teardown(h);
  await sb.writeFile(h, "b.txt", "still here");
  assert.equal(await sb.readFile(h, "b.txt"), "still here");
  await sb.teardown(h, { destroy: true });
  assert.equal(await sb.readFile(h, "b.txt"), null);
});
