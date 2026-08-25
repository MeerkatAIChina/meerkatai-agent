import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const state: { providers: Record<string, unknown>[]; puts: Record<string, unknown>[] } = { providers: [], puts: [] };

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
    if (u.pathname === "/v1/admin/custom-providers" && req.method === "GET") return send(200, { providers: state.providers });
    const m = u.pathname.match(/^\/v1\/admin\/custom-providers\/([^/]+)$/);
    if (m && req.method === "PUT") {
      state.puts.push(body);
      state.providers = [...state.providers.filter((p) => p.id !== m[1]), { id: m[1] }];
      return send(200, { ok: true });
    }
    if (u.pathname.startsWith("/v1/admin/scopes/")) return send(200, { ok: true });
    send(404, { error: "not_found" });
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

const SECRET = "setup-register-test-secret";
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

const register = (body: Record<string, unknown>) =>
  fetch(`${base}/api/setup/register`, {
    method: "POST",
    headers: { ...authed(), "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("first boot still requires the service token", async () => {
  state.providers = [];
  const r = await register({ token: "" });
  assert.equal(r.status, 400);
});

test("revisit with a blank token keeps the stored key (apiKey stripped from the PUT)", async () => {
  state.providers = [{ id: "tensoris" }];
  const before = state.puts.length;
  const r = await register({ token: "" });
  assert.equal(r.status, 200);
  const forwarded = state.puts[state.puts.length - 1]!;
  assert.ok(state.puts.length > before);
  assert.equal("apiKey" in forwarded, false, "blank token means core keeps the stored key");
});

test("revisit with a fresh token forwards it", async () => {
  state.providers = [{ id: "tensoris" }];
  const r = await register({ token: "new-token" });
  assert.equal(r.status, 200);
  const forwarded = state.puts[state.puts.length - 1]!;
  assert.equal(forwarded.apiKey, "new-token");
});

test("setup defaults reports needsSetup for the page's first-boot copy", async () => {
  state.providers = [];
  const empty = await fetch(`${base}/api/setup/defaults`, { headers: authed() });
  assert.equal(((await empty.json()) as { needsSetup: boolean }).needsSetup, true);
  state.providers = [{ id: "tensoris" }];
  await new Promise((r) => setTimeout(r, 100));
  const filled = await fetch(`${base}/api/setup/defaults`, { headers: authed() });
  assert.equal(((await filled.json()) as { needsSetup: boolean }).needsSetup, false);
});
