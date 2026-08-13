import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

test("GET /health returns 200 { ok: true } without any authentication", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "health-")) }));
  const server = createInsecureTestServer(built.app, {
    admin: built.admin,
    auditLog: built.auditLog,
    sessions: built.sessions,
    errors: built.errors,
  });
  server.listen(0);
  try {
    const base = `http://localhost:${(server.address() as AddressInfo).port}`;
    const res = await fetch(`${base}/health`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
