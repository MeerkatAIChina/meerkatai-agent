import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const state: { servers: Record<string, unknown>[]; puts: Record<string, unknown>[]; deletes: string[] } = {
  servers: [],
  puts: [],
  deletes: [],
};

const core = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const u = new URL(req.url ?? "/", "http://core");
    const send = (status: number, obj: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(obj));
    };
    if (u.pathname === "/v1/admin/whoami") return send(200, { isAdmin: true });
    if (u.pathname === "/v1/admin/mcp-servers" && req.method === "GET") {
      return send(200, {
        servers: state.servers,
        tools: [{ name: "memory_recall", serverId: "memory", description: "recall", readOnly: true }],
      });
    }
    const m = u.pathname.match(/^\/v1\/admin\/mcp-servers\/([^/]+)$/);
    if (m && req.method === "PUT") {
      state.puts.push(body);
      if (body.url === "https://down.example.com/mcp") {
        return send(400, { error: "unreachable", message: `tools/list against down.example.com failed: connect ECONNREFUSED` });
      }
      const server = {
        id: m[1],
        name: body.name ?? m[1],
        url: body.url,
        auth: body.auth ?? "none",
        ...(body.headerName ? { headerName: body.headerName } : {}),
        hasBearerToken: false,
        hasClientSecret: false,
        hasHeaderValue: typeof body.headerValue === "string" && body.headerValue.length > 0,
        readOnly: body.readOnly !== false,
        enabled: body.enabled !== false,
      };
      state.servers = [...state.servers.filter((s) => s.id !== server.id), server];
      return send(200, { ok: true, server, tools: ["recall"] });
    }
    if (m && req.method === "DELETE") {
      state.deletes.push(m[1]!);
      state.servers = state.servers.filter((s) => s.id !== m[1]);
      return send(200, { ok: true });
    }
    send(404, { error: "not_found" });
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

const SECRET = "mcp-servers-setup-test-secret";
process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "alice";
process.env.MEERKAT_DESKTOP = "1";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => {
  surface.close();
  core.close();
});

const authed = () => ({ [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, SECRET) });

test("GET forwards the redacted server list and tool snapshot", async () => {
  state.servers = [
    { id: "memory", name: "Memory", url: "https://mcp.example.com/mcp", auth: "header", headerName: "X-Custom-Key", hasHeaderValue: true, readOnly: true, enabled: true },
  ];
  const r = await fetch(`${base}/api/setup/mcp-servers`, { headers: authed() });
  assert.equal(r.status, 200);
  const body = (await r.json()) as { servers: Array<Record<string, unknown>>; tools: unknown[] };
  assert.equal(body.servers[0]!.hasHeaderValue, true);
  assert.equal(body.servers[0]!.headerName, "X-Custom-Key");
  assert.equal("headerValue" in body.servers[0]!, false, "secret key must never appear in the forwarded body");
  assert.equal(body.tools.length, 1);
});

test("PUT strips blank secret fields before forwarding and defaults validate on", async () => {
  const r = await fetch(`${base}/api/setup/mcp-servers/memory`, {
    method: "PUT",
    headers: { ...authed(), "content-type": "application/json" },
    body: JSON.stringify({ name: "Memory", url: "https://mcp.example.com/mcp", auth: "header", headerName: "X-Custom-Key", headerValue: "", bearerToken: "" }),
  });
  assert.equal(r.status, 200);
  const forwarded = state.puts[state.puts.length - 1]!;
  assert.equal("headerValue" in forwarded, false, "blank headerValue stripped, core keeps the stored secret");
  assert.equal("bearerToken" in forwarded, false);
  assert.equal(forwarded.validate, undefined, "validate defaults to core's probe-on behavior");
});

test("core 400 passes its message through unchanged", async () => {
  const r = await fetch(`${base}/api/setup/mcp-servers/memory`, {
    method: "PUT",
    headers: { ...authed(), "content-type": "application/json" },
    body: JSON.stringify({ name: "Memory", url: "https://down.example.com/mcp", auth: "none" }),
  });
  assert.equal(r.status, 400);
  const body = (await r.json()) as { error: string; message: string };
  assert.equal(body.error, "unreachable");
  assert.match(body.message, /tools\/list against down\.example\.com failed/);
});

test("DELETE forwards to core", async () => {
  const r = await fetch(`${base}/api/setup/mcp-servers/memory`, { method: "DELETE", headers: authed() });
  assert.equal(r.status, 200);
  assert.deepEqual(state.deletes, ["memory"]);
});
