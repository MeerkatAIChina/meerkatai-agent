import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer, connect, type AddressInfo, type Socket } from "node:net";
import { join } from "node:path";
import { sleep } from "../src/util/async.ts";
import { egressAllowed } from "../deploy/layers/meerkat/desktop/rootfs/egress-proxy.mjs";


let daemon: ChildProcess;
let port = 0;

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as AddressInfo).port;
      s.close(() => res(p));
    });
  });
}

function connectTo(proxyPort: number, host: string, targetPort: number): Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    const sock: Socket = connect(proxyPort, "127.0.0.1", () => {
      sock.write(`CONNECT ${host}:${targetPort} HTTP/1.1\r\nHost: ${host}:${targetPort}\r\n\r\n`);
    });
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      const m = buf.match(/^HTTP\/1\.1 (\d{3})/);
      if (m) {
        sock.destroy();
        resolve({ statusCode: Number(m[1]) });
      }
    });
    sock.on("error", reject);
    setTimeout(() => reject(new Error("connect timeout")), 5000);
  });
}

function rawGet(proxyPort: number): Promise<{ statusCode: number }> {
  return new Promise((resolve, reject) => {
    const sock = connect(proxyPort, "127.0.0.1", () => {
      sock.write("GET http://pypi.org/simple/ HTTP/1.1\r\nHost: pypi.org\r\n\r\n");
    });
    let buf = "";
    sock.on("data", (d) => {
      buf += d.toString("latin1");
      const m = buf.match(/^HTTP\/1\.1 (\d{3})/);
      if (m) {
        sock.destroy();
        resolve({ statusCode: Number(m[1]) });
      }
    });
    sock.on("error", reject);
    setTimeout(() => reject(new Error("get timeout")), 5000);
  });
}

before(async () => {
  port = await freePort();
  daemon = spawn(
    process.execPath,
    [join(process.cwd(), "deploy/layers/meerkat/desktop/rootfs/egress-proxy.mjs")],
    {
      env: { ...process.env, EGRESS_PORT: String(port), EGRESS_ALLOW: "pypi.org,localhost" },
      stdio: "ignore",
    },
  );
  const deadline = Date.now() + 10_000;
  for (;;) {
    const up = await new Promise<boolean>((res) => {
      const s = connect(port, "127.0.0.1", () => {
        s.destroy();
        res(true);
      });
      s.on("error", () => res(false));
    });
    if (up) return;
    if (Date.now() > deadline) throw new Error("egress proxy never became reachable");
    await sleep(100);
  }
});

after(() => {
  daemon?.kill("SIGKILL");
});

test("CONNECT to an allowlisted domain is tunneled", async () => {
  const upstream = createHttpServer((req, res) => {
    res.writeHead(200);
    res.end("ok");
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const upstreamPort = (upstream.address() as AddressInfo).port;
  const res = await connectTo(port, "localhost", upstreamPort);
  assert.equal(res.statusCode, 200);
  upstream.close();
});

test("CONNECT to a non-allowlisted domain gets 403", async () => {
  const res = await connectTo(port, "evil.com", 443);
  assert.equal(res.statusCode, 403);
});

test("allowlist matching is exact plus suffix, never substring", () => {
  assert.equal(egressAllowed("pypi.org", ["pypi.org"]), true);
  assert.equal(egressAllowed("cdn.pypi.org", ["pypi.org"]), true);
  assert.equal(egressAllowed("pypi.org.evil.com", ["pypi.org"]), false);
  assert.equal(egressAllowed("notpypi.org", ["pypi.org"]), false);
  assert.equal(egressAllowed("PYPI.ORG", ["pypi.org"]), true);
});

test("plain http (non-CONNECT) gets 403", async () => {
  const res = await rawGet(port);
  assert.equal(res.statusCode, 403);
});
