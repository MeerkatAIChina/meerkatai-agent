import { test } from "node:test";
import assert from "node:assert/strict";
import { createSensitivityClassifier, parseSensitivityVerdict } from "../src/security/sensitivity-classifier.ts";

test("parseSensitivityVerdict parses full L1 verdict with route", () => {
  const json = JSON.stringify({
    level: "L1",
    domain: "triz",
    route: { policy: "local-secure", model: "meerkat-triz-v1", harness_id: "pi", session_pin: true },
  });
  const result = parseSensitivityVerdict(json);
  assert.deepStrictEqual(result, {
    level: "L1",
    domain: "triz",
    route: { policy: "local-secure", model: "meerkat-triz-v1", harnessId: "pi", sessionPin: true },
  });
});

test("parseSensitivityVerdict parses L3+general with no route", () => {
  const result = parseSensitivityVerdict(JSON.stringify({ level: "L3", domain: "general" }));
  assert.deepStrictEqual(result, { level: "L3", domain: "general" });
});

test("parseSensitivityVerdict rejects invalid level", () => {
  assert.strictEqual(parseSensitivityVerdict(JSON.stringify({ level: "L4", domain: "general" })), null);
});

test("parseSensitivityVerdict rejects route missing harness_id", () => {
  const json = JSON.stringify({
    level: "L1",
    domain: "triz",
    route: { policy: "x", model: "x", session_pin: false },
  });
  assert.strictEqual(parseSensitivityVerdict(json), null);
});

test("parseSensitivityVerdict rejects non-JSON", () => {
  assert.strictEqual(parseSensitivityVerdict("not json"), null);
});

test("createSensitivityClassifier returns parsed verdict on 200", async () => {
  const mockFetch = async (_url: string | URL | Request, _opts?: RequestInit) =>
    new Response(
      JSON.stringify({
        level: "L1",
        domain: "triz",
        route: { policy: "local-secure", model: "m", harness_id: "pi", session_pin: true },
      }),
      { status: 200 },
    );
  const classify = createSensitivityClassifier({
    url: "http://localhost",
    timeoutMs: 2000,
    fetch: mockFetch as typeof fetch,
  });
  const result = await classify({ text: "test", scopeId: "s", orgScopeId: "o", hook: "user_input" });
  assert.strictEqual(result?.level, "L1");
  assert.strictEqual(result?.route?.policy, "local-secure");
});

test("createSensitivityClassifier returns null on connection refused", async () => {
  const mockFetch = async () => {
    throw new Error("connect ECONNREFUSED");
  };
  const classify = createSensitivityClassifier({
    url: "http://localhost",
    timeoutMs: 2000,
    fetch: mockFetch as typeof fetch,
  });
  const result = await classify({ text: "test", scopeId: "s", orgScopeId: "o", hook: "user_input" });
  assert.strictEqual(result, null);
});

test("createSensitivityClassifier returns null on 500", async () => {
  const mockFetch = async () => new Response("error", { status: 500 });
  const classify = createSensitivityClassifier({
    url: "http://localhost",
    timeoutMs: 2000,
    fetch: mockFetch as typeof fetch,
  });
  const result = await classify({ text: "test", scopeId: "s", orgScopeId: "o", hook: "user_input" });
  assert.strictEqual(result, null);
});
