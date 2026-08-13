import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, afterEach } from "node:test";
import { createInsecureTestServer } from "../src/api/server.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";

const ADMIN = { "content-type": "application/json", "x-admin-actor": "admin-alice@default-org" };
const USER = { "content-type": "application/json", "x-admin-actor": "bob@default-org" };
const ORG_SCOPE = "org:default-org";

const GATEWAY = {
  id: "acme-gateway",
  name: "Acme Gateway",
  protocol: "openai" as const,
  baseUrl: "https://llm.acme.internal/v1",
  models: [{ id: "acme-large" }],
};

afterEach(() => setCustomProviders([]));

function start(): { base: string; built: BuiltApp; close: () => Promise<void> } {
  const built = buildApp(
    testConfig({ dataDir: mkdtempSync(join(tmpdir(), "session-locks-route-")), seedSkills: false }),
  );
  const server = createInsecureTestServer(built.app, {
    config: built.config,
    harnessId: "pi",
    providerKeys: { anthropic: true, openai: false, openrouter: false },
    admin: built.admin,
    sessions: built.sessions,
    sessionLockStore: built.sessionLockStore,
    auditLog: built.auditLog,
  });
  server.listen(0);
  return {
    base: `http://localhost:${(server.address() as AddressInfo).port}`,
    built,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("session lock admin lifecycle: list, retarget, release — admin only", async () => {
  const srv = start();
  try {
    await srv.built.customProviders.upsert(GATEWAY, "sk-acme-secret", "admin-alice");
    await srv.built.refreshCustomProviders();
    const session = await srv.built.sessions.getOrCreateByThread("t-lock", "dm", "personal:U1" as never);
    await srv.built.sessionLockStore.put(session.id, { harnessId: "pi", modelId: "meerkat-triz-v1" });

    const denied = await fetch(`${srv.base}/v1/admin/session-locks?scope=${ORG_SCOPE}`, { headers: USER });
    assert.equal(denied.status, 403);

    const list = await fetch(`${srv.base}/v1/admin/session-locks?scope=${ORG_SCOPE}`, { headers: ADMIN });
    assert.equal(list.status, 200);
    const listBody = (await list.json()) as { locks: Array<{ sessionId: string; modelId: string }> };
    assert.deepEqual(
      listBody.locks.map((l) => [l.sessionId, l.modelId]),
      [[session.id, "meerkat-triz-v1"]],
    );

    const badRetarget = await fetch(`${srv.base}/v1/admin/sessions/${session.id}/lock?scope=${ORG_SCOPE}`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ harnessId: "pi", modelId: "no-such-model" }),
    });
    assert.equal(badRetarget.status, 400);

    const retarget = await fetch(`${srv.base}/v1/admin/sessions/${session.id}/lock?scope=${ORG_SCOPE}`, {
      method: "PUT",
      headers: ADMIN,
      body: JSON.stringify({ harnessId: "pi", modelId: "acme-large" }),
    });
    assert.equal(retarget.status, 200);
    assert.deepEqual(await srv.built.sessionLockStore.get(session.id), { harnessId: "pi", modelId: "acme-large" });

    const release = await fetch(`${srv.base}/v1/admin/sessions/${session.id}/lock?scope=${ORG_SCOPE}`, {
      method: "DELETE",
      headers: ADMIN,
    });
    assert.equal(release.status, 200);
    assert.equal(await srv.built.sessionLockStore.get(session.id), null);

    const releaseAgain = await fetch(`${srv.base}/v1/admin/sessions/${session.id}/lock?scope=${ORG_SCOPE}`, {
      method: "DELETE",
      headers: ADMIN,
    });
    assert.equal(releaseAgain.status, 404);

    const empty = await fetch(`${srv.base}/v1/admin/session-locks?scope=${ORG_SCOPE}`, { headers: ADMIN });
    assert.deepEqual(((await empty.json()) as { locks: unknown[] }).locks, []);
  } finally {
    await srv.built.runtime.stop();
    await srv.close();
  }
});
