import "./support/auto-fake-sprites.ts";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { scopeId, type TurnRequest } from "../src/types.ts";
import { testConfig } from "./support/test-config.ts";
import type { Config } from "../src/config.ts";

function dm(text: string): TurnRequest {
  return {
    surface: "test",
    actor: { externalId: "U1" },
    conversation: { kind: "dm", threadRef: "dm:U1:t1" },
    text,
  };
}

function freshApp(overrides: Partial<Config> = {}): BuiltApp {
  return buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "ap-")), ...overrides }));
}

async function fakeClassifier(responder: () => unknown): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(responder()));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

async function refusedUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  return `http://127.0.0.1:${port}`;
}

test("classifier route overrides the turn runtime and is audited", async () => {
  const sidecar = await fakeClassifier(() => ({
    level: "L1",
    domain: "general",
    route: { policy: "l1-local", model: "claude-sonnet-5", harness_id: "mock", session_pin: false },
  }));
  try {
    const built = freshApp({ classifierUrl: sidecar.url });
    const res = await built.app.turn(dm("hello there"));
    assert.equal(res.status, "ok", res.reason);

    const events = await built.auditLog.events();
    const route = events.find((e) => e.action === "classifier.route");
    assert.ok(route, "expected a classifier.route audit event");
    assert.equal(route.resource, "l1-local");
    const detail = JSON.parse(route.detail ?? "{}");
    assert.equal(detail.level, "L1");
    assert.equal(detail.model, "claude-sonnet-5");
    assert.equal(detail.harnessId, "mock");
    assert.equal(detail.sessionPin, false);
    assert.equal(
      built.config.getRuntimeSelection(scopeId("personal", "U1")),
      null,
      "session_pin false leaves the scope selection untouched",
    );
  } finally {
    await sidecar.close();
  }
});

test("unreachable classifier falls back to the configured local runtime and pins the scope", async () => {
  const built = freshApp({
    classifierUrl: await refusedUrl(),
    classifierFallbackModel: "claude-opus-4-8",
    classifierFallbackHarness: "mock",
  });
  const res = await built.app.turn(dm("hello there"));
  assert.equal(res.status, "ok", res.reason);

  const events = await built.auditLog.events();
  assert.ok(
    events.some((e) => e.action === "classifier.unavailable" && e.status === "fallback"),
    "expected a classifier.unavailable audit event",
  );
  const route = events.find((e) => e.action === "classifier.route");
  assert.ok(route, "the fallback verdict still routes the turn");
  assert.equal(route.resource, "fallback");

  const selection = built.config.getRuntimeSelection(scopeId("personal", "U1"));
  assert.equal(selection?.harnessId, "mock");
  assert.equal(selection?.modelId, "claude-opus-4-8");
});

test("without a fallback pair an unreachable classifier just skips routing", async () => {
  const built = freshApp({ classifierUrl: await refusedUrl() });
  const res = await built.app.turn(dm("hello there"));
  assert.equal(res.status, "ok", res.reason);
  assert.match(res.reply ?? "", /You said: hello there/);

  const events = await built.auditLog.events();
  assert.ok(!events.some((e) => e.action === "classifier.route"), "no routing without a fallback pair");
});

test("no classifier configured skips classification entirely", async () => {
  const built = freshApp();
  const res = await built.app.turn(dm("hello there"));
  assert.equal(res.status, "ok", res.reason);

  const events = await built.auditLog.events();
  assert.ok(!events.some((e) => e.action.startsWith("classifier.")));
});
