import { test } from "node:test";
import assert from "node:assert/strict";
import { createNoneSandbox } from "../src/sandbox/none-sandbox.ts";
import { loadConfig } from "../src/config.ts";

const rw = [{ scopeId: "personal:U0", mountPath: "", mode: "rw" as const }];

test("none backend rejects provision with a clear actionable error", async () => {
  const sb = createNoneSandbox();
  await assert.rejects(sb.provision(rw as never), /SANDBOX_BACKEND=none/);
});

test("none backend declares an honest empty profile", () => {
  const sb = createNoneSandbox();
  assert.equal(sb.profile.backend, "none");
  assert.equal(sb.profile.processSessions, false);
});

test("none backend rejects every operation with the same error", async () => {
  const sb = createNoneSandbox();
  await assert.rejects(sb.run({ id: "x", rootDir: "/x" }, "true"), /SANDBOX_BACKEND=none/);
  await assert.rejects(sb.listDir({ id: "x", rootDir: "/x" }, "."), /SANDBOX_BACKEND=none/);
});

test("SANDBOX_BACKEND accepts none", () => {
  assert.equal(loadConfig({ SANDBOX_BACKEND: "none" }).sandboxBackend, "none");
});

test("SANDBOX_BACKEND rejects unknown values with the full enum in the message", () => {
  assert.throws(() => loadConfig({ SANDBOX_BACKEND: "docker" }), /aws, local, sprites, wsl2, or none/);
});
