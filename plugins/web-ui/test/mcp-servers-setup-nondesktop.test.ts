import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

const SECRET = "mcp-servers-setup-nondesktop-test-secret";
process.env.CORE_API_URL = "http://127.0.0.1:1";
process.env.CORE_SIGNING_SECRET = SECRET;
process.env.WEB_UI_PRINCIPALS = "alice";
delete process.env.MEERKAT_DESKTOP;

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;

test.after(() => surface.close());

const authed = () => ({ [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, SECRET) });

test("mcp setup routes are desktop-only", async () => {
  const get = await fetch(`${base}/api/setup/mcp-servers`, { headers: authed() });
  assert.equal(get.status, 404);
  const put = await fetch(`${base}/api/setup/mcp-servers/memory`, { method: "PUT", headers: { ...authed(), "content-type": "application/json" }, body: "{}" });
  assert.equal(put.status, 404);
  const del = await fetch(`${base}/api/setup/mcp-servers/memory`, { method: "DELETE", headers: authed() });
  assert.equal(del.status, 404);
});
