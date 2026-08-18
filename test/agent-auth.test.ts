import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { sleep } from "../src/util/async.ts";

let daemon: ChildProcess;
let port = 0;
const TOKEN = "test-token-123";

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
  port = await freePort();
  daemon = spawn(process.execPath, [join(process.cwd(), "aws/microvm-agent/agent.mjs")], {
    env: { ...process.env, AGENT_PORT: String(port), AGENT_AUTH_TOKEN: TOKEN },
    stdio: "ignore",
  });
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${port}/health`)).status === 200) return;
    } catch {
      void 0;
    }
    if (Date.now() > deadline) throw new Error("agent never became reachable");
    await sleep(100);
  }
});

after(() => {
  daemon?.kill("SIGKILL");
});

test("health is reachable without a token", async () => {
  assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
});

test("exec without a token is rejected", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/exec`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cmd: "echo hi" }),
  });
  assert.equal(r.status, 401);
});

test("exec with the right token runs", async () => {
  const r = await fetch(`http://127.0.0.1:${port}/exec`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-token": TOKEN },
    body: JSON.stringify({ cmd: "echo hi" }),
  });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { stdout: string; code: number };
  if (process.platform === "win32") {
    assert.notEqual(body.code, 0);
  } else {
    assert.match(body.stdout, /hi/);
  }
});

const posixOnly = process.platform === "win32" ? { skip: "setpriv requires POSIX (runs on Linux CI / guest)" } : {};

test("AGENT_RUN_USER drops exec privileges", posixOnly, async () => {
  const p2 = await freePort();
  const d2 = spawn(process.execPath, [join(process.cwd(), "aws/microvm-agent/agent.mjs")], {
    env: { ...process.env, AGENT_PORT: String(p2), AGENT_RUN_USER: "nobody" },
    stdio: "ignore",
  });
  try {
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        if ((await fetch(`http://127.0.0.1:${p2}/health`)).status === 200) break;
      } catch {
        void 0;
      }
      if (Date.now() > deadline) throw new Error("run-user daemon never became reachable");
      await sleep(100);
    }
    const r = await fetch(`http://127.0.0.1:${p2}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "id -u" }),
    });
    const body = (await r.json()) as { stdout: string };
    assert.match(body.stdout.trim(), /^65534$/);
    const root = await fetch(`http://127.0.0.1:${p2}/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd: "id -u", root: true }),
    });
    const rootBody = (await root.json()) as { stdout: string };
    assert.match(rootBody.stdout.trim(), /^0$/);
  } finally {
    d2.kill("SIGKILL");
  }
});

test("without AGENT_RUN_USER exec stays root", posixOnly, async () => {
  const r = await fetch(`http://127.0.0.1:${port}/exec`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-agent-token": TOKEN },
    body: JSON.stringify({ cmd: "id -u" }),
  });
  const body = (await r.json()) as { stdout: string };
  assert.match(body.stdout.trim(), /^0$/);
});
